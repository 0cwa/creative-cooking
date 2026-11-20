import {authorityBytes} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {adultRemovalKeySlot} from './publish-adult-removal-set.mjs';
import {withOpenedAdultRemovalRelease} from './open-adult-removal.mjs';
import {reopenAdultRemovalRecipient} from './reopen-adult-removal.mjs';
import {recipientTargetV2,recipientBodyV2} from './adult-removal-receipt.mjs';
import {hex,verifySignature} from './revocation.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));

/** Install a verified addressed release, or authenticate an exact retained retry. */
export async function installAdultRemovalRelease(options) {
 options={...options,scope:structuredClone(options.scope),release:structuredClone(options.release),localSelection:structuredClone(options.localSelection)};
 const {storage,scope,pin,provider,sodium,keys,recipientDeviceId,signSelection,release,confirmedHead,confirmedGrantHash}=options;
 const operationId=release.proposal.item.event.proposalId;
 const reopen=()=>reopenAdultRemovalRecipient({...options,operationId});
 const prior=await reopen();
 if(prior)return prior;
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
   const {snapshot}=opened.documents[i].seed;
   documents.push({recipeId,sourceDocumentId,sourceRevision,documentId,bytes:snapshot,localKey});
   targets.push(await recipientTargetV2({provider,sodium,entry,slot,doc:opened.documents[i],key:opened.keys[i],wrapped:localKey.record.wrapped}));
  }
  const body=await recipientBodyV2({provider,sodium,scope,pin,operationId:item.event.proposalId,recipientDeviceId,eventHash:confirmedHead,grantHash:confirmedGrantHash,
   ciphertext:release.bytes,publisherProof:release.proof,publisherRecord:release.publisherRecord,expected:opened.expected,next:opened.record,selection:opened.selection,targets});
  const proof=domain('adult-removal-recipient-receipt-v2',body);
  const signature=hex(await signSelection(proof));
  if(!await verifySignature(provider,recipient.signingKeyRef,'adult-removal-recipient-receipt-v2',body,signature))throw Error('INVALID_SIGNER');
  let result;
  try { result=await storage.commitAdultRemovalRecipient({version:2,operationId:item.event.proposalId,recipientDeviceId,publisherProof:release.proof,manifestHash:release.proposal.grant.manifestHash,
   proof,signature,ciphertext:release.bytes,publisherRecord:release.publisherRecord,expected:opened.expected,next:opened.record,documents});
   if(!result.ok)throw Error(result.error.code);
  } catch(error) {
   const recovered=await reopen();
   if(recovered)return recovered;
   throw error;
  }
  return {head:opened.record.acceptedParent};
 });
}
