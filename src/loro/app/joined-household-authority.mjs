import {authorityBytes,resolveAdultRemovalRuntimeAuthority,resolveActivatedPolicyAuthority,resolveInstalledSetAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {readInstalledHouseholdDocumentSet} from '../pairing/household-document-set.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {householdReceiverIds} from './household-transfer.mjs';
import {selectedOwnDeviceSet} from '../pairing/household-own-device-set.mjs';
import {domain} from '../authority/validator.mjs';
import {discoverSelectedAdultRemoval} from './adult-removal-discovery.mjs';

const decoder=new TextDecoder('utf-8',{fatal:true});
const same=(a,b)=>{const x=authorityBytes(a),y=authorityBytes(b);return x.length===y.length&&x.every((v,i)=>v===y[i])};

// The authenticated selected chain must retain the original admission on the
// actual event ancestry, not just somewhere in the selection log.
export async function verifyJoinedOrigin({chain,expectedParent,ancestryHead=expectedParent,savedPin,storage,scope,pin,provider,sodium,deviceId,legacy}) {
 if(!savedPin||savedPin.pin!==pin||savedPin.scope?.kind!=='household'||savedPin.scope.id!==scope.id)throw Error('INVALID_ADMISSION');
 const selections=chain.selections, selectedHeads=[pin,...selections.map(selection=>selection.to)];
 const parentIndex=selectedHeads.lastIndexOf(expectedParent), pinIndex=selectedHeads.indexOf(savedPin.head);
 if(pinIndex<0||parentIndex<pinIndex)throw Error('INVALID_ADMISSION');
 let originHead;
 if(legacy){
  const checked=await storage.householdRecipient.check(legacy);
  if(!checked.ok||checked.value!==true||legacy.scopeId!==scope.id||
     legacy.receiptBody?.recipientDevice!==deviceId||legacy.expectedAuthority.acceptedParent!==savedPin.head)throw Error('INVALID_ADMISSION');
  originHead=legacy.nextAuthority.acceptedParent;
 }else{
  const origin=chain.events.find(item=>item.admission?.manifest?.version===5&&
   item.event.parentHead===savedPin.head&&item.admission.grant.recipientDevices.includes(deviceId)&&
   selections.some(selection=>selection.from===savedPin.head&&selection.to===item.admission.grant.admissionEventHash));
  if(!origin)throw Error('INVALID_ADMISSION');
  const first=await readInstalledHouseholdDocumentSet({storage,scope,pin,provider,sodium,operationId:origin.admission.operationId});
  originHead=origin.admission.grant.admissionEventHash;
  if(first.mode!=='recipient'||first.selection.from!==savedPin.head||first.selection.to!==originHead||
     first.item.admission.grant.admissionEventHash!==originHead||
     first.publication.localKey.record.identity.deviceId!==deviceId)throw Error('INVALID_ADMISSION');
 }
 const originIndex=selectedHeads.indexOf(originHead,pinIndex+1);
 if(originIndex!==pinIndex+1||originIndex>parentIndex)throw Error('INVALID_ADMISSION');
 const parents=new Map();
 for(const item of chain.events){
  const hash=await provider.hash(domain('event',item.event));
  parents.set(Array.from(hash,b=>b.toString(16).padStart(2,'0')).join(''),item.event.parentHead);
 }
 let head=ancestryHead;
 const ancestors=new Set();
 while(head&&!ancestors.has(head)){ancestors.add(head);head=parents.get(head)}
 if(!ancestors.has(expectedParent)||!ancestors.has(originHead)||!ancestors.has(savedPin.head))throw Error('INVALID_ADMISSION');
}

/** Discover the local receipt from pinned selected authority. A public parent
 * alone does not authorize creating or exposing a sequence counter. */
export async function joinedHouseholdAuthority({storage,scope,pin,provider,deviceId,sodium,operationId,confirmedParent,legacy,pins,paired=undefined,allowActivatedPolicy=false,allowAdultRemoval=false}) {
 scope=structuredClone(scope);
 legacy=structuredClone(legacy);
 const raw=await storage.readPairingAuthority(scope);
 if(!raw.ok)throw Error('INVALID_ADMISSION');
 let state;
 try { state=raw.value&&JSON.parse(decoder.decode(raw.value.authorityState)); }
 catch { throw Error('INVALID_ADMISSION'); }
 const removal=await discoverSelectedAdultRemoval(raw.value,provider);
 if(removal){
  if(!allowAdultRemoval||!paired?.keys||!paired.LoroDoc||operationId!==householdReceiverIds(sodium,scope,deviceId).operationId)throw Error('INVALID_ADMISSION');
  const role=removal.authorDeviceId===deviceId?'sponsor':'recipient';
  const readReceipt=()=>role==='sponsor'?storage.readAdultRemovalPublication(scope.id,removal.operationId):storage.readAdultRemovalRecipient(scope.id,removal.operationId);
  const first=await readReceipt();
  if(!first.ok||!first.value||!same(first.value.next,raw.value))throw Error('INVALID_ADMISSION');
  const adultRemoval={operationId:removal.operationId,role,withWrapping:paired.useWrapping};
  const resolved=await resolveAdultRemovalRuntimeAuthority({storage,scope,pin,provider,authorDevice:deviceId,operationId:removal.operationId,role,sodium,LoroDoc:paired.LoroDoc,keys:paired.keys,withWrapping:paired.useWrapping});
  const savedPin=(await pins?.list())?.find(value=>value?.scope?.kind==='household'&&value.scope.id===scope.id);
  if(confirmedParent!==undefined&&confirmedParent!==savedPin?.head)throw Error('INVALID_ADMISSION');
  let chain;try{chain=JSON.parse(decoder.decode(first.value.expected.authorityState));}catch{throw Error('INVALID_ADMISSION');}
  await verifyJoinedOrigin({chain,expectedParent:first.value.expected.acceptedParent,savedPin,storage,scope,pin,provider,sodium,deviceId,legacy});
  const after=await readReceipt(),current=await storage.readPairingAuthority(scope);
  if(!after.ok||!after.value||!same(after.value,first.value)||!current.ok||!same(current.value,raw.value))throw Error('INVALID_ADMISSION');
  return {resolved,installedSet:null,adultRemoval};
 }
 // This opt-in is reserved for the future allocator/bootstrap integration.
 // The untrusted head locates a receipt; the resolver authenticates it and
 // requires its next record to equal the current authority.
 if(allowActivatedPolicy && raw.value){
  const targetHead=raw.value.acceptedParent;
  const retained=await storage.readActivatedPolicyDocumentSet(scope.id,targetHead);
  if(!retained.ok)throw Error('INVALID_ADMISSION');
  if(retained.value){
   if(!paired?.keys||!paired.LoroDoc||operationId!==householdReceiverIds(sodium,scope,deviceId).operationId)throw Error('INVALID_ADMISSION');
   const resolved=await resolveActivatedPolicyAuthority({storage,scope,pin,provider,authorDevice:deviceId,LoroDoc:paired.LoroDoc,targetHead,keys:paired.keys});
   const {readVerifiedActivatedPolicyDocumentSet}=await import('./read-activated-policy-document-set.mjs');
   const verified=await readVerifiedActivatedPolicyDocumentSet({storage,scope,pin,provider,deviceId,LoroDoc:paired.LoroDoc,targetHead,keys:paired.keys,sodium});
   const savedPin=(await pins?.list())?.find(value=>value?.scope?.kind==='household'&&value.scope.id===scope.id);
   if(confirmedParent!==undefined&&confirmedParent!==savedPin?.head)throw Error('INVALID_ADMISSION');
   await verifyJoinedOrigin({chain:verified.state,expectedParent:verified.expected.acceptedParent,savedPin,storage,scope,pin,provider,sodium,deviceId,legacy});
   return {resolved,installedSet:null,activatedPolicy:{targetHead}};
  }
 }
 const pairedOperation=await selectedOwnDeviceSet(raw.value,state,provider);
 if(pairedOperation){
  if(!paired||operationId!==householdReceiverIds(sodium,scope,deviceId).operationId)throw Error('INVALID_ADMISSION');
  const receipt=await storage.readHouseholdOwnDeviceSetReceipt(scope,pairedOperation);
  const savedPin=(await pins?.list())?.find(value=>value?.scope?.kind==='household'&&value.scope.id===scope.id);
  if(!receipt.ok||!receipt.value||receipt.value.recipient.deviceId!==deviceId||
    !savedPin||savedPin.pin!==pin||
    (receipt.value.recipient.kind!=='established'&&savedPin.head!==receipt.value.expected.acceptedParent)||
    (confirmedParent!==undefined&&confirmedParent!==savedPin.head))throw Error('INVALID_ADMISSION');
  const installedSet={operationId:pairedOperation,paired};
  const resolved=await resolveInstalledSetAuthority({storage,scope,pin,provider,authorDevice:deviceId,sodium,
   LoroDoc:paired.LoroDoc,...installedSet});
  if(receipt.value.recipient.kind==='established'){
   const chain=resolved.pairedAuthority.state;
   const heads=[pin,...chain.selections.map(selection=>selection.to)];
   const parentIndex=heads.lastIndexOf(receipt.value.expected.acceptedParent);
   const childIndex=heads.lastIndexOf(resolved.head ?? chain.activeHead);
   if(childIndex!==parentIndex+1||heads[childIndex]!==chain.activeHead)throw Error('INVALID_ADMISSION');
   await verifyJoinedOrigin({chain,expectedParent:receipt.value.expected.acceptedParent,ancestryHead:chain.activeHead,savedPin,storage,scope,pin,provider,sodium,deviceId,legacy});
  }
  return {resolved,installedSet};
 }
 const selectedSet=state?.events?.some(item=>item.admission?.manifest?.version===5&&
  item.admission.grant.admissionEventHash===raw.value.acceptedParent);
 if(!selectedSet&&!legacy)return null;
 if(legacy){
  const checked=await storage.householdRecipient.check(legacy);
  if(!checked.ok||checked.value!==true||legacy.receiptBody?.recipientDevice!==deviceId||
    legacy.scopeId!==scope.id||(confirmedParent!==undefined&&legacy.expectedAuthority.acceptedParent!==confirmedParent)){
   throw Error('INVALID_ADMISSION');
  }
 }
 if(!selectedSet)return {resolved:await resolveRuntimeAuthority(storage,scope,pin,provider,deviceId),installedSet:null};
 if(operationId!==householdReceiverIds(sodium,scope,deviceId).operationId)throw Error('INVALID_ADMISSION');
 const {record,state:verified,nodes}=await verifyPublicParent(storage,scope,pin,provider);
 // A new adult may have pinned a public v5 parent without possessing any of
 // its documents. That is not an installed receipt or an active counter.
 if(!legacy&&confirmedParent!==undefined&&record.acceptedParent===confirmedParent&&
   !nodes.get(record.acceptedParent)?.devices.some(device=>device.active&&device.deviceId===deviceId))return null;
 const selected=verified.events.find(item=>item.admission?.manifest?.version===5&&
  item.admission.grant.admissionEventHash===record.acceptedParent);
 if(!selected)throw Error('INVALID_ADMISSION');
 const options={storage,scope,pin,provider,sodium,operationId:selected.admission.operationId};
 const installed=await readInstalledHouseholdDocumentSet(options);
 const savedPin=(await pins?.list())?.find(value=>value?.scope?.kind==='household'&&value.scope.id===scope.id);
 if(!savedPin||savedPin.pin!==pin||(confirmedParent!==undefined&&savedPin.head!==confirmedParent)||
   legacy&&legacy.expectedAuthority.acceptedParent!==savedPin.head)throw Error('INVALID_ADMISSION');
 if(installed.mode!=='recipient'||installed.publication.localKey.record.identity.deviceId!==deviceId)throw Error('INVALID_ADMISSION');
 if(!legacy){
  // A previously joined device keeps its original enrollment and pin when it
  // installs a successor. Revalidate that original receipt and its signed
  // selection before accepting a later existing-device receipt.
  const origin=verified.events.find(item=>item.admission?.manifest?.version===5&&
    item.event.parentHead===savedPin.head&&item.admission.grant.recipientDevices.includes(deviceId)&&
    verified.selections.some(selection=>selection.to===item.admission.grant.admissionEventHash));
  if(!origin)throw Error('INVALID_ADMISSION');
  const first=await readInstalledHouseholdDocumentSet({...options,operationId:origin.admission.operationId});
  if(first.mode!=='recipient'||first.selection.from!==savedPin.head||
     first.selection.to!==origin.admission.grant.admissionEventHash||
     first.item.admission.grant.admissionEventHash!==origin.admission.grant.admissionEventHash||
     first.publication.localKey.record.identity.deviceId!==deviceId||
     !first.item.admission.grant.recipientDevices.includes(deviceId))throw Error('INVALID_ADMISSION');
  if(installed.item.admission.operationId!==origin.admission.operationId&&installed.publication.documentSet.version!==2){
   throw Error('INVALID_ADMISSION');
  }
 }
 const resolved=await resolveInstalledSetAuthority({...options,authorDevice:deviceId});
 return {resolved,installedSet:{operationId:options.operationId}};
}
