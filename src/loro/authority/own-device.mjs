import {domain} from './validator.mjs';
import {ceremonyBytes} from '../pairing/candidate-v2.mjs';
import {verifySessionEvidence} from '../pairing/durable-session.mjs';

export const ownDeviceSignal = (pin,parent,adultId,peerId,parentRevision) => domain('household-own-device-ceremony', {
 pin, adultId, peerId, parentRevision, documentId:parent.runtime.documentId,
 generation:parent.generation, epochId:parent.epochId, policyHash:parent.policyHash
});
export const ownDevicePins = (sodium,transcript) => Object.fromEntries(['initiator','responder'].map(role=>{
 const p=transcript[role];
 return [role,{deviceId:p.deviceId,signingKey:sodium.to_hex(p.signingPublicKey),wrappingKey:sodium.to_hex(p.wrappingPublicKey)}];
}));
export const ownDeviceHash = (sodium,t,g) => sodium.to_hex(sodium.crypto_generichash(32,ceremonyBytes(t,g)));

export function checkOwnDeviceCeremony(sodium,pin,parent,t,g,adultId,peerId,parentRevision,knownWrappingKey) {
 const hash=ownDeviceHash(sodium,t,g), pins=ownDevicePins(sodium,t);
 const sponsor=parent.devices.find(d=>d.active&&d.deviceId===pins.initiator.deviceId);
 const recipient=pins.responder;
 if(!sponsor||sponsor.adultId!==adultId||!parent.runtime.acceptedRecipients.includes(sponsor.deviceId)||
    sponsor.signingKeyRef!==pins.initiator.signingKey||(knownWrappingKey&&knownWrappingKey!==pins.initiator.wrappingKey)||
    parent.devices.length>=128||parent.devices.some(d=>d.deviceId===recipient.deviceId||d.signingKeyRef===recipient.signingKey)||
    pins.initiator.wrappingKey===recipient.wrappingKey||Object.values(parent.runtime.authorPeers).includes(peerId)||
    t.action!=='pairOwnDevice'||t.scope.kind!=='household'||t.scope.id!==parent.householdId||t.acceptedParent!==parent.head||
    t.purpose!=='data'||g.direction!=='initiator-to-responder'||t.signaling.length!==1||
    sodium.to_hex(t.signaling[0])!==sodium.to_hex(ownDeviceSignal(pin,parent,adultId,peerId,parentRevision)))throw Error('INVALID_OWN_DEVICE');
 return {hash,pins};
}

export function verifyOwnDeviceEvent(sodium,pin,parent,event,proof,knownWrappingKey) {
 if(!proof||Object.keys(proof).sort().join(',')!=='guard,messages,transcript')throw Error('INVALID_OWN_DEVICE');
 const {transcript:t,guard:g,messages}=proof, s=event.subject;
 const oob=checkOwnDeviceCeremony(sodium,pin,parent,t,g,s.adultId,s.peerId,s.parentRevision,knownWrappingKey);
 if(t.sessionId!==event.proposalId||t.authorizationSnapshot!==s.parentSnapshot||oob.hash!==s.transcriptHash||
    t.initiator.deviceId!==event.authorDeviceId||t.responder.deviceId!==s.deviceId||
    oob.pins.responder.signingKey!==s.signingKeyRef||oob.pins.responder.wrappingKey!==s.wrappingKeyRef)throw Error('INVALID_OWN_DEVICE');
 verifySessionEvidence(sodium,t,g,oob,messages);
 return oob;
}
