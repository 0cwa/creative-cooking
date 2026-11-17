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
  const sponsor=parent.devices.find(d=>d.active && d.adultId===c?.sponsorAdult && d.deviceId===c?.sponsorDeviceId);
  if(!sponsor || sponsor.signingKeyRef!==c.sponsorSigningKeyRef || c.householdId!==parent.householdId || c.parentHead!==parent.head || c.admissionEventHash!==grant.admissionEventHash || c.recipientAdult!==grant.recipientAdult || !grant.recipientDevices.includes(c.recipientDeviceId) || seen.has(c.recipientDeviceId) || guards.has(g?.guardId) || t.authorizationSnapshot!==authorizationSnapshot || c.sponsorWrappingKeyRef!==hex(t.initiator.wrappingPublicKey) || c.recipientSigningKeyRef!==hex(t.responder.signingPublicKey) || c.recipientWrappingKeyRef!==hex(t.responder.wrappingPublicKey)) throw Error('CONTEXT_MISMATCH');
  const verified=verifyHouseholdSessionEvidence(sodium,t,g,e.oob,e.messages,c);
  const offer=e.messages.offers.initiator, sig=unhex(offer.signature);
  if(!sig || !await provider.verify(sponsor.signingKeyRef,offerBytes('initiator',verified.transcriptHash,offer.challenge),sig)) throw Error('INVALID_PROOF');
  seen.add(c.recipientDeviceId); guards.add(g.guardId);
  devices.push({deviceId:c.recipientDeviceId,signingKeyRef:c.recipientSigningKeyRef,wrappingKeyRef:c.recipientWrappingKeyRef,transcriptHash:verified.transcriptHash,guardId:g.guardId});
 }
 return devices.sort((a,b)=>a.deviceId.localeCompare(b.deviceId));
}
