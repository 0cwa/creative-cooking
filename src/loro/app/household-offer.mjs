import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {validateSuccessor} from '../authority/validator.mjs';
import {checkGrantSignatures,checkAdmissionAgreement} from '../authority/grant.mjs';
import {householdSessionContextBytes} from '../pairing/durable-session.mjs';
import {ceremonyBytes} from '../pairing/candidate-v2.mjs';
import {validPairingScope} from '../contracts/pairing.ts';
import {verifyRecipientInstallation} from '../authority/recipient-load.mjs';
import {householdReceiverIds} from './household-transfer.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
/** Verify an organizer's public offer against the independently confirmed
 * local parent and a separately compared ceremony hash. No key is released. */
export async function verifyHouseholdOffer({storage,pins,provider,sodium,identity,offer,confirmedHash}){
 const input=structuredClone(offer),own=structuredClone(identity);if(!input||!validPairingScope(input.scope)||input.scope.kind!=='household'||typeof confirmedHash!=='string'||!/^[0-9a-f]{64}$/.test(confirmedHash))throw Error('MALFORMED');
 const confirmed=(await pins.list()).find(x=>x.scope.kind==='household'&&x.scope.id===input.scope.id);
 if(!confirmed)throw Error('CONFIRMATION_REQUIRED');
 const item=input.item,grant=input.grant,c=input.ceremony?.context,t=input.ceremony?.transcript,guard=input.ceremony?.guard;
 if(!item?.event||!grant||!c||!t||!guard)throw Error('MALFORMED');
 let proof=await verifyPublicParent(storage,input.scope,confirmed.pin,provider),installedTranscriptHash;
 if(proof.record.acceptedParent!==confirmed.head){
  // Installing the original file advances authority before the user opens the
  // household. Only that authenticated receipt can resume this invitation.
  if(proof.record.acceptedParent!==grant.admissionEventHash)throw Error('INVALID_AUTHORITY');
  const saved=await verifyRecipientInstallation({storage,scope:input.scope,pin:confirmed.pin,provider,sodium,state:proof.state,eventHash:proof.record.acceptedParent});
  const receipt=saved?.installation,ids=householdReceiverIds(sodium,input.scope,own.deviceId);
  if(!receipt||receipt.operationId!==ids.operationId||receipt.expectedAuthority.acceptedParent!==confirmed.head||receipt.receiptBody.recipientDevice!==own.deviceId||receipt.guardId!==guard.guardId||receipt.manifest.id!==grant.projectionManifestHash)throw Error('INVALID_AUTHORITY');
  installedTranscriptHash=saved.transcriptHash;
  proof={...proof,record:receipt.expectedAuthority,state:saved.parent};
 }
 const parent=proof.nodes.get(confirmed.head);
 if(!parent)throw Error('INVALID_AUTHORITY');
 const event=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider),signed=await checkGrantSignatures(parent,grant,provider);if(event.reason!=='ADMISSION_AND_PROJECTION_REQUIRED'||signed.reason!=='ADMISSION_EVIDENCE_REQUIRED'||grant.admissionEventHash!==event.eventHash||grant.recipientAdult!==item.event.subject.adultId||JSON.stringify(grant.recipientDevices)!==JSON.stringify(item.event.subject.devices.map(d=>d.deviceId))||grant.newEpochId!==item.event.subject.newEpochId||grant.newDocumentGeneration!==item.event.subject.newGeneration||JSON.stringify(grant.contentClasses)!==JSON.stringify(['pantry','recipe','shopping']))throw Error('INVALID_PROOF');
 let delegated=false;for(const agreement of proof.state.agreements??[]){if(agreement.parentHead!==confirmed.head)continue;const checked=await checkAdmissionAgreement(parent,agreement,provider);if(checked.status==='accepted'&&checked.delegationHash===grant.delegationHash&&JSON.stringify(agreement.sourcePolicyHashes)===JSON.stringify(grant.sourcePolicyHashes))delegated=true}if(!delegated)throw Error('DELEGATION_REQUIRED');
 const target=item.event.subject.devices.find(d=>d.deviceId===own.deviceId),sender=parent.devices.find(d=>d.active&&d.deviceId===c.sponsorDeviceId&&d.adultId===c.sponsorAdult);if(!target||!sender||item.event.subject.adultId!==own.adultId||target.signingKeyRef!==own.signingKey||target.wrappingKeyRef!==own.wrappingKey||c.householdId!==input.scope.id||c.parentHead!==confirmed.head||c.admissionEventHash!==event.eventHash||c.recipientAdult!==own.adultId||c.recipientDeviceId!==own.deviceId||c.recipientSigningKeyRef!==own.signingKey||c.recipientWrappingKeyRef!==own.wrappingKey||c.sponsorSigningKeyRef!==sender.signingKeyRef||c.sponsorWrappingKeyRef!==hex(t.initiator?.wrappingPublicKey??[])||t.action!=='inviteAdult'||t.purpose!=='data'||guard.purpose!=='data'||t.scope?.kind!=='household'||t.scope.id!==input.scope.id||t.acceptedParent!==confirmed.head||t.authorizationSnapshot!==proof.record.authorizationSnapshot||t.initiator?.deviceId!==sender.deviceId||hex(t.initiator?.signingPublicKey??[])!==sender.signingKeyRef||t.responder?.deviceId!==own.deviceId||hex(t.responder?.signingPublicKey??[])!==own.signingKey||hex(t.responder?.wrappingPublicKey??[])!==own.wrappingKey||guard.direction!=='initiator-to-responder'||!Array.isArray(t.signaling)||t.signaling.length!==1||hex(t.signaling[0])!==hex(householdSessionContextBytes(c)))throw Error('INVALID_PROOF');
 const digest=hex(sodium.crypto_generichash(32,ceremonyBytes(t,guard)));if(digest!==confirmedHash)throw Error('CONFIRMATION_REQUIRED');if(installedTranscriptHash!==undefined&&digest!==installedTranscriptHash)throw Error('INVALID_AUTHORITY');const oob={hash:digest,pins:Object.fromEntries(['initiator','responder'].map(role=>[role,{deviceId:t[role].deviceId,signingKey:hex(t[role].signingPublicKey),wrappingKey:hex(t[role].wrappingPublicKey)}]))};return {transcript:structuredClone(t),guard:structuredClone(guard),context:structuredClone(c),oob};
}
