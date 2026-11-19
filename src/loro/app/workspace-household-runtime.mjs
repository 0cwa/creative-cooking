import {resolveInstalledSetAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {installedDocumentSetContent} from '../pairing/household-document-set.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {localProvider} from './local-provider.mjs';
import {installedRecipeDelivery} from './installed-recipe-delivery.mjs';
import {selectedOwnDeviceSet} from '../pairing/household-own-device-set.mjs';

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

export async function openWorkspaceHouseholdRuntime({storage,resolved,installedSet,pin,provider,sodium,keys,signing,
 wrapping=/** @type {any} */(undefined),LoroDoc,decodeImportBlobMeta}) {
 resolved=structuredClone(resolved);
 const {scope}=resolved,householdScope={kind:'household',id:scope.scopeId};
 const installation=installedSet?{...installedSet,sodium,LoroDoc}:null;
 const paired=installation?.paired;
 const members=new Map((paired?resolved.pairedDocuments:[]).map(document=>[document.documentId,document]));
 const content=paired
  ? (epochId,fn,header)=>{
    const member=members.get(header?.documentId);
    if(!member||epochId!==scope.epochId||header.epochId!==scope.epochId||
       header.scopeId!==scope.scopeId||header.branchHead!==scope.branchHead||
       header.documentGeneration!==scope.documentGeneration||member.identity.deviceId!==scope.authorDevice)
     throw Error('INVALID_AUTHORITY');
    return paired.keys.use(member.keyOperationId,member.identity,fn);
   }
  : installation
  ? await installedDocumentSetContent({storage,scope:householdScope,pin,provider,...installation},keys)
  : (epochId,fn)=>keys.useIdentity({version:1,scope:householdScope,deviceId:scope.authorDevice,purpose:'data',epochId},fn);
 if(installation){
  for(const {documentId} of resolved.members)await content(scope.epochId,()=>{}, {...scope,documentId});
 }
 const deliveries=installation&&!paired&&wrapping?installedRecipeDelivery({sodium,keys,signing,wrapping,provider,pin,resolved,baselineContent:content}):null;
 const codec=deliveries?.codec??candidateCodec(localProvider(sodium,keys,{signing,content}));
 const runtime=new OfflineRuntime({storage,codec,LoroDoc,decodeImportBlobMeta,scope,keyRef:scope.epochId,
  authority:{kind:'household',rootPin:pin,provider,selectionIndex:resolved.selectionIndex,
   ...(installation?{installedSet:{...installation,recipeCatalog:deliveries?.recipeCatalog},recipeDelivery:deliveries}:{})}});
 if(installation)await runtime.authorize();
 return runtime;
}
