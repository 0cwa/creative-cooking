import {verifyDraftRotationGrant} from '../compromise/draft-rotation-grant.mjs';
import {verifyDocuments} from '../projection/current-document-set.mjs';
import {digest} from '../compromise/revocation.mjs';
import {makeKeyPackage,withOpenedKeyPackage} from './key-package.mjs';
import {sealDeviceCopy,openDeviceCopy} from './personal-copy.mjs';

const fileDomain='draft-rotation-document-set-file-v1';

async function context(options,recipientId) {
 const {sodium,provider,pin,parent,item,grant,manifest,recipientBindings}=options;
 const checked=await verifyDraftRotationGrant({...options,requireQuorum:true});
 const senderId=item.event.authorDeviceId, index=grant.recipients.indexOf(recipientId), senderIndex=grant.recipients.indexOf(senderId);
 if(index<0 || senderIndex<0 || index===senderIndex) throw Error('INVALID_RECIPIENT');
 const sender=parent.devices.find(d=>d.active && d.deviceId===senderId), recipient=parent.devices.find(d=>d.active && d.deviceId===recipientId);
 if(!sender || !recipient) throw Error('INVALID_RECIPIENT');
 const senderBinding=recipientBindings[senderIndex], recipientBinding=recipientBindings[index];
 const binding={scope:parent.householdId,pin,parentHead:parent.head,manifestHash:checked.manifestHash,grantHash:checked.grantHash,
  successorHead:checked.eventHash,sender:senderId,senderSigningKey:sender.signingKeyRef,senderWrappingKey:senderBinding.wrappingKey,
  recipient:recipientId,recipientSigningKey:recipient.signingKeyRef,recipientWrappingKey:recipientBinding.wrappingKey,packageRef:grant.packageRefs[index]};
 const hash=await digest(provider,'draft-rotation-file-binding-v1',binding);
 const contexts=manifest.entries.map(entry=>({version:1,transcriptHash:hash,releaseId:binding.packageRef,scopeKind:'household',scopeId:parent.householdId,
  purpose:'draft-rotation-document',epochId:manifest.newEpochId,generation:manifest.newGeneration,senderDevice:senderId,
  senderSigningKey:binding.senderSigningKey,senderWrappingKey:binding.senderWrappingKey,recipientDevice:recipientId,
  recipientSigningKey:binding.recipientSigningKey,recipientWrappingKey:binding.recipientWrappingKey,policyHash:parent.policyHash,
  grantHash:checked.grantHash,projectionId:entry.documentId,manifestHash:checked.manifestHash}));
 return {hash,contexts,sender:sodium.from_hex(binding.senderSigningKey),recipient:sodium.from_hex(binding.recipientWrappingKey)};
}

// A publisher must retain the returned ciphertext privately until its transaction commits.
export async function sealDraftRotationFile(options) {
 const {sodium,documents,keys,signingSecret,recipientId}=options;
 const c=await context(options,recipientId);
 await verifyDocuments(options);
 if(!(signingSecret instanceof Uint8Array) || !sodium.crypto_sign_verify_detached(sodium.crypto_sign_detached(new TextEncoder().encode(c.hash),signingSecret),new TextEncoder().encode(c.hash),c.sender)) throw Error('INVALID_SENDER');
 if(!Array.isArray(keys) || keys.length!==c.contexts.length || keys.some(k=>!(k instanceof Uint8Array)||k.length!==32) || new Set(keys.map(k=>sodium.to_hex(k))).size!==keys.length) throw Error('INVALID_KEYS');
 const packets=keys.map((key,i)=>makeKeyPackage(sodium,c.contexts[i],key,signingSecret));
 return sealDeviceCopy(sodium,fileDomain,c.hash,{wrappingPublicKey:c.recipient},signingSecret,{documents,packets});
}

export async function withOpenedDraftRotationFile(options,callback) {
 const {sodium,file,wrappingSecret,recipientId}=options;
 if(typeof callback!=='function') throw Error('MALFORMED');
 const c=await context(options,recipientId);
 if(!(wrappingSecret instanceof Uint8Array) || !sodium.memcmp(sodium.crypto_scalarmult_base(wrappingSecret),c.recipient)) throw Error('INVALID_RECIPIENT');
 const contents=openDeviceCopy(sodium,fileDomain,file,c.hash,{initiator:{signingPublicKey:c.sender},responder:{wrappingPublicKey:c.recipient}},wrappingSecret);
 if(!contents || Object.keys(contents).sort().join(',')!=='documents,packets' || !Array.isArray(contents.packets) || contents.packets.length!==c.contexts.length) throw Error('INVALID_FILE');
 await verifyDocuments({...options,documents:contents.documents});
 const keys=[];
 const open=i=>i===c.contexts.length?callback({documents:contents.documents,keys}):withOpenedKeyPackage(sodium,contents.packets[i],c.contexts[i],wrappingSecret,key=>{
  if(keys.some(previous=>sodium.memcmp(previous,key))) throw Error('INVALID_KEYS');
  keys.push(key); return open(i+1);
 });
 return open(0);
}
