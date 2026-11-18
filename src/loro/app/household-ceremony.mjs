import {checkCurrentAdmission,readAuthority,verifyAuthority} from '../authority/chain.mjs';
import {householdSessionContextBytes} from '../pairing/durable-session.mjs';
import {verifyCurrentDocumentSet} from '../projection/current-document-set.mjs';
import {domain} from '../authority/validator.mjs';
import {ceremonyBytes} from '../pairing/candidate-v2.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const publicKey=(sodium,value)=>{if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw Error('INVALID_KEY');return sodium.from_hex(value)};
function invitationSignaling(context,manifestVersion,grantHash){
 const signaling=[householdSessionContextBytes(context)];
 if(manifestVersion===5)signaling.push(domain('household-document-set-invitation',{manifestVersion,grantHash}));
 return signaling;
}

export function matchesInvitationSignaling(transcript,context,manifestVersion,grantHash){
 const expected=invitationSignaling(context,manifestVersion,grantHash),actual=transcript?.signaling;
 return Array.isArray(actual)&&actual.length===expected.length&&expected.every((bytes,index)=>
  actual[index] instanceof Uint8Array&&hex(actual[index])===hex(bytes));
}

/** The organizer prepares only public challenge data after a verified event,
 * grant and separately accepted current-cooking delegation. Neither the code
 * nor the public bundle is an acceptance or a key release. */
export async function prepareHouseholdCeremony({storage,scope,pin,provider,store,sodium,deviceId,adultId,wrappingPublicKey,item,grant,manifest,seed,documents,LoroDoc,explicit,randomUUID=()=>crypto.randomUUID()}){
 if(explicit!==true)throw Error('MALFORMED');
 ({scope,item,grant,manifest,seed,documents}=structuredClone({scope,item,grant,manifest,seed,documents}));
 const sc=scope,eventItem=item,g=grant,m=manifest,documentSet=m?.version===5;
 let checked;
 if(documentSet){
  if(seed!==undefined||!Array.isArray(documents))throw Error('MALFORMED');
  const verified=await verifyCurrentDocumentSet({storage,scope:sc,pin,provider,item,grant,manifest,documents,LoroDoc});
  checked={admissionEventHash:verified.eventHash,grantHash:verified.grantHash,
   authorityRevision:verified.record.revision,authorizationSnapshot:verified.record.authorizationSnapshot};
 }else{
  if(documents!==undefined||!(seed?.snapshot instanceof Uint8Array)||seed.snapshot.length>8*1024*1024)throw Error('MALFORMED');
  checked=await checkCurrentAdmission(storage,sc,pin,provider,eventItem,g,m,seed.snapshot);
 }
 const current=await readAuthority(storage,sc,pin,provider),verified=await verifyAuthority(current.state,pin,provider),
  parent=verified.nodes.get(current.activeHead),sender=parent?.devices.find(x=>x.active&&x.deviceId===deviceId&&x.adultId===adultId),
  recipient=eventItem.event.subject.devices;
 if(!sender||current.revision!==checked.authorityRevision||recipient.length!==1||eventItem.event.parentHead!==current.activeHead)throw Error('INVALID_AUTHORITY');
 if(documentSet&&parent.runtime.acceptedRecipients.some(device=>device!==deviceId))throw Error('DOCUMENT_SET_EXISTING_DEVICES_UNSUPPORTED');
 const subject=eventItem.event.subject;if(JSON.stringify(g.recipientDevices)!==JSON.stringify(subject.devices.map(d=>d.deviceId))||g.newDocumentGeneration!==subject.newGeneration||g.newEpochId!==subject.newEpochId||m.newDocumentId!==subject.documentId)throw Error('CONTEXT_MISMATCH');
 const context={version:1,householdId:sc.id,parentHead:current.activeHead,admissionEventHash:checked.admissionEventHash,sponsorAdult:adultId,recipientAdult:eventItem.event.subject.adultId,sponsorDeviceId:deviceId,sponsorSigningKeyRef:sender.signingKeyRef,sponsorWrappingKeyRef:wrappingPublicKey,recipientDeviceId:recipient[0].deviceId,recipientSigningKeyRef:recipient[0].signingKeyRef,recipientWrappingKeyRef:recipient[0].wrappingKeyRef},binding=JSON.stringify([sc.kind,sc.id,pin,current.activeHead,checked.authorizationSnapshot,checked.admissionEventHash,checked.grantHash,deviceId,wrappingPublicKey]);
 const saved=await store.transaction(tx=>{const slot=`household-ceremony-draft:${current.activeHead}:${recipient[0].deviceId}`,legacy=tx.get('household-ceremony-draft'),old=tx.get(slot);if(old){if(old.binding!==binding)throw Error('DRAFT_CONFLICT');return old}if(legacy){let prior;try{prior=JSON.parse(legacy.binding)}catch{throw Error('CORRUPT_DRAFT')}if(!Array.isArray(prior)||prior.length!==9)throw Error('CORRUPT_DRAFT');if(prior[3]===current.activeHead){if(legacy.binding!==binding)throw Error('DRAFT_CONFLICT');return legacy}}const participant=(role,id,sign,wrap)=>({role,deviceId:id,signingPublicKey:publicKey(sodium,sign),wrappingPublicKey:publicKey(sodium,wrap),nonce:sodium.randombytes_buf(32)}),transcript={version:1,sessionId:randomUUID(),action:'inviteAdult',scope:sc,purpose:'data',acceptedParent:current.activeHead,authorizationSnapshot:checked.authorizationSnapshot,initiator:participant('initiator',deviceId,sender.signingKeyRef,wrappingPublicKey),responder:participant('responder',recipient[0].deviceId,recipient[0].signingKeyRef,recipient[0].wrappingKeyRef),signaling:invitationSignaling(context,m.version,checked.grantHash)},guard={version:1,guardId:randomUUID(),scope:sc,direction:'initiator-to-responder',purpose:'data'},draft={version:1,binding,transcript,guard,context};tx.put(slot,draft);return draft});
 if(!saved||saved.version!==1||saved.binding!==binding||JSON.stringify(saved.context)!==JSON.stringify(context))throw Error('CORRUPT_DRAFT');if(saved.guard?.direction!=='initiator-to-responder'||saved.guard.purpose!=='data')throw Error('CORRUPT_DRAFT');const t=saved.transcript;if(t?.action!=='inviteAdult'||t.purpose!=='data'||t.scope?.kind!==sc.kind||t.scope?.id!==sc.id||t.acceptedParent!==current.activeHead||t.authorizationSnapshot!==checked.authorizationSnapshot||t.initiator?.deviceId!==deviceId||t.responder?.deviceId!==recipient[0].deviceId||hex(t.initiator?.signingPublicKey??[])!==sender.signingKeyRef||hex(t.initiator?.wrappingPublicKey??[])!==wrappingPublicKey||hex(t.responder?.signingPublicKey??[])!==recipient[0].signingKeyRef||hex(t.responder?.wrappingPublicKey??[])!==recipient[0].wrappingKeyRef||!matchesInvitationSignaling(t,context,m.version,checked.grantHash))throw Error('CORRUPT_DRAFT');const digest=hex(sodium.crypto_generichash(32,ceremonyBytes(saved.transcript,saved.guard))),pins=Object.fromEntries(['initiator','responder'].map(role=>[role,{deviceId:saved.transcript[role].deviceId,signingKey:hex(saved.transcript[role].signingPublicKey),wrappingKey:hex(saved.transcript[role].wrappingPublicKey)}]));return {version:1,transcript:structuredClone(saved.transcript),guard:structuredClone(saved.guard),context:structuredClone(context),oob:{hash:digest,pins},status:'independent-confirmation-required'};
}
