import {resolveInstalledSetAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {installedDocumentSetContent} from '../pairing/household-document-set.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {localProvider} from './local-provider.mjs';
import {installedRecipeDelivery} from './installed-recipe-delivery.mjs';

// The original workspace has its own initialized sequence allocator. Joined
// workspaces must use the separate, receipt-gated allocator instead.
export async function resolveOriginalHousehold({storage,scope,pin,provider,deviceId,sodium,LoroDoc}) {
 scope=structuredClone(scope);
 try {
  return {resolved:await resolveRuntimeAuthority(storage,scope,pin,provider,deviceId),installedSet:null};
 }catch(error){
  if(error?.message!=='UNSUPPORTED_VERSION')throw error;
  const {record,state}=await verifyPublicParent(storage,scope,pin,provider);
  const selected=state.events.find(item=>item.admission?.manifest?.version===5&&
   item.admission.grant.admissionEventHash===record.acceptedParent);
  if(!selected)throw error;
  const installedSet={operationId:selected.admission.operationId};
  const resolved=await resolveInstalledSetAuthority({storage,scope,pin,provider,authorDevice:deviceId,sodium,LoroDoc,...installedSet});
  return {resolved,installedSet};
 }
}

export async function openWorkspaceHouseholdRuntime({storage,resolved,installedSet,pin,provider,sodium,keys,signing,
 wrapping=/** @type {any} */(undefined),LoroDoc,decodeImportBlobMeta}) {
 resolved=structuredClone(resolved);
 const {scope}=resolved,householdScope={kind:'household',id:scope.scopeId};
 const installation=installedSet?{...installedSet,sodium,LoroDoc}:null;
 const content=installation
  ? await installedDocumentSetContent({storage,scope:householdScope,pin,provider,...installation},keys)
  : (epochId,fn)=>keys.useIdentity({version:1,scope:householdScope,deviceId:scope.authorDevice,purpose:'data',epochId},fn);
 if(installation){
  for(const {documentId} of resolved.members)await content(scope.epochId,()=>{}, {...scope,documentId});
 }
 const deliveries=installation&&wrapping?installedRecipeDelivery({sodium,keys,signing,wrapping,provider,pin,resolved,baselineContent:content}):null;
 const codec=deliveries?.codec??candidateCodec(localProvider(sodium,keys,{signing,content}));
 const runtime=new OfflineRuntime({storage,codec,LoroDoc,decodeImportBlobMeta,scope,keyRef:scope.epochId,
  authority:{kind:'household',rootPin:pin,provider,selectionIndex:resolved.selectionIndex,
   ...(installation?{installedSet:{...installation,recipeCatalog:deliveries?.recipeCatalog},recipeDelivery:deliveries}:{})}});
 if(installation)await runtime.authorize();
 return runtime;
}
