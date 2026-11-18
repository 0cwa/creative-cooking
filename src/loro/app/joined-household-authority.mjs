import {resolveInstalledSetAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {readInstalledHouseholdDocumentSet} from '../pairing/household-document-set.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {householdReceiverIds} from './household-transfer.mjs';

const decoder=new TextDecoder('utf-8',{fatal:true});

/** Discover the local receipt from pinned selected authority. A public parent
 * alone does not authorize creating or exposing a sequence counter. */
export async function joinedHouseholdAuthority({storage,scope,pin,provider,deviceId,sodium,operationId,confirmedParent,legacy,pins}) {
 scope=structuredClone(scope);
 legacy=structuredClone(legacy);
 const raw=await storage.readPairingAuthority(scope);
 if(!raw.ok)throw Error('INVALID_ADMISSION');
 let state;
 try { state=raw.value&&JSON.parse(decoder.decode(raw.value.authorityState)); }
 catch { throw Error('INVALID_ADMISSION'); }
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
 const {record,state:verified}=await verifyPublicParent(storage,scope,pin,provider);
 const selected=verified.events.find(item=>item.admission?.manifest?.version===5&&
  item.admission.grant.admissionEventHash===record.acceptedParent);
 if(!selected)throw Error('INVALID_ADMISSION');
 const options={storage,scope,pin,provider,sodium,operationId:selected.admission.operationId};
 const installed=await readInstalledHouseholdDocumentSet(options);
 const savedPin=(await pins?.list())?.find(value=>value?.scope?.kind==='household'&&value.scope.id===scope.id);
 if(!savedPin||savedPin.pin!==pin||(confirmedParent!==undefined&&savedPin.head!==confirmedParent)||
   (legacy?legacy.expectedAuthority.acceptedParent!==savedPin.head:installed.selection.from!==savedPin.head)){
  throw Error('INVALID_ADMISSION');
 }
 if(installed.mode!=='recipient'||installed.publication.localKey.record.identity.deviceId!==deviceId||
   (!legacy&&!selected.admission.grant.recipientDevices.includes(deviceId)))throw Error('INVALID_ADMISSION');
 const resolved=await resolveInstalledSetAuthority({...options,authorDevice:deviceId});
 return {resolved,installedSet:{operationId:options.operationId}};
}
