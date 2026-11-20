import {reopenDraftRotationRecipient} from './reopen-draft-rotation.mjs';
import {domain} from '../authority/validator.mjs';
import {recipientBodyV2,recipientTargetV2} from './adult-removal-receipt.mjs';
import {withOpenedDraftRotationRelease} from './open-draft-rotation.mjs';
import {draftRotationKeySlot} from './publish-draft-rotation.mjs';
import {hex,verifySignature} from './revocation.mjs';

export const draftRotationRecipientPurpose='draft-rotation-recipient-receipt-v2';

/** First write only. The opener scopes access to keys and authenticates both histories. */
export async function installDraftRotationRelease(options){
 const scope=structuredClone(options.scope),release=structuredClone(options.release);
 const {storage,pin,provider,sodium,keys,recipientDeviceId,recipientAdultId,signSelection,
  confirmedHead,confirmedGrantHash}=options;
 const operationId=release.proposal.item.event.proposalId;
 const reopen=()=>reopenDraftRotationRecipient({...options,scope,release,operationId});
 const prior=await reopen();
 if(prior)return prior;
 if(typeof signSelection!=='function')throw Error('INVALID_SIGNER');
 return withOpenedDraftRotationRelease({...options,scope,release},async opened=>{
  const recipient=opened.child.devices.find(device=>device.active&&device.deviceId===recipientDeviceId&&device.adultId===recipientAdultId);
  if(!recipient)throw Error('INVALID_RECIPIENT');
  const {manifest,item}=release.proposal,operationId=item.event.proposalId,documents=[],targets=[];
  for(const [i,entry] of manifest.entries.entries()){
   const {recipeId,sourceDocumentId,sourceRevision,documentId}=entry;
   const slot=await draftRotationKeySlot(provider,scope,manifest,recipientDeviceId,documentId);
   const localKey=await keys.preparePairedDataKey(slot.operationId,slot.identity,opened.keys[i]);
   const doc=opened.documents[i];
   documents.push({recipeId,sourceDocumentId,sourceRevision,documentId,bytes:doc.seed.snapshot,localKey});
   targets.push(await recipientTargetV2({provider,sodium,entry,slot,doc,key:opened.keys[i],
    wrapped:localKey.record.wrapped},'draft-rotation'));
  }
  const body=await recipientBodyV2({provider,sodium,scope,pin,operationId,recipientDeviceId,
   eventHash:confirmedHead,grantHash:confirmedGrantHash,ciphertext:release.bytes,publisherProof:release.proof,
   publisherRecord:release.publisherRecord,expected:opened.expected,next:opened.record,selection:opened.selection,targets},'draft-rotation');
  const proof=domain(draftRotationRecipientPurpose,body),signed=await signSelection(proof);
  if(!(signed instanceof Uint8Array)||signed.length!==64)throw Error('INVALID_SIGNER');
  const signature=hex(signed);
  if(!await verifySignature(provider,recipient.signingKeyRef,draftRotationRecipientPurpose,body,signature))throw Error('INVALID_SIGNER');
  let result;
  try { result=await storage.commitDraftRotationRecipient({version:2,operationId,recipientDeviceId,
   publisherProof:release.proof,manifestHash:release.proposal.grant.manifestHash,proof,signature,ciphertext:release.bytes,
   publisherRecord:release.publisherRecord,expected:opened.expected,next:opened.record,documents});
  if(!result.ok)throw Error(result.error?.code??result.error);
  } catch(error) { const recovered=await reopen(); if(recovered)return recovered; throw error; }
  return {head:opened.record.acceptedParent};
 });
}
