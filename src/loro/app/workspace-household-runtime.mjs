import {resolveAdultRemovalRuntimeAuthority,resolveDraftRotationRuntimeAuthority,resolveReturnedPolicyAuthority,resolveActivatedPolicyAuthority,resolveInstalledSetAuthority,resolveRuntimeAuthority,authorityBytes,snapshotId} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {verifyAuthority} from '../authority/chain.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {matchesDisclosureService} from '../disclosure/service.mjs';
import {readPolicyReturnPreflight} from './preflight-policy-return.mjs';
import {verifyPolicyReturnCandidate} from './verify-policy-return.mjs';
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
import {readVerifiedActivatedPolicyDocumentSet,readPolicyReturnActivationEvidence} from './read-activated-policy-document-set.mjs';
import {readRecipeCatalog} from './selected-recipe-catalog.mjs';
import {discoverSelectedAdultRemoval,discoverSelectedDraftRotation} from './adult-removal-discovery.mjs';
import {selectedOwnDeviceSet} from '../pairing/household-own-device-set.mjs';
import {unsupportedPolicySource} from '../authority/policy-document-set.mjs';

const policyReaders=new WeakMap();
const policyMounts=new WeakMap();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sameRemoval=(a,b)=>{const x=authorityBytes(a),y=authorityBytes(b);return x.length===y.length&&x.every((v,i)=>v===y[i])};

/** Bind the narrowly scoped policy branch operations to the selected workspace. */
export async function bindPolicyBranches({runtime,keys,service,sodium,withCurrent,eligible,activated}) {
 if(!eligible) return null;
 const mount=policyMounts.get(runtime);
 if(!mount || !mount.record || mount.paired || keys!==mount.keys) return null;
 const args={storage:mount.storage,LoroDoc:mount.LoroDoc,pin:mount.pin,provider:mount.provider,
  scope:mount.expected.scope,deviceId:mount.scope.authorDevice,targetHead:mount.scope.branchHead,keys,sodium};
 if(activated) {
  const evidence=await readPolicyReturnActivationEvidence(args);
  const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(evidence.expected.authorityState));
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(evidence.staged.proof))?.[2]?.signed?.body?.observation?.manifest;
  if(unsupportedPolicySource(state) || !evidence.verifiedProvenance || manifest?.version!==1 || manifest.parentHead!==evidence.sourceHead) return null;
  const reviewReturn=()=>withCurrent(async()=>{
   const verified=await readPolicyReturnActivationEvidence(args);
   return {sourceHead:verified.sourceHead,targetHead:verified.targetHead,targetRevision:verified.record.revision};
  });
  return {reviewReturn,returnToSource:input=>withCurrent(async()=>{
   if(input?.explicit!==true)throw Error('INVALID_CONFIRMATION');
   const result=await returnActivatedPolicyDocumentSet({runtime,keys,service,expectedSourceHead:input.expectedSourceHead,expectedTargetHead:input.expectedTargetHead,expectedTargetRevision:input.expectedTargetRevision});
   return {sourceHead:result.sourceHead};
  })};
 }
 const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(mount.record.authorityState));
 if(unsupportedPolicySource(state)) return null;
 return {reviewStaged:targetHead=>withCurrent(async()=>{
  const verified=await readVerifiedPolicyDocumentSet({runtime,targetHead});
  return {sourceHead:verified.current.acceptedParent,sourceRevision:verified.current.revision,targetHead:verified.targetHead};
 }),activate:input=>withCurrent(async()=>{
  if(input?.explicit!==true)throw Error('INVALID_CONFIRMATION');
  const result=await activateStagedPolicyDocumentSet({runtime,keys,service,sodium,expectedSourceHead:input.expectedSourceHead,expectedSourceRevision:input.expectedSourceRevision,targetHead:input.targetHead,requireReturnableSource:true});
  return {targetHead:result.targetHead};
 })};
}

/** Prepare wrapped keys for a staged policy successor; does not activate it. */
export async function prepareWorkspacePolicyDocumentKeys(runtime,targetHead,keys) {
 const reader=policyReaders.get(runtime);
 if(!reader)throw Error('INVALID_SOURCE_READER');
 return preparePolicyDocumentKeys({runtime,targetHead,keys,withSourceDocumentKey:reader});
}

/** Activate one explicitly confirmed staged successor from a mounted source. */
export async function activateStagedPolicyDocumentSet({runtime,expectedSourceHead,expectedSourceRevision,targetHead,service,sodium,keys,requireReturnableSource=false}) {
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
 if(unsupportedPolicySource(state,{allowAdmission:!requireReturnableSource}))throw Error('UNSUPPORTED_SOURCE');
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

/** Return only an explicitly confirmed, independently pinned ordinary source. */
export async function returnActivatedPolicyDocumentSet({runtime,expectedSourceHead,expectedTargetHead,expectedTargetRevision,service,keys}) {
 const mount=policyMounts.get(runtime);
 if(!mount || !mount.activated || mount.paired || keys!==mount.keys || runtime.storage!==mount.storage ||
   runtime.authority!==mount.authority || !same(runtime.scope,mount.scope) || runtime.keyRef!==mount.scope.epochId ||
   mount.authority.rootPin!==mount.pin || mount.authority.provider!==mount.provider ||
   expectedTargetHead!==mount.scope.branchHead || typeof expectedSourceHead!=='string' || !expectedSourceHead ||
   !Number.isSafeInteger(expectedTargetRevision) || expectedTargetRevision<0) throw Error('INVALID_CONFIRMATION');
 const scope=mount.expected.scope, deviceId=mount.scope.authorDevice;
 if(!matchesDisclosureService(service,{storage:mount.storage,scope,rootPin:mount.pin,provider:mount.provider,deviceId}))throw Error('INVALID_AUTHORITY');
 const args={storage:mount.storage,LoroDoc:mount.LoroDoc,pin:mount.pin,provider:mount.provider,scope,deviceId,targetHead:expectedTargetHead,keys,sodium:mount.sodium};
 if(mount.record?.revision!==expectedTargetRevision)throw Error('STALE_TARGET');
 const recover=async (next=undefined)=>{
  try {
   const current=await mount.storage.readPairingAuthority(scope);
   if(!current.ok || current.value?.acceptedParent!==expectedSourceHead ||
     current.value.revision!==expectedTargetRevision+1 || (next && !same(current.value,next)))return null;
   const {source,candidate}=await verifyPolicyReturnCandidate({...args,candidate:current.value,expectedActivation:mount.record});
   await keys.useIdentity({version:1,scope,deviceId,purpose:'data',epochId:source.epochId},()=>{});
   const again=await mount.storage.readPairingAuthority(scope);
   if(!again.ok || !same(again.value,candidate))return null;
   return {sourceHead:source.head,record:candidate};
  } catch {return null;}
 };
 let preflight;
 try {preflight=await readPolicyReturnPreflight({...args,expectedTargetHead,expectedTargetRevision});}
 catch(error){const recovered=await recover();if(recovered)return recovered;throw error;}
 const {activation,pointers}=preflight;
 if(!mount.record || !same(mount.record,activation.record))throw Error('STALE_TARGET');
 if(activation.sourceHead!==expectedSourceHead)throw Error('STALE_SOURCE');
 const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(activation.expected.authorityState));
 if(unsupportedPolicySource(state))throw Error('UNSUPPORTED_SOURCE');
 const verified=await verifyAuthority(state,mount.pin,mount.provider), parent=verified.nodes.get(expectedSourceHead);
 if(!parent || state.activeHead!==expectedSourceHead)throw Error('INVALID_AUTHORITY');
 const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(activation.staged.proof))?.[2]?.signed?.body?.observation?.manifest;
 if(manifest?.version!==1 || manifest.parentHead!==expectedSourceHead || manifest.epochId!==parent.epochId)throw Error('UNSUPPORTED_SOURCE');
 const claims=[manifest.root,...manifest.children], sourceDocuments=[];
 if(claims.length!==activation.staged.mapping.length)throw Error('INVALID_SOURCE');
 for(const [i,claim] of claims.entries()){
  const row=activation.staged.mapping[i];
  if(claim.documentId!==row.sourceDocumentId || (i===0?row.recipeId!==null:claim.recipeId!==row.recipeId))throw Error('INVALID_SOURCE');
  const result=await mount.storage.reopenDocument(scope.id,claim.documentId);
  if(!result.ok)throw Error(result.error.code);
  const doc=result.value;
  if(!doc){if(i!==0 || claim.revision!==null || claim.checkpointHash!==null)throw Error('INVALID_SOURCE');sourceDocuments.push({documentId:claim.documentId,document:null});continue;}
  const hash=await selectedSourceHash(mount.provider,'projection-source-snapshot',Array.from(doc.bytes,x=>x.toString(16).padStart(2,'0')).join(''));
  if(doc.revision!==claim.revision || hash!==claim.checkpointHash)throw Error('INVALID_SOURCE');
  sourceDocuments.push({documentId:claim.documentId,document:{bytes:doc.bytes,revision:doc.revision}});
 }
 await keys.useIdentity({version:1,scope,deviceId,purpose:'data',epochId:parent.epochId},()=>{});
 if(pointers.sourcePointer!==null) await service.validateStored(pointers.sourcePointer,{current:{state,activeHead:expectedSourceHead,revision:activation.expected.revision},verified});
 const signer=parent.devices.find(d=>d.active&&d.deviceId===deviceId);
 if(!signer || mount.signing.publicKey!==signer.signingKeyRef)throw Error('INVALID_SIGNER');
 const body={from:expectedTargetHead,to:expectedSourceHead,deviceId,index:activation.state.selections.length};
 const statement=domain('select-head',{root:mount.pin,householdId:scope.id,...body});
 const signature=await localProvider(mount.sodium,keys,{signing:mount.signing,content:{}}).sign(signer.signingKeyRef,statement);
 if(!(signature instanceof Uint8Array)||signature.length!==64||!await mount.provider.verify(signer.signingKeyRef,statement,signature))throw Error('INVALID_SIGNER');
 const selection={...body,signature:Array.from(signature,x=>x.toString(16).padStart(2,'0')).join('')};
 const nextState={...activation.state,selections:[...activation.state.selections,selection],activeHead:expectedSourceHead};
 const next={...activation.record,revision:activation.record.revision+1,acceptedParent:expectedSourceHead,authorizationSnapshot:await snapshotId(mount.provider,nextState),authorityState:authorityBytes(nextState)};
 await verifyPolicyReturnCandidate({...args,candidate:next});
 try {
  const result=await mount.storage.commitPolicyDocumentSetReturn({receipt:activation.receipt,staged:activation.staged,next,sourceDocuments,targetDocuments:activation.targetDocuments,...pointers});
  if(!result.ok)throw Error(result.error.code);
 } catch(error){const recovered=await recover(next);if(recovered)return recovered;throw error;}
 return {sourceHead:expectedSourceHead,record:next};
}

// The original workspace has its own initialized sequence allocator. Joined
// workspaces must use the separate, receipt-gated allocator instead.
export async function resolveOriginalHousehold({storage,scope,pin,provider,deviceId,sodium,LoroDoc,
 paired=/** @type {{keys:any;useWrapping?:(use:(secret:Uint8Array)=>Promise<any>)=>Promise<any>}|undefined} */(undefined)}) {
 scope=structuredClone(scope);
 // This untrusted bounded scan locates a candidate only; the receipt verifier
 // authenticates the pinned parent, local device, complete successor and keys.
 const initial=await storage.readPairingAuthority(scope);
 if(!initial.ok)throw Error(initial.error.code??initial.error);
 if(initial.value){
  const raw=initial.value;
  const draftCandidate=await discoverSelectedDraftRotation(raw,provider);
  if(draftCandidate){
   if(!paired?.keys)throw Error('INVALID_AUTHORITY');
   const {operationId,authorDeviceId}=draftCandidate,role=authorDeviceId===deviceId?'sponsor':'recipient';
   const draftRotation={operationId,role,withWrapping:paired.useWrapping};
   const resolved=await resolveDraftRotationRuntimeAuthority({storage,scope,pin,provider,authorDevice:deviceId,sodium,LoroDoc,keys:paired.keys,...draftRotation});
   const current=await storage.readPairingAuthority(scope);
   if(!current.ok||!sameRemoval(current.value,raw))throw Error('STALE_AUTHORITY');
   return {resolved,installedSet:null,draftRotation};
  }
  const candidate=await discoverSelectedAdultRemoval(raw,provider);
  if(candidate){
   if(!paired?.keys)throw Error('INVALID_AUTHORITY');
   const {operationId,authorDeviceId}=candidate,role=authorDeviceId===deviceId?'sponsor':'recipient';
   const adultRemoval={operationId,role,withWrapping:paired.useWrapping};
   const resolved=await resolveAdultRemovalRuntimeAuthority({storage,scope,pin,provider,authorDevice:deviceId,operationId,role,sodium,LoroDoc,keys:paired.keys,withWrapping:paired.useWrapping});
   const current=await storage.readPairingAuthority(scope);
   if(!current.ok||!sameRemoval(current.value,raw))throw Error('STALE_AUTHORITY');
   return {resolved,installedSet:null,adultRemoval};
  }
 }
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
  const last=state.selections?.at(-1);
  const returnedReceipt=last && last.to===targetHead && typeof last.from==='string' ? await storage.readActivatedPolicyDocumentSet(scope.id,last.from,true) : null;
  if(returnedReceipt && !returnedReceipt.ok)throw Error(returnedReceipt.error.code);
  if(returnedReceipt?.value){
   if(!paired?.keys)throw Error('INVALID_AUTHORITY');
   const returnedPolicy={targetHead:last.from};
   const resolved=await resolveReturnedPolicyAuthority({storage,scope,pin,provider,authorDevice:deviceId,LoroDoc,targetHead:last.from,keys:paired.keys,sodium});
   return {resolved,installedSet:null,returnedPolicy};
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

export async function openWorkspaceHouseholdRuntime({storage,resolved,installedSet,returnedPolicy=/** @type {any} */(undefined),activatedPolicy=/** @type {any} */(undefined),adultRemoval=/** @type {any} */(undefined),draftRotation=/** @type {any} */(undefined),pin,provider,sodium,keys,signing,
 wrapping=/** @type {any} */(undefined),LoroDoc,decodeImportBlobMeta}) {
 resolved=structuredClone(resolved);
 const rotation=adultRemoval??draftRotation;
 if(adultRemoval&&draftRotation||rotation&&(installedSet||returnedPolicy||activatedPolicy))throw Error('INVALID_AUTHORITY_CONFIG');
 const resolveRotation=draftRotation?resolveDraftRotationRuntimeAuthority:resolveAdultRemovalRuntimeAuthority;
 const rotationOptions=rotation?{operationId:rotation.operationId,role:rotation.role,sodium,keys,withWrapping:rotation.withWrapping}:null;
 if(rotationOptions){
  const verified=await resolveRotation({storage,scope:{kind:'household',id:resolved.scope.scopeId},pin,provider,authorDevice:resolved.scope.authorDevice,LoroDoc,...rotationOptions});
  if(!sameRemoval(verified,resolved))throw Error('INVALID_AUTHORITY');
 }
 if(returnedPolicy && (installedSet || activatedPolicy))throw Error('INVALID_AUTHORITY_CONFIG');
 if(activatedPolicy && (installedSet || activatedPolicy.targetHead!==resolved.scope.branchHead))throw Error('INVALID_AUTHORITY_CONFIG');
 if(activatedPolicy){
  const verified=await resolveActivatedPolicyAuthority({storage,scope:{kind:'household',id:resolved.scope.scopeId},pin,provider,authorDevice:resolved.scope.authorDevice,LoroDoc,targetHead:activatedPolicy.targetHead,keys});
  if(!same(verified,resolved))throw Error('INVALID_AUTHORITY');
 }
 if(returnedPolicy){
  const verified=await resolveReturnedPolicyAuthority({storage,scope:{kind:'household',id:resolved.scope.scopeId},pin,provider,authorDevice:resolved.scope.authorDevice,LoroDoc,targetHead:returnedPolicy.targetHead,keys,sodium});
  if(!same(verified,resolved))throw Error('INVALID_AUTHORITY');
 }
 const {scope}=resolved,householdScope={kind:'household',id:scope.scopeId};
 const installation=installedSet?{...installedSet,sodium,LoroDoc}:null;
 const paired=installation?.paired;
 const members=new Map((paired?resolved.pairedDocuments:[]).map(document=>[document.documentId,document]));
 const policyMembers=new Map((activatedPolicy?resolved.members:[]).map(member=>[member.documentId,member]));
 const rotationMembers=new Map((rotation?resolved.members:[]).map(member=>[member.documentId,member]));
 const content=rotation ? async (epochId,fn,header)=>{
    const member=rotationMembers.get(header?.documentId);
    if(!member||epochId!==scope.epochId||header.epochId!==scope.epochId||header.scopeId!==scope.scopeId||header.branchHead!==scope.branchHead||header.documentGeneration!==scope.documentGeneration||!scope.acceptedAuthors.includes(header.authorDevice)||member.keySlot.identity.deviceId!==scope.authorDevice)throw Error('INVALID_AUTHORITY');
    const verify=async()=>{const current=await resolveRotation({storage,scope:householdScope,pin,provider,authorDevice:scope.authorDevice,LoroDoc,...rotationOptions});if(!sameRemoval(current,resolved))throw Error('STALE_AUTHORITY')};
    await verify();const result=await keys.use(member.keySlot.operationId,member.keySlot.identity,fn);await verify();return result;
   } : returnedPolicy ? async (epochId,fn,header)=>{
    if(!resolved.members.some(member=>member.documentId===header?.documentId) || epochId!==scope.epochId || header.epochId!==scope.epochId || header.scopeId!==scope.scopeId || header.branchHead!==scope.branchHead || header.documentGeneration!==scope.documentGeneration || !scope.acceptedAuthors.includes(header.authorDevice))throw Error('INVALID_AUTHORITY');
    const verify=async()=>{const current=await resolveReturnedPolicyAuthority({storage,scope:householdScope,pin,provider,authorDevice:scope.authorDevice,LoroDoc,targetHead:returnedPolicy.targetHead,keys,sodium});if(!same(current,resolved))throw Error('STALE_AUTHORITY')};
    await verify();
    const result=await keys.useIdentity({version:1,scope:householdScope,deviceId:scope.authorDevice,purpose:'data',epochId},fn);
    await verify();
    return result;
   } : activatedPolicy ? async (epochId,fn,header)=>{
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
   ...(rotation?{[draftRotation?'draftRotation':'adultRemoval']:{options:rotationOptions,resolved:structuredClone(resolved)}}:{}),
   ...(returnedPolicy?{returnedPolicy:{targetHead:returnedPolicy.targetHead,keys,sodium,resolved:structuredClone(resolved)}}:{}),
   ...(activatedPolicy?{activatedPolicy:{targetHead:activatedPolicy.targetHead,keys,resolved:structuredClone(resolved)}}:{}),
   ...(installation?{installedSet:{...installation,recipeCatalog:deliveries?.recipeCatalog},recipeDelivery:deliveries}:{})}});
 if(installation||activatedPolicy||returnedPolicy||rotation)await runtime.authorize();
 const originalScope=structuredClone(scope), authority=runtime.authority;
 const useContent=deliveryContent??content;
 const mountedRecord=await storage.readPairingAuthority(householdScope);
 const record=mountedRecord.ok && mountedRecord.value && mountedRecord.value.revision===resolved.expectedAuthority?.record.revision && mountedRecord.value.acceptedParent===resolved.expectedAuthority?.record.acceptedParent && mountedRecord.value.authorizationSnapshot===resolved.expectedAuthority?.record.authorizationSnapshot ? structuredClone(mountedRecord.value) : null;
 policyMounts.set(runtime,{record,keys,signing:structuredClone(signing),activated:!!(activatedPolicy||returnedPolicy||rotation),paired:!!paired,storage,authority,scope:originalScope,expected:structuredClone(resolved.expectedAuthority),pin,provider,LoroDoc,sodium});
 policyReaders.set(runtime,async (route,fn)=>{
  if(rotation)throw Error('SOURCE_PROVENANCE_REQUIRED');
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
