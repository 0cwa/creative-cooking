import {digest,hex} from './revocation.mjs';

export async function bytesCommitment(provider,purpose,bytes){
 const hash=await provider.hash(bytes);
 if(!(hash instanceof Uint8Array)||hash.length!==32)throw Error('INVALID_PROOF');
 return digest(provider,purpose,{length:bytes.length,hash:hex(hash)});
}
async function recordCommitment(provider,record,purpose){
 return digest(provider,purpose+'-recipient-record-v2',{scope:record.scope,revision:record.revision,
  acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot,
  authorityState:await bytesCommitment(provider,purpose+'-authority-bytes-v2',record.authorityState)});
}
export async function recipientTargetV2({provider,sodium,entry,slot,doc,key,wrapped},purpose='adult-removal') {
 const {snapshot,...seed}=doc.seed;
 return {recipeId:entry.recipeId,sourceDocumentId:entry.sourceDocumentId,sourceRevision:entry.sourceRevision,documentId:entry.documentId,...slot,
  seedHash:await digest(provider,purpose+'-seed-metadata-v2',seed),
  policyBundleHash:await digest(provider,purpose+'-policy-bundle-v2',doc.policyBundle),
  snapshotHash:hex(sodium.crypto_generichash(32,snapshot)),keyHash:hex(sodium.crypto_generichash(32,key)),
  wrappedHash:await digest(provider,purpose+'-wrapped-key-v1',hex(wrapped))};
}
export async function recipientBodyV2({provider,sodium,scope,pin,operationId,recipientDeviceId,eventHash,grantHash,ciphertext,publisherProof,publisherRecord,expected,next,selection,targets},purpose='adult-removal') {
 return {version:2,scope,rootPin:pin,operationId,recipientDeviceId,eventHash,grantHash,
  ciphertextHash:hex(sodium.crypto_generichash(32,ciphertext)),
  publisherProofHash:await bytesCommitment(provider,purpose+'-publisher-proof-v2',publisherProof),
  publisherRecordHash:await recordCommitment(provider,publisherRecord,purpose),expectedHash:await recordCommitment(provider,expected,purpose),
  nextHash:await recordCommitment(provider,next,purpose),selection,targets};
}
