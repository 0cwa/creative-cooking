import {resolveActivatedPolicyAuthority,resolveInstalledSetAuthority,resolveRuntimeAuthority,authorityBytes,snapshotId} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {observeSelectedSourceSet} from '../projection/selected-sources.mjs';
import {buildPolicyProvenanceReceipt} from './build-policy-provenance-receipt.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {installedDocumentSetContent} from '../pairing/household-document-set.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {localProvider} from './local-provider.mjs';
import {installedRecipeDelivery} from './installed-recipe-delivery.mjs';
import {preparePolicyDocumentKeys} from './prepare-policy-document-keys.mjs';
import {readVerifiedPolicyDocumentSet} from './stage-policy-document-set.mjs';
import {readVerifiedActivatedPolicyDocumentSet} from './read-activated-policy-document-set.mjs';
import {readRecipeCatalog} from './selected-recipe-catalog.mjs';
import {selectedOwnDeviceSet} from '../pairing/household-own-device-set.mjs';

const policyReaders=new WeakMap();
const policyMounts=new WeakMap();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Prepare wrapped keys for a staged policy successor; does not activate it. */
export async function prepareWorkspacePolicyDocumentKeys(runtime,targetHead,keys) {
 const reader=policyReaders.get(runtime);
 if(!reader)throw Error('INVALID_SOURCE_READER');
 return preparePolicyDocumentKeys({runtime,targetHead,keys,withSourceDocumentKey:reader});
}

/** Activate one explicitly confirmed staged successor from a mounted source. */
export async function activateStagedPolicyDocumentSet({runtime,expectedSourceHead,expectedSourceRevision,targetHead,service,sodium,keys}) {
 const mount=policyMounts.get(runtime);
 if(!mount || mount.activated || mount.paired || keys!==mount.keys)throw Error('INVALID_SOURCE_READER');
 if(typeof expectedSourceHead!=='string' || !expectedSourceHead || !Number.isSafeInteger(expectedSourceRevision) || expectedSourceRevision<0 || typeof targetHead!=='string' || !targetHead)throw Error('INVALID_CONFIRMATION');
 const recover=async (next)=>{
  try {
   if(runtime.storage!==mount.storage || runtime.authority!==mount.authority || mount.authority.rootPin!==mount.pin || mount.authority.provider!==mount.provider || !same(runtime.scope,mount.scope) || runtime.keyRef!==mount.scope.epochId || expectedSourceHead!==mount.scope.branchHead || expectedSourceRevision!==mount.expected.record.revision) return null;
   const opened=await readVerifiedActivatedPolicyDocumentSet({storage:mount.storage,LoroDoc:mount.LoroDoc,pin:mount.pin,provider:mount.provider,scope:mount.expected.scope,deviceId:mount.scope.authorDevice,targetHead,keys:mount.keys,sodium:mount.sodium});
   const prior=opened.expected, selected=mount.expected.record;
   if(!opened.verifiedProvenance || prior.acceptedParent!==selected.acceptedParent || prior.revision!==selected.revision || prior.authorizationSnapshot!==selected.authorizationSnapshot || !same(prior.scope,mount.expected.scope) || (mount.record && !same(prior,mount.record)) || (next && !same(opened.record,next))) return null;
   return {targetHead,record:opened.record};
  } catch {return null;}
 };
 const current=await runtime.storage.readPairingAuthority({kind:'household',id:runtime.scope.scopeId});
 if(!current.ok)throw Error(current.error.code);
 if(!current.value || current.value.acceptedParent!==expectedSourceHead || current.value.revision!==expectedSourceRevision) {
  const recovered=await recover(); if(recovered)return recovered;
  throw Error('STALE_SOURCE');
 }
 const verified=await readVerifiedPolicyDocumentSet({runtime,targetHead});
 const expected=verified.current;
 if(expected.acceptedParent!==expectedSourceHead || expected.revision!==expectedSourceRevision || runtime.scope.branchHead!==expectedSourceHead)throw Error('STALE_SOURCE');
 const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(expected.authorityState));
 if(state.events.some(item=>item.event?.version===6 || (item.event?.version===5 && item.event?.kind==='pairOwnDevice')))throw Error('UNSUPPORTED_SOURCE');
 const signer=verified.parent.devices.find(d=>d.active && d.deviceId===runtime.scope.authorDevice);
 if(!signer || mount.signing.publicKey!==signer.signingKeyRef)throw Error('INVALID_SIGNER');
 const captured=await observeSelectedSourceSet(runtime,{verifyCheckpointHistory:true});
 const prepared=await prepareWorkspacePolicyDocumentKeys(runtime,targetHead,keys);
 const selection={from:expectedSourceHead,to:targetHead,deviceId:runtime.scope.authorDevice,index:state.selections.length};
 const statement=domain('select-head',{root:runtime.authority.rootPin,householdId:runtime.scope.scopeId,...selection});
 const signature=await localProvider(sodium,keys,{signing:mount.signing,content:{}}).sign(signer.signingKeyRef,statement);
 if(!(signature instanceof Uint8Array) || signature.length!==64 || !await runtime.authority.provider.verify(signer.signingKeyRef,statement,signature))throw Error('INVALID_SIGNER');
 selection.signature=Array.from(signature,x=>x.toString(16).padStart(2,'0')).join('');
 const nextState=structuredClone(state); nextState.events.push(verified.item); nextState.selections.push(selection); nextState.activeHead=targetHead;
 const next={...expected,revision:expected.revision+1,acceptedParent:targetHead,authorizationSnapshot:await snapshotId(runtime.authority.provider,nextState),authorityState:authorityBytes(nextState)};
 const provenance=await buildPolicyProvenanceReceipt({runtime,targetHead,service,sodium,guard:captured.guard,next});
 let result;
 try {
  result=await runtime.storage.commitPolicyDocumentSetSelection({guard:captured.guard,targetHead,proof:verified.stage.proof,mapping:verified.stage.mapping,expected,next,deviceId:runtime.scope.authorDevice,prepared,provenance});
  if(!result.ok)throw Error(result.error.code);
 } catch(error) {
  const recovered=await recover(next); if(recovered)return recovered;
  throw error;
 }
 return {targetHead,record:next};
}

// The original workspace has its own initialized sequence allocator. Joined
// workspaces must use the separate, receipt-gated allocator instead.
export async function resolveOriginalHousehold({storage,scope,pin,provider,deviceId,sodium,LoroDoc,
 paired=/** @type {{keys:any;useWrapping?:(use:(secret:Uint8Array)=>Promise<any>)=>Promise<any>}|undefined} */(undefined)}) {
 scope=structuredClone(scope);
 try {
  return {resolved:await resolveRuntimeAuthority(storage,scope,pin,provider,deviceId),installedSet:null};
 }catch(error){
  if(error?.message!=='UNSUPPORTED_VERSION')throw error;
  // The untrusted event only locates the retained receipt. The paired opener
  // verifies the signed transition, selected head, receipt and local keys.
  const raw=await storage.readPairingAuthority(scope);
  if(!raw.ok||!raw.value)throw error;
  let state;
  try{state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.value.authorityState));}
  catch{throw error;}
  // The record and its events only locate a candidate; the retained activation
  // verifier authenticates the selection and all document keys independently.
  const targetHead=raw.value.acceptedParent;
  const retained=await storage.readActivatedPolicyDocumentSet(scope.id,targetHead);
  if(!retained.ok)throw Error(retained.error.code);
  let selectedV6=false;
  for(const item of state.events??[]){
   if(item.event?.version!==6 || item.event?.kind!=='changePolicy')continue;
   const hash=await provider.hash(domain('event',item.event));
   if(hash instanceof Uint8Array && Array.from(hash,x=>x.toString(16).padStart(2,'0')).join('')===targetHead)selectedV6=true;
  }
  if(retained.value || selectedV6){
   if(!paired?.keys)throw Error('INVALID_AUTHORITY');
   const activatedPolicy={targetHead};
   const resolved=await resolveActivatedPolicyAuthority({storage,scope,pin,provider,authorDevice:deviceId,LoroDoc,targetHead,keys:paired.keys});
   return {resolved,installedSet:null,activatedPolicy};
  }
  const pairedOperation=await selectedOwnDeviceSet(raw.value,state,provider);
  if(pairedOperation){
   if(!paired)throw error;
   const installedSet={operationId:pairedOperation,paired};
   const resolved=await resolveInstalledSetAuthority({storage,scope,pin,provider,authorDevice:deviceId,sodium,LoroDoc,...installedSet});
   return {resolved,installedSet};
  }
  const {record,state:verified}=await verifyPublicParent(storage,scope,pin,provider);
  const selected=verified.events.find(item=>item.admission?.manifest?.version===5&&
   item.admission.grant.admissionEventHash===record.acceptedParent);
  if(!selected)throw error;
  const installedSet={operationId:selected.admission.operationId};
  const resolved=await resolveInstalledSetAuthority({storage,scope,pin,provider,authorDevice:deviceId,sodium,LoroDoc,...installedSet});
  return {resolved,installedSet};
 }
}

export async function openWorkspaceHouseholdRuntime({storage,resolved,installedSet,activatedPolicy=/** @type {any} */(undefined),pin,provider,sodium,keys,signing,
 wrapping=/** @type {any} */(undefined),LoroDoc,decodeImportBlobMeta}) {
 resolved=structuredClone(resolved);
 if(activatedPolicy && (installedSet || activatedPolicy.targetHead!==resolved.scope.branchHead))throw Error('INVALID_AUTHORITY_CONFIG');
 if(activatedPolicy){
  const verified=await resolveActivatedPolicyAuthority({storage,scope:{kind:'household',id:resolved.scope.scopeId},pin,provider,authorDevice:resolved.scope.authorDevice,LoroDoc,targetHead:activatedPolicy.targetHead,keys});
  if(!same(verified,resolved))throw Error('INVALID_AUTHORITY');
 }
 const {scope}=resolved,householdScope={kind:'household',id:scope.scopeId};
 const installation=installedSet?{...installedSet,sodium,LoroDoc}:null;
 const paired=installation?.paired;
 const members=new Map((paired?resolved.pairedDocuments:[]).map(document=>[document.documentId,document]));
 const policyMembers=new Map((activatedPolicy?resolved.members:[]).map(member=>[member.documentId,member]));
 const content=activatedPolicy ? async (epochId,fn,header)=>{
    const member=policyMembers.get(header?.documentId);
    if(!member||epochId!==scope.epochId||header.epochId!==scope.epochId||header.scopeId!==scope.scopeId||header.branchHead!==scope.branchHead||header.documentGeneration!==scope.documentGeneration||!scope.acceptedAuthors.includes(header.authorDevice)||member.identity.deviceId!==scope.authorDevice)throw Error('INVALID_AUTHORITY');
    const verify=async()=>{const current=await resolveActivatedPolicyAuthority({storage,scope:householdScope,pin,provider,authorDevice:scope.authorDevice,LoroDoc,targetHead:activatedPolicy.targetHead,keys});if(!same(current,resolved))throw Error('STALE_AUTHORITY')};
    await verify();
    const result=await keys.use(member.operationId,member.identity,fn);
    await verify();
    return result;
   } : paired
  ? (epochId,fn,header)=>{
    const member=members.get(header?.documentId);
    if(!member||epochId!==scope.epochId||header.epochId!==scope.epochId||
       header.scopeId!==scope.scopeId||header.branchHead!==scope.branchHead||
       header.documentGeneration!==scope.documentGeneration||!scope.acceptedAuthors.includes(header.authorDevice)||member.identity.deviceId!==scope.authorDevice)
     throw Error('INVALID_AUTHORITY');
    return paired.keys.use(member.keyOperationId,member.identity,fn);
   }
  : installation
  ? await installedDocumentSetContent({storage,scope:householdScope,pin,provider,...installation},keys)
  : (epochId,fn)=>keys.useIdentity({version:1,scope:householdScope,deviceId:scope.authorDevice,purpose:'data',epochId},fn);
 if(installation){
  for(const {documentId} of resolved.members)await content(scope.epochId,()=>{}, {...scope,documentId});
 }
 let deliveryContent;
 const deliveries=installation&&!paired&&wrapping?installedRecipeDelivery({sodium,keys,signing,wrapping,provider,pin,resolved,baselineContent:content,bindContent:use=>{deliveryContent=use;}}):null;
 const codec=deliveries?.codec??candidateCodec(localProvider(sodium,keys,{signing,content}));
 const runtime=new OfflineRuntime({storage,codec,LoroDoc,decodeImportBlobMeta,scope,keyRef:scope.epochId,
  authority:{kind:'household',rootPin:pin,provider,selectionIndex:resolved.selectionIndex,
   ...(activatedPolicy?{activatedPolicy:{targetHead:activatedPolicy.targetHead,keys,resolved:structuredClone(resolved)}}:{}),
   ...(installation?{installedSet:{...installation,recipeCatalog:deliveries?.recipeCatalog},recipeDelivery:deliveries}:{})}});
 if(installation||activatedPolicy)await runtime.authorize();
 const originalScope=structuredClone(scope), authority=runtime.authority;
 const useContent=deliveryContent??content;
 const mountedRecord=await storage.readPairingAuthority(householdScope);
 const record=mountedRecord.ok && mountedRecord.value && mountedRecord.value.revision===resolved.expectedAuthority?.record.revision && mountedRecord.value.acceptedParent===resolved.expectedAuthority?.record.acceptedParent && mountedRecord.value.authorizationSnapshot===resolved.expectedAuthority?.record.authorizationSnapshot ? structuredClone(mountedRecord.value) : null;
 policyMounts.set(runtime,{record,keys,signing:structuredClone(signing),activated:!!activatedPolicy,paired:!!paired,storage,authority,scope:originalScope,expected:structuredClone(resolved.expectedAuthority),pin,provider,LoroDoc,sodium});
 policyReaders.set(runtime,async (route,fn)=>{
  const check=()=>{
   if(runtime.authority!==authority || runtime.storage!==storage || authority.rootPin!==pin || authority.provider!==provider ||
      !same(runtime.scope,originalScope) || runtime.keyRef!==scope.epochId ||
      route.scopeId!==scope.scopeId || route.rootPin!==pin || route.sourceHead!==scope.branchHead ||
      route.epochId!==scope.epochId || route.generation!==scope.documentGeneration || route.deviceId!==scope.authorDevice)
    throw Error('INVALID_SOURCE_ROUTE');
  };
  check();
  const auth=await runtime.authorization();
  const verified=await readVerifiedPolicyDocumentSet({runtime,targetHead:route.targetHead});
  const row=verified.stage.mapping.find(entry=>entry.sourceDocumentId===route.sourceDocumentId && entry.targetDocumentId===route.targetDocumentId);
  if(!row)throw Error('INVALID_SOURCE_ROUTE');
  if(row.recipeId===null) {
   if(row.sourceDocumentId!==auth.sourceDocumentId)throw Error('INVALID_SOURCE_ROUTE');
  } else if(!auth.members?.some(member=>member.recipeId===row.recipeId && member.documentId===row.sourceDocumentId)) {
   const catalog=await readRecipeCatalog(runtime,auth,row.recipeId);
   if(catalog.children.get(row.recipeId)?.documentId!==row.sourceDocumentId)throw Error('INVALID_SOURCE_ROUTE');
  }
  check();
  if(!same(auth.expectedAuthority,await runtime.authorize()))throw Error('STALE_SOURCE');
  const result=await useContent(scope.epochId,fn,{...scope,documentId:row.sourceDocumentId});
  check();
  if(!same(auth.expectedAuthority,await runtime.authorize()))throw Error('STALE_SOURCE');
  return result;
 });
 return runtime;
}
