import {resolveInstalledSetAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {readInstalledHouseholdDocumentSet} from '../pairing/household-document-set.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {householdReceiverIds} from './household-transfer.mjs';
import {selectedOwnDeviceSet} from '../pairing/household-own-device-set.mjs';

const decoder=new TextDecoder('utf-8',{fatal:true});

/** Discover the local receipt from pinned selected authority. A public parent
 * alone does not authorize creating or exposing a sequence counter. */
export async function joinedHouseholdAuthority({storage,scope,pin,provider,deviceId,sodium,operationId,confirmedParent,legacy,pins,paired=undefined}) {
 scope=structuredClone(scope);
 legacy=structuredClone(legacy);
 const raw=await storage.readPairingAuthority(scope);
 if(!raw.ok)throw Error('INVALID_ADMISSION');
 let state;
 try { state=raw.value&&JSON.parse(decoder.decode(raw.value.authorityState)); }
 catch { throw Error('INVALID_ADMISSION'); }
 const pairedOperation=await selectedOwnDeviceSet(raw.value,state,provider);
 if(pairedOperation){
  if(!paired||operationId!==householdReceiverIds(sodium,scope,deviceId).operationId)throw Error('INVALID_ADMISSION');
  const receipt=await storage.readHouseholdOwnDeviceSetReceipt(scope,pairedOperation);
  const savedPin=(await pins?.list())?.find(value=>value?.scope?.kind==='household'&&value.scope.id===scope.id);
  if(!receipt.ok||!receipt.value||receipt.value.recipient.deviceId!==deviceId||
    !savedPin||savedPin.pin!==pin||savedPin.head!==receipt.value.expected.acceptedParent||
    (confirmedParent!==undefined&&confirmedParent!==savedPin.head))throw Error('INVALID_ADMISSION');
  const installedSet={operationId:pairedOperation,paired};
  const resolved=await resolveInstalledSetAuthority({storage,scope,pin,provider,authorDevice:deviceId,sodium,
   LoroDoc:paired.LoroDoc,...installedSet});
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
