import {domain} from '../authority/validator.mjs';
import {checkExistingRecipientCeremonies} from '../authority/ceremony.mjs';

/** Second signaling item for an established recipient of an own-device successor. */
export function ownDeviceRecipientSignal(eventHash,copyHash,epochId) {
 if(!/^[0-9a-f]{64}$/.test(eventHash)||!/^[0-9a-f]{64}$/.test(copyHash)||typeof epochId!=='string'||!epochId||new TextEncoder().encode(epochId).length>256)throw Error('INVALID_PROOF');
 return domain('household-own-device-existing-recipient',{version:1,eventHash,copyHash,epochId});
}

/** Verify completed recipient ceremonies against an independently verified successor and parent node. */
export async function verifyOwnDeviceRecipients({sodium,provider,successor,parent,authorizationSnapshot,evidence}) {
 const s=structuredClone(successor),p=structuredClone(parent),proofs=structuredClone(evidence);
 const event=s?.item?.event, head=s?.head, sponsor=event?.authorDeviceId, newcomer=event?.subject?.deviceId;
 if(event?.kind!=='pairOwnDevice'||event.parentHead!==p?.head||event.householdId!==p.householdId||typeof authorizationSnapshot!=='string'||!authorizationSnapshot||event.subject?.parentSnapshot!==authorizationSnapshot||!Array.isArray(p.runtime?.acceptedRecipients)||!Array.isArray(p.devices)||!Array.isArray(proofs))throw Error('INVALID_PROOF');
 const signal=ownDeviceRecipientSignal(head,event.subject.copyHash,event.epochId);
 if(sodium.to_hex(await provider.hash(domain('event',event)))!==head||!p.runtime.acceptedRecipients.includes(sponsor)||p.runtime.acceptedRecipients.includes(newcomer))throw Error('INVALID_PROOF');
 const required=p.runtime.acceptedRecipients.filter(id=>id!==sponsor&&id!==newcomer);
 if(new Set(p.runtime.acceptedRecipients).size!==p.runtime.acceptedRecipients.length||required.length!==proofs.length||required.length>128||required.some(id=>!p.devices.some(d=>d.active&&d.deviceId===id)))throw Error('INVALID_PROOF');
 const seen=new Set();
 for(const e of proofs){
  const id=e?.context?.recipientDeviceId,t=e?.transcript;
  if(!required.includes(id)||seen.has(id)||e.context.sponsorDeviceId!==sponsor||t?.action!=='pairOwnDevice'||!Array.isArray(t.signaling)||t.signaling.length!==2||!(t.signaling[1] instanceof Uint8Array)||sodium.to_hex(t.signaling[1])!==sodium.to_hex(signal))throw Error('INVALID_PROOF');
  seen.add(id);
 }
 return checkExistingRecipientCeremonies(sodium,p,authorizationSnapshot,{admissionEventHash:head,newEpochId:event.epochId},proofs,provider);
}
