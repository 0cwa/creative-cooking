import {authorityBytes} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {adultRemovalKeySlot} from './publish-adult-removal-set.mjs';
import {verifyRetainedAdultRemovalSuccessor} from './adult-removal-successor.mjs';
import {digest,hex,verifySignature} from './revocation.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));
const must=r=>{if(!r.ok)throw Error('INVALID_RECEIPT');return r.value};
const fields=(o,names)=>o && typeof o==='object' && !Array.isArray(o) && same(Object.keys(o).sort(),names.slice().sort());

async function verifyPublication({storage,scope,operationId,pin,provider,sodium,LoroDoc,keys}) {
 scope=structuredClone(scope);
 const saved=must(await storage.readAdultRemovalPublication(scope.id,operationId));
 if(!saved || !fields(saved,['version','operationId','sponsorDeviceId','manifestHash','proof','expected','next','documents','files']) || saved.version!==1 || saved.operationId!==operationId || !same(saved.expected.scope,scope))throw Error('INVALID_RECEIPT');
 let envelope;
 try { envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(saved.proof)); } catch { throw Error('INVALID_PROOF'); }
 if(!Array.isArray(envelope)||envelope.length!==3 || envelope[0]!=='creative-cooking/authority-candidate/v1' || envelope[1]!=='adult-removal-publication-v1' || !fields(envelope[2],['body','signature']) || !same(saved.proof,domain(envelope[1],envelope[2])))throw Error('INVALID_PROOF');
 const {body,signature}=envelope[2];
 if(!fields(body,['version','operationId','scope','deviceId','parentSnapshot','nextSnapshot','item','grant','manifest','recipientBindings','documents','keyCommitments','fileCommitments']) || body.version!==1 || body.operationId!==operationId || !same(body.scope,scope) || body.deviceId!==saved.sponsorDeviceId || body.parentSnapshot!==saved.expected.authorizationSnapshot || body.nextSnapshot!==saved.next.authorizationSnapshot || saved.manifestHash!==body.grant?.manifestHash)throw Error('INVALID_PROOF');
 const parentStore={readPairingAuthority:async()=>({ok:true,value:saved.expected})};
 const {state,nodes}=await verifyPublicParent(parentStore,scope,pin,provider);
 const author=nodes.get(state.activeHead).devices.find(d=>d.active&&d.deviceId===body.deviceId);
 if(!author || !await verifySignature(provider,author.signingKeyRef,'adult-removal-publication-v1',body,signature))throw Error('INVALID_PROOF');
 if(!Array.isArray(body.documents)||!Array.isArray(saved.documents)||body.documents.length!==saved.documents.length || body.documents.length!==body.manifest.entries.length || !Array.isArray(body.keyCommitments)||body.keyCommitments.length!==saved.documents.length)throw Error('INVALID_RECEIPT');
 const documents=body.documents.map((d,i)=>({...d,seed:{...d.seed,snapshot:saved.documents[i].bytes}}));
 const successor=await verifyRetainedAdultRemovalSuccessor({record:saved.expected,next:saved.next,pin,provider,deviceId:body.deviceId,item:body.item,grant:body.grant,manifest:body.manifest,recipientBindings:body.recipientBindings,documents,LoroDoc});
 const members=[];
 for(const [i,d] of saved.documents.entries()) {
  const entry=body.manifest.entries[i], commitment=body.keyCommitments[i];
  if(!same({recipeId:d.recipeId,sourceDocumentId:d.sourceDocumentId,sourceRevision:d.sourceRevision,documentId:d.documentId},{recipeId:entry.recipeId,sourceDocumentId:entry.sourceDocumentId,sourceRevision:entry.sourceRevision,documentId:entry.documentId}) || documents[i].documentId!==d.documentId)throw Error('INVALID_RECEIPT');
  const slot=await adultRemovalKeySlot(provider,scope,body.manifest,body.deviceId,d.documentId);
  if(!fields(commitment,['documentId','operationId','identity','keyHash','wrappedHash']) || commitment.documentId!==d.documentId || !same(slot,{operationId:commitment.operationId,identity:commitment.identity}) || !same(slot,{operationId:d.localKey.record.operationId,identity:d.localKey.record.identity}) || commitment.wrappedHash!==await digest(provider,'adult-removal-wrapped-key-v1',hex(d.localKey.record.wrapped)))throw Error('INVALID_KEY');
  await keys.use(slot.operationId,slot.identity,key=>{if(commitment.keyHash!==hex(sodium.crypto_generichash(32,key)))throw Error('INVALID_KEY')});
  members.push({recipeId:entry.recipeId,documentId:entry.documentId,seed:documents[i].seed,keySlot:slot});
 }
 const recipients=body.grant.recipients.filter(id=>id!==body.deviceId);
 if(!Array.isArray(saved.files)||!Array.isArray(body.fileCommitments)||saved.files.length!==recipients.length||body.fileCommitments.length!==recipients.length)throw Error('INVALID_RECEIPT');
 for(const [i,id] of recipients.entries()) {
  const file=saved.files[i], commitment=body.fileCommitments[i];
  if(!fields(file,['recipientDeviceId','bytes']) || !fields(commitment,['recipientDeviceId','fileHash']) || file.recipientDeviceId!==id || commitment.recipientDeviceId!==id || commitment.fileHash!==hex(sodium.crypto_generichash(32,file.bytes)))throw Error('INVALID_FILE');
 }
 if(!same(must(await storage.readPairingAuthority(scope)),saved.next))throw Error('STALE_AUTHORITY');
 return {saved,body,recipients,metadata:{record:saved.next,child:successor.child,members}};
}

/** Authenticate the sponsor's retained publication without releasing any file. */
export async function reopenAdultRemovalSponsor(options) {
 const checked=await verifyPublication(options);
 if(options.deviceId!==checked.body.deviceId)throw Error('INVALID_RECIPIENT');
 return structuredClone(checked.metadata);
}

/** Authenticate a retained publication before releasing one addressed ciphertext. */
export async function releaseAdultRemoval(options) {
 const {saved,body,recipients}=await verifyPublication(options), {recipientDeviceId}=options;
 if(recipientDeviceId===body.deviceId || !recipients.includes(recipientDeviceId))throw Error('INVALID_RECIPIENT');
 return {bytes:saved.files[recipients.indexOf(recipientDeviceId)].bytes.slice(),proof:saved.proof.slice(),proposal:{item:body.item,grant:body.grant,manifest:body.manifest,recipientBindings:body.recipientBindings},publisherRecord:saved.next};
}
