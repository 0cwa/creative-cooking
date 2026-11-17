// Validate per-device ceremony proofs against a frozen, independently pinned parent.
// Evidence alone never authorizes key release or proves human identity.
import {offerBytes,verifyHouseholdSessionEvidence} from '../pairing/durable-session.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>typeof s==='string' && /^[0-9a-f]{128}$/.test(s)?Uint8Array.from(s.match(/../g),v=>parseInt(v,16)):null;
const exact=(x,k)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===k.length && k.every(n=>Object.hasOwn(x,n));
export async function checkHouseholdCeremonies(sodium,parent,authorizationSnapshot,grant,evidence,provider) {
 if(!Array.isArray(evidence) || evidence.length!==grant.recipientDevices.length || !evidence.length || evidence.length>128) throw Error('CEREMONY_REQUIRED');
 const seen=new Set(), guards=new Set(), devices=[];
 for(let i=0;i<evidence.length;i++) {
  if(!Object.hasOwn(evidence,i)) throw Error('INVALID_PROOF');
  const e=evidence[i];
  if(!exact(e,['transcript','guard','oob','messages','context'])) throw Error('INVALID_PROOF');
  const {transcript:t,guard:g,context:c}=e;
  if(t?.purpose!=='data' || g?.purpose!=='data') throw Error('CONTEXT_MISMATCH');
  const sponsor=parent.devices.find(d=>d.active && d.adultId===c?.sponsorAdult && d.deviceId===c?.sponsorDeviceId);
  if(!sponsor || sponsor.signingKeyRef!==c.sponsorSigningKeyRef || c.householdId!==parent.householdId || c.parentHead!==parent.head || c.admissionEventHash!==grant.admissionEventHash || c.recipientAdult!==grant.recipientAdult || !grant.recipientDevices.includes(c.recipientDeviceId) || seen.has(c.recipientDeviceId) || guards.has(g?.guardId) || t.authorizationSnapshot!==authorizationSnapshot || c.sponsorWrappingKeyRef!==hex(t.initiator.wrappingPublicKey) || c.recipientSigningKeyRef!==hex(t.responder.signingPublicKey) || c.recipientWrappingKeyRef!==hex(t.responder.wrappingPublicKey)) throw Error('CONTEXT_MISMATCH');
  const verified=verifyHouseholdSessionEvidence(sodium,t,g,e.oob,e.messages,c);
  const offer=e.messages.offers.initiator, sig=unhex(offer.signature);
  if(!sig || !await provider.verify(sponsor.signingKeyRef,offerBytes('initiator',verified.transcriptHash,offer.challenge),sig)) throw Error('INVALID_PROOF');
  seen.add(c.recipientDeviceId); guards.add(g.guardId);
  devices.push({deviceId:c.recipientDeviceId,signingKeyRef:c.recipientSigningKeyRef,wrappingKeyRef:c.recipientWrappingKeyRef,transcriptHash:verified.transcriptHash,guardId:g.guardId});
 }
 return devices.sort((a,b)=>a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0);
}

/** First transcript signaling item for an existing device joining a new epoch. */
export function existingRecipientContextBytes(c) {
 const fields=['version','householdId','parentHead','admissionEventHash','newEpochId','sponsorDeviceId','recipientDeviceId','recipientWrappingKey'];
 if(!exact(c,fields) || c.version!==1 || !fields.slice(1).every(k=>typeof c[k]==='string' && c[k].length>0 && new TextEncoder().encode(c[k]).length<=256) || !/^[0-9a-f]{64}$/.test(c.recipientWrappingKey) || c.sponsorDeviceId===c.recipientDeviceId) throw Error('MALFORMED');
 return new TextEncoder().encode(JSON.stringify(['creative-cooking/existing-recipient/v1',fields.map(k=>c[k])]));
}
/** Both transcript participants are resolved against the parent signing-key pins;
 * their signed acknowledgements attest checking sealed challenge responses. */
export async function checkExistingRecipientCeremonies(sodium,parent,authorizationSnapshot,grant,evidence,provider) {
 const {verifySessionEvidence}=await import('../pairing/durable-session.mjs');
 if(!Array.isArray(evidence) || evidence.length>128) throw Error('INVALID_PROOF');
 const devices=[],seen=new Set(),guards=new Set();
 for(let i=0;i<evidence.length;i++) {
  if(!Object.hasOwn(evidence,i)) throw Error('INVALID_PROOF');
  const e=evidence[i];if(!exact(e,['transcript','guard','oob','messages','context'])) throw Error('INVALID_PROOF');
  const {transcript:t,guard:g,context:c}=e, sponsor=parent.devices.find(d=>d.active && d.deviceId===c?.sponsorDeviceId), recipient=parent.devices.find(d=>d.active && d.deviceId===c?.recipientDeviceId);
  if(!sponsor || !recipient || !parent.runtime.acceptedRecipients.includes(recipient.deviceId) || seen.has(recipient.deviceId) || guards.has(g?.guardId) || c.householdId!==parent.householdId || c.parentHead!==parent.head || c.admissionEventHash!==grant.admissionEventHash || c.newEpochId!==grant.newEpochId || t.scope?.kind!=='household' || t.scope.id!==parent.householdId || t.purpose!=='data' || t.acceptedParent!==parent.head || t.authorizationSnapshot!==authorizationSnapshot || t.initiator.deviceId!==sponsor.deviceId || t.responder.deviceId!==recipient.deviceId || hex(t.responder.wrappingPublicKey)!==c.recipientWrappingKey || !Array.isArray(t.signaling) || !(t.signaling[0] instanceof Uint8Array) || hex(t.signaling[0])!==hex(existingRecipientContextBytes(c))) throw Error('CONTEXT_MISMATCH');
  const proof=verifySessionEvidence(sodium,t,g,e.oob,e.messages);
  for(const [role,device] of [['initiator',sponsor],['responder',recipient]]) {const offer=e.messages.offers[role], sig=unhex(offer.signature);if(!sig || !await provider.verify(device.signingKeyRef,offerBytes(role,proof.transcriptHash,offer.challenge),sig)) throw Error('INVALID_PROOF')}
  seen.add(recipient.deviceId);guards.add(g.guardId);devices.push({deviceId:recipient.deviceId,wrappingKeyRef:c.recipientWrappingKey,transcriptHash:proof.transcriptHash,guardId:g.guardId});
 }
 return devices.sort((a,b)=>a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0);
}
