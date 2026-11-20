import {authorityBytes} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {draftRotationKeySlot} from './publish-draft-rotation.mjs';
import {withOpenedDraftRotationRelease} from './open-draft-rotation.mjs';
import {bytesCommitment,recipientTargetV2,recipientBodyV2} from './adult-removal-receipt.mjs';
import {hex,verifySignature} from './revocation.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));
const read=r=>{if(!r.ok)throw Error('INVALID_RECEIPT');return r.value};

/** Reverify the retained recipient receipt and its exact current rows, without writes. */
export async function verifyRetainedDraftRotationRecipient({storage,scope,operationId,pin,provider,sodium,LoroDoc,keys,wrappingSecret,recipientDeviceId,recipientAdultId,release,localSelection,confirmedHead,confirmedGrantHash,expectedRevision}) {
 ({scope,release}=structuredClone({scope,release}));
 const saved=read(await storage.readDraftRotationRecipient(scope.id,operationId));
 if(!saved)return null;
 let envelope,publisher;
 try {envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(saved.proof));}catch{throw Error('INVALID_PROOF');}
 const body=envelope?.[2],purpose=`draft-rotation-recipient-receipt-v${saved.version}`;
 if(saved.version!==2||!Array.isArray(envelope)||envelope.length!==3||envelope[0]!=='creative-cooking/authority-candidate/v1'||envelope[1]!==purpose||body?.version!==saved.version||!same(saved.proof,domain(purpose,body)))throw Error('INVALID_PROOF');
 const view={readPairingAuthority:async()=>({ok:true,value:structuredClone(saved.expected)})};
 const local=await verifyPublicParent(view,scope,pin,provider);
 const recipient=local.nodes.get(local.state.activeHead).devices.find(d=>d.active&&d.deviceId===recipientDeviceId);
 if(!recipient||saved.recipientDeviceId!==recipientDeviceId||!await verifySignature(provider,recipient.signingKeyRef,envelope[1],body,saved.signature))throw Error('INVALID_PROOF');
 const publisherProof=saved.publisherProof;
 if(body.publisherProofHash!==await bytesCommitment(provider,'draft-rotation-publisher-proof-v2',publisherProof))throw Error('INVALID_PROOF');
 try {publisher=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(publisherProof))[2].body;}catch{throw Error('INVALID_PROOF');}
 const proposal={item:publisher.item,grant:publisher.grant,manifest:publisher.manifest,recipientBindings:publisher.recipientBindings};
 const retainedRelease={bytes:saved.ciphertext,proof:publisherProof,publisherRecord:saved.publisherRecord,proposal};
 if((release && !same(release,retainedRelease)) || (localSelection && !same(localSelection,body.selection)))throw Error('RETRY_MISMATCH');
 expectedRevision ??= saved.expected.revision; confirmedHead ??= body.eventHash; confirmedGrantHash ??= body.grantHash;
 if(expectedRevision!==saved.expected.revision || confirmedHead!==body.eventHash || confirmedGrantHash!==body.grantHash || operationId!==body.operationId || saved.manifestHash!==proposal.grant.manifestHash)throw Error('RETRY_MISMATCH');
 return withOpenedDraftRotationRelease({storage:view,scope,pin,provider,sodium,LoroDoc,release:retainedRelease,recipientDeviceId,recipientAdultId,wrappingSecret,localSelection:body.selection,confirmedHead,confirmedGrantHash,expectedRevision},async opened=>{
  if(!same(opened.record,saved.next)||!same(opened.expected,saved.expected)||opened.documents.length!==saved.documents.length)throw Error('INVALID_RECEIPT');
  const targets=[],members=[];
  for(const [i,entry] of proposal.manifest.entries.entries()){
   const {recipeId,sourceDocumentId,sourceRevision,documentId}=entry, d=saved.documents[i], doc=opened.documents[i];
   const slot=await draftRotationKeySlot(provider,scope,proposal.manifest,recipientDeviceId,documentId);
   if(!same({recipeId,sourceDocumentId,sourceRevision,documentId},{recipeId:d.recipeId,sourceDocumentId:d.sourceDocumentId,sourceRevision:d.sourceRevision,documentId:d.documentId}) || !same(doc.seed.snapshot,d.bytes) || !same(slot,{operationId:d.localKey.record.operationId,identity:d.localKey.record.identity}))throw Error('INVALID_RECEIPT');
   await keys.use(slot.operationId,slot.identity,key=>{if(!sodium.memcmp(key,opened.keys[i]))throw Error('INVALID_KEY')});
   members.push({recipeId,documentId,seed:doc.seed,keySlot:slot});
   targets.push(await recipientTargetV2({provider,sodium,entry,slot,doc,key:opened.keys[i],wrapped:d.localKey.record.wrapped},'draft-rotation'));
  }
  const expectedBody=await recipientBodyV2({provider,sodium,scope,pin,operationId,recipientDeviceId,eventHash:confirmedHead,grantHash:confirmedGrantHash,
   ciphertext:saved.ciphertext,publisherProof,publisherRecord:saved.publisherRecord,expected:saved.expected,next:saved.next,selection:opened.selection,targets},'draft-rotation');
  if(!same(body,expectedBody))throw Error('INVALID_RECEIPT');
  const now=read(await storage.readPairingAuthority(scope));
  if(!same(now,saved.next))throw Error('STALE_AUTHORITY');
  return structuredClone({record:saved.next,child:opened.child,members});
 });
}

/** Preserve the exact-retry result shape while authenticating retained evidence. */
export async function reopenDraftRotationRecipient(options) {
 if(typeof options.confirmedHead!=='string'||typeof options.confirmedGrantHash!=='string'||!Number.isSafeInteger(options.expectedRevision))throw Error('RETRY_MISMATCH');
 const verified=await verifyRetainedDraftRotationRecipient(options);
 return verified?{head:verified.record.acceptedParent}:null;
}
