import {MAX_SELECTED_CHILDREN} from '../contracts/runtime-storage.ts';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {exact,sameOwnDevice} from './household-own-device.mjs';
import {makeKeyPackage,verifyStoredKeyPackage,withOpenedKeyPackage} from './key-package.mjs';
import {MAX_PERSONAL_PAIRING_FILE,openDeviceCopy,sealDeviceCopy} from './personal-copy.mjs';
import {authorityBytes,snapshotId,verifyAuthority} from '../authority/chain.mjs';
import {checkExistingRecipientCeremonies} from '../authority/ceremony.mjs';
import {verifyOwnDeviceLocalTransition} from './household-own-device-local-transition.mjs';
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
 * atomic publication retains them. Version 3 carries the publisher parent and
 * transition inside the encrypted file for independent verification. */
export async function prepareEstablishedOwnDeviceFanout({sodium,provider,checked,parent,authorizationSnapshot,evidence,signingSecret,transition}) {
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
     transition ? {version:3,...transition,packets:selected} :
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

/** Open a released file using only locally retained authority and a completed local ceremony.
 * Version 2 requires the exact parent. Version 3 can verify a separate local
 * selection at the same authenticated head; callers must explicitly install it. */
export async function withOpenedEstablishedOwnDeviceTransition({sodium,provider,pin,parentRecord,evidence,file,wrappingSecret,withKeys,signingSecret,localSelection,...options}) {
 if(!(file instanceof Uint8Array)||file.length<=112||file.length>MAX_PERSONAL_PAIRING_FILE)throw Error('INVALID_FILE');
 parentRecord=structuredClone(parentRecord); evidence=structuredClone(evidence); file=new Uint8Array(file);
 const secret=new Uint8Array(wrappingSecret);
 try {
  const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(parentRecord.authorityState));
  if(!sameOwnDevice(sodium,authorityBytes(state),parentRecord.authorityState)||state.activeHead!==parentRecord.acceptedParent||
     await snapshotId(provider,state)!==parentRecord.authorizationSnapshot||state.root?.householdId!==parentRecord.scope.id)throw Error('INVALID_AUTHORITY');
  const verified=await verifyAuthority(state,pin,provider),parent=verified.nodes.get(state.activeHead);
  const c=evidence?.context;
  const [recipient]=await checkExistingRecipientCeremonies(sodium,parent,evidence?.transcript?.authorizationSnapshot,
   {admissionEventHash:c?.admissionEventHash,newEpochId:c?.newEpochId},[evidence],provider);
  if(evidence.transcript.action!=='pairOwnDevice'||hex(sodium.crypto_scalarmult_base(secret))!==recipient.wrappingKeyRef)throw Error('INVALID_PROOF');
  const contents=openDeviceCopy(sodium,fileDomain,file,recipient.transcriptHash,evidence.transcript,secret);
  const v2=contents.version===2&&exact(contents,['version','parentFingerprint','head','item','selection','set','packets']);
  const v3=contents.version===3&&exact(contents,['version','publisherParent','parentFingerprint','head','item','selection','set','packets']);
  if(!v2&&!v3)throw Error('INVALID_FILE');
  const sponsor=v3?contents.publisherParent:parentRecord;
  if(contents.parentFingerprint!==hex(await provider.hash(authorityBytes(sponsor)))||
     sponsor.authorizationSnapshot!==evidence.transcript.authorizationSnapshot)throw Error('INVALID_FILE');
  const {head,item,selection,set,packets}=contents;
  const sponsorState=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(sponsor.authorityState));
  const nextState={...sponsorState,events:[...sponsorState.events,item],selections:[...sponsorState.selections,selection],activeHead:head};
  const next={scope:sponsor.scope,revision:sponsor.revision+1,acceptedParent:head,authorityState:authorityBytes(nextState),authorizationSnapshot:await snapshotId(provider,nextState)};
  const {verifyOwnDeviceSetSuccessor}=await import('./household-own-device-set.mjs');
  // The signed source observation names the publisher's snapshot. Its parent is
  // authenticated by the file and successor; the independently retained local
  // parent is checked against that transition before any keys are returned.
  const publisherView={readPairingAuthority:async scope=>({ok:true,value:
   sameOwnDevice(sodium,scope,sponsor.scope)?sponsor:null})};
  const checked=await verifyOwnDeviceSetSuccessor({...options,storage:publisherView,sodium,provider,pin,parentRecord:sponsor,next,set});
  let localNext=next;
  if(!sameOwnDevice(sodium,parentRecord,sponsor)){
   localNext=await verifyOwnDeviceLocalTransition({sodium,provider,pin,localParent:parentRecord,publisherParent:sponsor,
    publisherNext:next,deviceId:recipient.deviceId,signingSecret,selection:localSelection});
  }
  // Verify the local ceremony against the verified event; other recipients need not disclose their ceremonies.
  const signal=(await import('./household-own-device-recipients.mjs')).ownDeviceRecipientSignal(head,item.event.subject.copyHash,item.event.epochId);
  if(c.admissionEventHash!==head||c.newEpochId!==item.event.epochId||c.sponsorDeviceId!==item.event.authorDeviceId||
     evidence.transcript.signaling.length!==2||!sameOwnDevice(sodium,evidence.transcript.signaling[1],signal))throw Error('INVALID_PROOF');
  const cs=await contexts({sodium,provider,checked,recipient,evidence});
  if(!Array.isArray(packets)||packets.length!==cs.length)throw Error('INVALID_FILE');
  for(const [i,context] of cs.entries())verifyStoredKeyPackage(sodium,packets[i],context);
  const keys=[];
  const open=i=>i===cs.length?withKeys({checked,next,localNext,set,keys}):withOpenedKeyPackage(sodium,packets[i],cs[i],secret,key=>{
   keys.push({documentId:cs[i].projectionId,key});return open(i+1);
  });
  return await open(0);
 } finally {secret.fill(0)}
}
