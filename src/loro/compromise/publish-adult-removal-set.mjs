import {authorityBytes} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {adultRemovalReleaseSize} from '../pairing/adult-removal-wire.mjs';
import {sealAdultRemovalFile} from '../pairing/adult-removal-file.mjs';
import {prepareAdultRemovalDocumentSet} from '../projection/current-document-set.mjs';
import {verifyAdultRemovalGrant} from './adult-removal-grant.mjs';
import {authorAdultRemovalSuccessor} from './adult-removal-successor.mjs';
import {digest,hex,verifySignature} from './revocation.mjs';

export async function adultRemovalKeySlot(provider, scope, manifest, deviceId, documentId) {
  const epochId = documentId === manifest.newDocumentId ? manifest.newEpochId :
    await digest(provider, 'adult-removal-recipe-key-slot-v1', {
      pin:manifest.rootPin, head:manifest.removalEventHash, epoch:manifest.newEpochId, documentId
    });
  const identity = {version:1, scope, deviceId, purpose:'data', epochId};
  const operationId = await digest(provider, 'adult-removal-document-key-operation-v1', {
    identity, head:manifest.removalEventHash, documentId
  });
  return {operationId,identity};
}

/** Publish only the exact, confirmed projection from the still-selected source.
 * Retained files require separate verification before they can be exported. */
export async function publishAdultRemovalDocumentSet({
  runtime,service,sodium,keys,signingKey,withSigningSecret,proposal,confirmation
}) {
  const {item,grant,manifest,recipientBindings}=structuredClone(proposal);
  const confirmed=structuredClone(confirmation);
  if(confirmed?.explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  const {storage,LoroDoc,authority}=runtime, {provider,rootPin:pin}=authority;
  const {scopeId,authorDevice:deviceId,branchHead}=runtime.scope;
  const scope={kind:'household',id:scopeId};
  const {record,state,nodes}=await verifyPublicParent(storage,scope,pin,provider);
  const parent=nodes.get(state.activeHead);
  const selected=await runtime.authorize();
  if(branchHead!==record.acceptedParent || selected.record?.revision!==record.revision ||
    selected.record.authorizationSnapshot!==record.authorizationSnapshot)throw Error('STALE_SOURCE');
  const options={provider,pin,parent,state,nodes,item,grant,manifest,recipientBindings,LoroDoc};
  const reviewed=await verifyAdultRemovalGrant(options);
  if(confirmed.eventHash!==reviewed.eventHash || confirmed.grantHash!==reviewed.grantHash ||
    item.event.authorDeviceId!==deviceId)throw Error('REVIEW_CHANGED');
  const allocations=new Map(manifest.entries.map(({sourceDocumentId,seedId,peerId})=>[sourceDocumentId,{seedId,peerId}]));
  const projected=await prepareAdultRemovalDocumentSet({runtime,service,item,allocateSeed:id=>allocations.get(id)});
  if(projected.manifestHash!==reviewed.manifestHash || hex(authorityBytes(projected.manifest))!==hex(authorityBytes(manifest)))
    throw Error('SOURCE_CHANGED');
  const successor=await authorAdultRemovalSuccessor({...options,record,documents:projected.documents,deviceId,signingKey});
  const operationId=item.event.proposalId;

  await sodium.ready;
  const dataKeys=[],documents=[],keyCommitments=[];
  try {
    for(const [index,entry] of manifest.entries.entries()){
      const {recipeId,sourceDocumentId,sourceRevision,documentId}=entry;
      const key=sodium.randombytes_buf(32);
      dataKeys.push(key);
      if(dataKeys.slice(0,-1).some(other=>sodium.memcmp(other,key)))throw Error('INVALID_KEYS');
      const slot=await adultRemovalKeySlot(provider,scope,manifest,deviceId,documentId);
      const localKey=await keys.preparePairedDataKey(slot.operationId,slot.identity,key);
      keyCommitments.push({documentId,...slot,keyHash:hex(sodium.crypto_generichash(32,key)),
        wrappedHash:await digest(provider,'adult-removal-wrapped-key-v1',hex(localKey.record.wrapped))});
      documents.push({recipeId,sourceDocumentId,sourceRevision,documentId,
        bytes:projected.documents[index].seed.snapshot,localKey});
    }
    const files=[],fileCommitments=[];
    await withSigningSecret(async signingSecret=>{
      for(const recipientDeviceId of grant.recipients){
        if(recipientDeviceId===deviceId)continue;
        const bytes=await sealAdultRemovalFile({...options,sodium,documents:projected.documents,
          keys:dataKeys,signingSecret,recipientId:recipientDeviceId});
        files.push({recipientDeviceId,bytes});
        fileCommitments.push({recipientDeviceId,fileHash:hex(sodium.crypto_generichash(32,bytes))});
      }
    });
    if(files.length!==grant.recipients.length-1)throw Error('INVALID_RECIPIENT');
    const body={version:1,operationId,scope,deviceId,parentSnapshot:record.authorizationSnapshot,
      nextSnapshot:successor.record.authorizationSnapshot,item,grant,manifest,recipientBindings,
      documents:projected.documents.map(({documentId,seed:{snapshot,...seed},policyBundle})=>({documentId,seed,policyBundle})),
      keyCommitments,fileCommitments};
    const purpose='adult-removal-publication-v1';
    const signature=hex(await provider.sign(signingKey,domain(purpose,body)));
    const author=parent.devices.find(device=>device.active&&device.deviceId===deviceId);
    if(!author || !await verifySignature(provider,author.signingKeyRef,purpose,body,signature))throw Error('INVALID_SIGNER');
    const proof=domain(purpose,{body,signature});
    for(const file of files)adultRemovalReleaseSize({bytes:file.bytes,proof,publisherRecord:successor.record,proposal:{item,grant,manifest,recipientBindings}});
    const committed=await storage.commitAdultRemovalPublication({
      version:1,operationId,sponsorDeviceId:deviceId,manifestHash:reviewed.manifestHash,
      proof,expected:record,next:successor.record,documents,files
    },projected.source);
    if(!committed.ok)throw Error(committed.error.code);
    return {operationId,head:successor.record.acceptedParent};
  } finally {
    for(const key of dataKeys)key.fill(0);
  }
}
