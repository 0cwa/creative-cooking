import {MAX_SELECTED_CHILDREN} from '../contracts/runtime-storage.ts';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {exact,sameOwnDevice} from './household-own-device.mjs';
import {makeKeyPackage,verifyStoredKeyPackage,withOpenedKeyPackage} from './key-package.mjs';
import {openDeviceCopy,sealDeviceCopy} from './personal-copy.mjs';
import {verifyOwnDeviceRecipients} from './household-own-device-recipients.mjs';

const fileDomain='household-own-device-established-file-v1';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');

/** Trusted-call boundary: checked must be the freshly verified complete successor
 * and copy set against an independent parent; recipient must be the matching result
 * of verifyOwnDeviceRecipients over that same successor and parent. Evidence must
 * be the completed local ceremony used in that verification. No persistence or
 * authorization is performed here. Repeat verification before every call. */
async function contexts({sodium,provider,checked,recipient,evidence}) {
 const t=evidence?.transcript,c=checked?.context,docs=checked?.documents;
 if(!c||!Array.isArray(docs)||!docs.length||docs.length>MAX_SELECTED_CHILDREN+1||!recipient||
    recipient.deviceId!==t?.responder?.deviceId||recipient.guardId!==evidence.guard?.guardId||
    recipient.transcriptHash!==evidence.oob?.hash||recipient.wrappingKeyRef!==hex(t.responder.wrappingPublicKey)||
    t.initiator.deviceId!==c.senderDevice||hex(t.initiator.signingPublicKey)!==c.senderSigningKey||
    checked.head!==c.grantHash||new Set(docs.map(d=>d.targetDocumentId)).size!==docs.length)
  throw Error('INVALID_PROOF');
 return Promise.all(docs.map(async d=>({
  ...c,transcriptHash:recipient.transcriptHash,senderDevice:t.initiator.deviceId,
  senderSigningKey:hex(t.initiator.signingPublicKey),senderWrappingKey:hex(t.initiator.wrappingPublicKey),
  recipientDevice:recipient.deviceId,recipientSigningKey:hex(t.responder.signingPublicKey),recipientWrappingKey:recipient.wrappingKeyRef,
  projectionId:d.targetDocumentId,releaseId:await selectedSourceHash(provider,'household-own-device-established-document-release-v1',{
   head:checked.head,copyHash:c.manifestHash,documentId:d.targetDocumentId,recipientDevice:recipient.deviceId,transcriptHash:recipient.transcriptHash
  })
 })));
}

export async function sealEstablishedOwnDeviceFile({sodium,provider,checked,recipient,evidence,signingSecret,withDocumentKey}) {
 const cs=await contexts({sodium,provider,checked,recipient,evidence});
 if(hex(signingSecret.subarray(32))!==cs[0].senderSigningKey)throw Error('INVALID_KEY');
 const packets=[];
 for(const [i,c] of cs.entries()) {
  const packet=await withDocumentKey(checked.documents[i].targetDocumentId,key=>makeKeyPackage(sodium,c,key,signingSecret));
  verifyStoredKeyPackage(sodium,packet,c);packets.push(packet);
 }
 return sealDeviceCopy(sodium,fileDomain,recipient.transcriptHash,evidence.transcript.responder,signingSecret,
  {version:1,head:checked.head,copyHash:checked.context.manifestHash,documents:checked.documents,packets});
}

/** Recheck every ceremony before constructing packets. The caller invokes packetFor
 * once per document inside prepareForAtomicInstall, then seals only after all
 * documents have packets. These transient files must not be offered before an
 * atomic publication retains them. Installation still needs an independently
 * verified successor and copy set; the established file does not carry those. */
export async function prepareEstablishedOwnDeviceFanout({sodium,provider,checked,parent,authorizationSnapshot,evidence,signingSecret}) {
 const proofs=structuredClone(evidence);
 const recipients=await verifyOwnDeviceRecipients({sodium,provider,successor:checked,parent,authorizationSnapshot,evidence:proofs});
 const routes=await Promise.all(recipients.map(async recipient=>{
  const proof=proofs.find(e=>e.context.recipientDeviceId===recipient.deviceId);
  const cs=await contexts({sodium,provider,checked,recipient,evidence:proof});
  if(hex(signingSecret.subarray(32))!==cs[0].senderSigningKey)throw Error('INVALID_KEY');
  return {recipient,proof,cs};
 }));
 return {
  packetFor(index,key) {
   if(!Number.isInteger(index)||index<0||index>=checked.documents.length)throw Error('INVALID_PROOF');
   return routes.map(({cs})=>{
    const packet=makeKeyPackage(sodium,cs[index],key,signingSecret);
    verifyStoredKeyPackage(sodium,packet,cs[index]);
    return packet;
   });
  },
  seal(packets) {
   if(!Array.isArray(packets)||packets.length!==checked.documents.length||
      packets.some(row=>!Array.isArray(row)||row.length!==routes.length))throw Error('INVALID_PROOF');
   return routes.map(({recipient,proof,cs},i)=>{
    const selected=packets.map(row=>row[i]);
    selected.forEach((packet,j)=>verifyStoredKeyPackage(sodium,packet,cs[j]));
    return {recipient,file:sealDeviceCopy(sodium,fileDomain,recipient.transcriptHash,proof.transcript.responder,signingSecret,
     {version:1,head:checked.head,copyHash:checked.context.manifestHash,documents:checked.documents,packets:selected})};
   });
  }
 };
}

/** The callback receives ephemeral keys only after the entire file matches the
 * independently verified copies and every packet has passed verification. */
export async function withOpenedEstablishedOwnDeviceFile({sodium,provider,checked,recipient,evidence,file,wrappingSecret,withKeys}) {
 const cs=await contexts({sodium,provider,checked,recipient,evidence});
 if(hex(sodium.crypto_scalarmult_base(wrappingSecret))!==recipient.wrappingKeyRef)throw Error('INVALID_KEY');
 const contents=openDeviceCopy(sodium,fileDomain,file,recipient.transcriptHash,evidence.transcript,wrappingSecret);
 if(!exact(contents,['version','head','copyHash','documents','packets'])||contents.version!==1||contents.head!==checked.head||
    contents.copyHash!==checked.context.manifestHash||!sameOwnDevice(sodium,contents.documents,checked.documents)||
    !Array.isArray(contents.packets)||contents.packets.length!==cs.length)throw Error('INVALID_FILE');
 for(const [i,c] of cs.entries())verifyStoredKeyPackage(sodium,contents.packets[i],c);
 const keys=[];
 const open=i=>i===cs.length?withKeys(keys):withOpenedKeyPackage(sodium,contents.packets[i],cs[i],wrappingSecret,key=>{
  keys.push({documentId:cs[i].projectionId,key});return open(i+1);
 });
 return open(0);
}
