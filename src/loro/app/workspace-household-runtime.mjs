import {resolveActivatedPolicyAuthority,resolveInstalledSetAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {installedDocumentSetContent} from '../pairing/household-document-set.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {localProvider} from './local-provider.mjs';
import {installedRecipeDelivery} from './installed-recipe-delivery.mjs';
import {preparePolicyDocumentKeys} from './prepare-policy-document-keys.mjs';
import {readVerifiedPolicyDocumentSet} from './stage-policy-document-set.mjs';
import {readRecipeCatalog} from './selected-recipe-catalog.mjs';
import {selectedOwnDeviceSet} from '../pairing/household-own-device-set.mjs';

const policyReaders=new WeakMap();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Prepare wrapped keys for a staged policy successor; does not activate it. */
export async function prepareWorkspacePolicyDocumentKeys(runtime,targetHead,keys) {
 const reader=policyReaders.get(runtime);
 if(!reader)throw Error('INVALID_SOURCE_READER');
 return preparePolicyDocumentKeys({runtime,targetHead,keys,withSourceDocumentKey:reader});
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
