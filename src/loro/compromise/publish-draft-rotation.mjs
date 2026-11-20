import {domain} from '../authority/validator.mjs';
import {MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {sealDraftRotationFile} from '../pairing/draft-rotation-file.mjs';
import {draftRotationReleaseSize} from '../pairing/draft-rotation-wire.mjs';
import {verifyDraftRotationGrant} from './draft-rotation-grant.mjs';
import {prepareDraftRotationManifest} from './draft-rotation-manifest.mjs';
import {authorDraftRotationSuccessor} from './draft-rotation-successor.mjs';
import {digest,hex,verifySignature} from './revocation.mjs';
import {evidenceSha256,sameReportValue} from './report.mjs';
import {selectedDraftIdentity} from './selected-reconstruction.mjs';
import {normalizeSelectedEffectIds} from './selected-retention.mjs';

export const draftRotationPublicationPurpose='draft-rotation-publication-v1';
const maxRetainedCiphertextBytes=16*1024*1024;

const must=result=>{if(!result.ok)throw Error(result.error?.code??result.error);return result.value;};

export async function draftRotationKeySlot(provider,scope,manifest,deviceId,documentId){
 const head=manifest.revocationEventHash,epoch=manifest.newEpochId;
 const epochId=documentId===manifest.newDocumentId?epoch:
  await digest(provider,'draft-rotation-recipe-key-slot-v1',{pin:manifest.rootPin,head,epoch,documentId});
 const identity={version:1,scope,deviceId,purpose:'data',epochId};
 const operationId=await digest(provider,'draft-rotation-document-key-operation-v1',{identity,head,documentId});
 return {operationId,identity};
}

/** First publication only. The private transaction retains recipient files;
 * a separate authenticated release path must verify them before export. */
export async function publishDraftRotation({runtime,sodium,keys,signingKey,withSigningSecret,binding,proposal,confirmation}){
 const {item,grant,manifest,recipientBindings}=structuredClone(proposal);
 binding=structuredClone(binding);
 confirmation=structuredClone(confirmation);
 if(confirmation?.explicit!==true)throw Error('CONFIRMATION_REQUIRED');
 const {storage,LoroDoc,authority}=runtime,{provider,rootPin:pin}=authority;
 const {scopeId,authorDevice:deviceId,branchHead}=runtime.scope;
 const scope={kind:'household',id:scopeId};
 const {record,state,nodes}=await verifyPublicParent(storage,scope,pin,provider);
 const parent=nodes.get(state.activeHead),selected=await runtime.authorize();
 if(branchHead!==record.acceptedParent||selected.record?.revision!==record.revision||
    selected.record.authorizationSnapshot!==record.authorizationSnapshot)throw Error('STALE_SOURCE');

 const options={provider,pin,parent,state,nodes,item,grant,manifest,recipientBindings,LoroDoc};
 const reviewed=await verifyDraftRotationGrant(options);
 if(confirmation.eventHash!==reviewed.eventHash||confirmation.grantHash!==reviewed.grantHash||
    item.event.authorDeviceId!==deviceId)throw Error('REVIEW_CHANGED');

 const {draftId,reportHash}=binding;
 const draft=must(await storage.readSelectedRetention(scopeId,draftId));
 const frozen=must(await storage.readSelectedOperationReport(scopeId,reportHash));
 if(!draft||!frozen||draft.reportHash!==reportHash||draft.scopeId!==scopeId||draft.draftId!==draftId)throw Error('INVALID_DRAFT_SOURCE');
 const selectedEffectIds=normalizeSelectedEffectIds(draft.selectedEffectIds);
 if(!sameReportValue(selectedEffectIds,draft.selectedEffectIds)||
    await selectedDraftIdentity(scopeId,reportHash,selectedEffectIds)!==draftId||
    await evidenceSha256(frozen.record.reportBytes)!==reportHash)throw Error('INVALID_DRAFT_SOURCE');
 const {objects}=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frozen.record.reportBytes)).payload;
 if(!Array.isArray(objects)||objects.length!==frozen.objects.length)throw Error('INVALID_DRAFT_SOURCE');
 for(const [index,{documentId,objectId,bytes}] of frozen.objects.entries()){
  const expected=objects[index];
  if(expected?.documentId!==documentId||expected.objectId!==objectId||
     expected.digest!==await evidenceSha256(bytes))throw Error('INVALID_DRAFT_SOURCE');
 }
 const allocations=new Map(manifest.entries.map(({sourceDocumentId,seedId,peerId})=>[sourceDocumentId,{seedId,peerId}]));
 const projected=await prepareDraftRotationManifest({runtime,binding,item,allocateSeed:id=>allocations.get(id)});
 if(projected.manifestHash!==reviewed.manifestHash||!sameReportValue(projected.manifest,manifest)||
    !sameReportValue(projected.source,draft.guard))throw Error('SOURCE_CHANGED');
 const successor=await authorDraftRotationSuccessor({...options,record,documents:projected.documents,deviceId,signingKey});
 const operationId=item.event.proposalId;
 const dataKeys=[],documents=[],keyCommitments=[],files=[],fileCommitments=[];
 await sodium.ready;
 try{
  for(const [index,entry] of manifest.entries.entries()){
   const {recipeId,sourceDocumentId,sourceRevision,documentId}=entry;
   const key=sodium.randombytes_buf(32);
   dataKeys.push(key);
   if(dataKeys.slice(0,-1).some(other=>sodium.memcmp(other,key)))throw Error('INVALID_KEYS');
   const slot=await draftRotationKeySlot(provider,scope,manifest,deviceId,documentId);
   const localKey=await keys.preparePairedDataKey(slot.operationId,slot.identity,key);
   keyCommitments.push({documentId,...slot,keyHash:hex(sodium.crypto_generichash(32,key)),
    wrappedHash:await digest(provider,'draft-rotation-wrapped-key-v1',hex(localKey.record.wrapped))});
   documents.push({recipeId,sourceDocumentId,sourceRevision,documentId,bytes:projected.documents[index].seed.snapshot,localKey});
  }
  let retainedBytes=0;
  await withSigningSecret(async signingSecret=>{
   for(const recipientDeviceId of grant.recipients){
    if(recipientDeviceId===deviceId)continue;
    const bytes=await sealDraftRotationFile({...options,sodium,documents:projected.documents,keys:dataKeys,signingSecret,recipientId:recipientDeviceId});
    retainedBytes+=bytes.length;
    if(retainedBytes>maxRetainedCiphertextBytes)throw Error('TOO_LARGE');
    files.push({recipientDeviceId,bytes});
    fileCommitments.push({recipientDeviceId,fileHash:hex(sodium.crypto_generichash(32,bytes))});
   }
  });
  if(files.length!==grant.recipients.length-1)throw Error('INVALID_RECIPIENT');
  const body={version:1,operationId,scope,deviceId,parentSnapshot:record.authorizationSnapshot,
   nextSnapshot:successor.record.authorizationSnapshot,item,grant,manifest,recipientBindings,
   documents:projected.documents.map(({documentId,seed:{snapshot,...seed},policyBundle})=>({documentId,seed,policyBundle})),
   keyCommitments,fileCommitments};
  const signature=hex(await provider.sign(signingKey,domain(draftRotationPublicationPurpose,body)));
  const author=parent.devices.find(d=>d.active&&d.deviceId===deviceId);
  if(!author||!await verifySignature(provider,author.signingKeyRef,draftRotationPublicationPurpose,body,signature))throw Error('INVALID_SIGNER');
  const proof=domain(draftRotationPublicationPurpose,{body,signature});
  if(proof.length+documents.reduce((size,doc)=>size+doc.bytes.length,0)>MAX_SELECTED_SET_BYTES)throw Error('TOO_LARGE');
  for(const file of files)draftRotationReleaseSize({bytes:file.bytes,proof,publisherRecord:successor.record,proposal:{item,grant,manifest,recipientBindings}});

  must(await storage.commitDraftRotationPublication({version:1,operationId,sponsorDeviceId:deviceId,
   manifestHash:reviewed.manifestHash,proof,expected:record,next:successor.record,documents,files},projected.source,
   {draftId,reportHash,draft,frozen}));
  return {operationId,head:successor.record.acceptedParent};
 }finally{
  for(const key of dataKeys)key.fill(0);
 }
}
