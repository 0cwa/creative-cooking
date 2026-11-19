import {authorityBytes} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {adultRemovalKeySlot} from './publish-adult-removal-set.mjs';
import {withOpenedAdultRemovalRelease} from './open-adult-removal.mjs';
import {digest,hex,verifySignature} from './revocation.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));
const receiptRecord=r=>({...r,authorityState:hex(r.authorityState)});

/** Install only a freshly verified addressed release. Replay and reopen are unsupported. */
export async function installAdultRemovalRelease(options) {
 options={...options,scope:structuredClone(options.scope),release:structuredClone(options.release),localSelection:structuredClone(options.localSelection)};
 const {storage,scope,pin,provider,sodium,keys,recipientDeviceId,signSelection,release,confirmedHead,confirmedGrantHash}=options;
 const local=await verifyPublicParent(storage,scope,pin,provider);
 if(local.record.revision!==options.expectedRevision)throw Error('STALE_AUTHORITY');
 const recipient=local.nodes.get(local.state.activeHead).devices.find(d=>d.active&&d.deviceId===recipientDeviceId);
 if(!recipient || typeof signSelection!=='function')throw Error('INVALID_RECIPIENT');
 return withOpenedAdultRemovalRelease(options,async opened=>{
  if(!same(opened.expected,local.record))throw Error('STALE_AUTHORITY');
  const {manifest,item}=release.proposal,documents=[],targets=[];
  for(const [i,entry] of manifest.entries.entries()){
   const {recipeId,sourceDocumentId,sourceRevision,documentId}=entry;
   const slot=await adultRemovalKeySlot(provider,scope,manifest,recipientDeviceId,documentId);
   const localKey=await keys.preparePairedDataKey(slot.operationId,slot.identity,opened.keys[i]);
   const {snapshot,...seed}=opened.documents[i].seed;
   documents.push({recipeId,sourceDocumentId,sourceRevision,documentId,bytes:snapshot,localKey});
   targets.push({recipeId,sourceDocumentId,sourceRevision,documentId,...slot,seed,policyBundle:opened.documents[i].policyBundle,
    snapshotHash:hex(sodium.crypto_generichash(32,snapshot)),keyHash:hex(sodium.crypto_generichash(32,opened.keys[i])),
    wrappedHash:await digest(provider,'adult-removal-wrapped-key-v1',hex(localKey.record.wrapped))});
  }
  const body={version:1,scope,operationId:item.event.proposalId,recipientDeviceId,eventHash:confirmedHead,grantHash:confirmedGrantHash,
   ciphertextHash:hex(sodium.crypto_generichash(32,release.bytes)),publisherProof:hex(release.proof),publisherRecord:receiptRecord(release.publisherRecord),
   expected:receiptRecord(opened.expected),next:receiptRecord(opened.record),selection:opened.selection,targets};
  const proof=domain('adult-removal-recipient-receipt-v1',body);
  const signature=hex(await signSelection(proof));
  if(!await verifySignature(provider,recipient.signingKeyRef,'adult-removal-recipient-receipt-v1',body,signature))throw Error('INVALID_SIGNER');
  const result=await storage.commitAdultRemovalRecipient({version:1,operationId:item.event.proposalId,recipientDeviceId,manifestHash:release.proposal.grant.manifestHash,
   proof,signature,ciphertext:release.bytes,publisherRecord:release.publisherRecord,expected:opened.expected,next:opened.record,documents});
  if(!result.ok)throw Error(result.error.code);
  return {head:opened.record.acceptedParent};
 });
}
