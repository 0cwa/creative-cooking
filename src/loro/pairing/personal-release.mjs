import {resolvePersonalAuthority,preparePersonalAdmission,personalAdmissionBytes} from '../authority/personal.mjs';
import {ceremonyBytes} from './candidate-v2.mjs';
import {durableSession,offerBytes} from './durable-session.mjs';
import {makeKeyPackage,withOpenedKeyPackage,verifyStoredKeyPackage} from './key-package.mjs';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const signed=(kind,value)=>encoder.encode(JSON.stringify(['creative-cooking/personal-pairing/v1',kind,value]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const must=result=>{if(!result.ok)throw Error(result.error.code??result.error);return result.value};

/** Each call uses its own durable role and independently confirmed evidence.
 * A fresh receiver verifies the supplied parent in memory before atomic install. */
export async function openPersonalPairing({sodium:s,storage,sessionStore,keys,transcript,guard,role,oob,rootPin,ownerId,provider,offeredParent}){
 const {signingSecret,wrappingSecret}=keys;
 const t=structuredClone(transcript),g=structuredClone(guard),wire=ceremonyBytes(t,g),hex=bytes=>s.to_hex(bytes);
 if(t.action!=='pairOwnDevice'||t.scope.kind!=='personal'||t.purpose!=='data'||g.direction!=='initiator-to-responder'||
  !['initiator','responder'].includes(role)||(offeredParent&&role!=='responder'))throw Error('UNAUTHORIZED');
 const session=durableSession(s,sessionStore,keys,t,g,role,oob),proof=await session.evidence();
 const current=must(await storage.readPairingAuthority(t.scope));
 if(!current&&!offeredParent)throw Error('CONFLICT');
 const overlay=record=>({readPairingAuthority:async()=>({ok:true,value:record})});
 const authority=overlay(current??offeredParent);
 let parent=current??offeredParent;
 if(parent.authorizationSnapshot!==t.authorizationSnapshot){
  const state=JSON.parse(decoder.decode(parent.authorityState));
  const item=(state.version===3?state.events:state.admissions)?.at(-1),ad=item?.admission;
  if(!ad||ad.parentSnapshot!==t.authorizationSnapshot||ad.transcriptHash!==proof.hash||ad.guardId!==g.guardId||
   ad.recipientDeviceId!==t.responder.deviceId||ad.recipientSigningKey!==hex(t.responder.signingPublicKey)||
   ad.recipientWrappingKey!==hex(t.responder.wrappingPublicKey))throw Error('UNAUTHORIZED');
  const recovered=await preparePersonalAdmission(authority,t.scope,rootPin,provider,item);
  if(!recovered.replayed)throw Error('CONFLICT');
  parent=recovered.expected;
 }
 if(offeredParent&&(parent.revision!==offeredParent.revision||parent.acceptedParent!==offeredParent.acceptedParent||
    parent.authorizationSnapshot!==offeredParent.authorizationSnapshot||!same(parent.scope,offeredParent.scope)||
    hex(parent.authorityState)!==hex(offeredParent.authorityState)))throw Error('CONFLICT');
 const a=await resolvePersonalAuthority(overlay(parent),t.scope,rootPin,provider,t.initiator.deviceId);
 if(a.scope.ownerId!==ownerId||a.scope.branchHead!==t.acceptedParent||a.scope.authorizationSnapshot!==t.authorizationSnapshot)throw Error('UNAUTHORIZED');
 const keyRef=a.signingKeyRefs[t.initiator.deviceId],offer=role==='initiator'?proof.offer:proof.peerOffer;
 if(!keyRef||!await provider.verify(keyRef,offerBytes('initiator',proof.hash,offer.challenge),s.from_hex(offer.signature)))throw Error('UNAUTHORIZED');
 const context=operationId=>({version:1,transcriptHash:proof.hash,releaseId:operationId,scopeKind:'personal',
  scopeId:t.scope.id,purpose:t.purpose,epochId:a.scope.epochId,generation:a.scope.documentGeneration,senderDevice:t.initiator.deviceId,
  senderSigningKey:hex(t.initiator.signingPublicKey),senderWrappingKey:hex(t.initiator.wrappingPublicKey),recipientDevice:t.responder.deviceId,
  recipientSigningKey:hex(t.responder.signingPublicKey),recipientWrappingKey:hex(t.responder.wrappingPublicKey),policyHash:rootPin,
  grantHash:'personal-own-device',projectionId:a.scope.documentId,manifestHash:t.authorizationSnapshot});

 async function transition(item){
  const ad=item?.admission;
  if(!ad||ad.scopeId!==t.scope.id||ad.ownerId!==ownerId||ad.parentSnapshot!==t.authorizationSnapshot||
   ad.sponsorDeviceId!==t.initiator.deviceId||ad.recipientDeviceId!==t.responder.deviceId||
   ad.recipientSigningKey!==hex(t.responder.signingPublicKey)||ad.recipientWrappingKey!==hex(t.responder.wrappingPublicKey)||
   ad.transcriptHash!==proof.hash||ad.guardId!==g.guardId)throw Error('INVALID_PROOF');
  return preparePersonalAdmission(authority,t.scope,rootPin,provider,item);
 }
 const validateRelease=(release,change)=>{
  if(!release||hex(ceremonyBytes(release.transcript,release.guard))!==hex(wire)||
   release.expectedAuthorityRevision!==change.expected.revision||release.outcome.recipientDevice!==t.responder.deviceId||
   release.packet.id!==hex(s.crypto_generichash(32,release.packet.bytes)))throw Error('INVALID_PROOF');
  const c=context(release.operationId);
  verifyStoredKeyPackage(s,release.packet.bytes,c);
  return c;
 };
 async function release(operationId,localKeys,keyOperation,keyIdentity,peerId,prepareFile){
  if(role!=='initiator'||keyIdentity.scope.kind!=='personal'||keyIdentity.scope.id!==t.scope.id||
   keyIdentity.deviceId!==t.initiator.deviceId||keyIdentity.purpose!==t.purpose||keyIdentity.epochId!==a.scope.epochId)throw Error('UNAUTHORIZED');
  const prior=must(await storage.findPairingRelease(t.scope,operationId));
  if(prior){
   const now=must(await storage.readPairingAuthority(t.scope));
   const state=JSON.parse(decoder.decode(now.authorityState)),item=(state.events??state.admissions)?.at(-1);
   if(item?.admission?.peerId!==peerId)throw Error('CONFLICT');
   const change=await transition(item);
   validateRelease(prior,change);
   const saved=must(await storage.commitPersonalAdmissionRelease(prior,change.next));
   const file=prepareFile?must(await storage.readPersonalPairingFile(change.next,operationId)):undefined;
   return {...saved,admission:item,file,authorizationSnapshot:change.next.authorizationSnapshot};
  }
  const ad={version:1,scopeId:t.scope.id,ownerId,parentSnapshot:t.authorizationSnapshot,sponsorDeviceId:t.initiator.deviceId,
   recipientDeviceId:t.responder.deviceId,recipientSigningKeyRef:hex(t.responder.signingPublicKey),
   recipientWrappingKeyRef:hex(t.responder.wrappingPublicKey),recipientSigningKey:hex(t.responder.signingPublicKey),
   recipientWrappingKey:hex(t.responder.wrappingPublicKey),peerId,transcriptHash:proof.hash,guardId:g.guardId};
  const item={admission:ad,signature:hex(s.crypto_sign_detached(personalAdmissionBytes(ad),signingSecret))};
  const change=await transition(item),c=context(operationId);
  const make=key=>makeKeyPackage(s,c,key,signingSecret);
  const packet=await (keyOperation?localKeys.use(keyOperation,keyIdentity,make):localKeys.useIdentity(keyIdentity,make));
  const packetId=hex(s.crypto_generichash(32,packet));
  const release={version:1,operationId,transcript:t,guard:g,expectedAuthorityRevision:change.expected.revision,packet:{id:packetId,bytes:packet},
   outbox:{destination:t.responder.deviceId,objectId:packetId},outcome:{recipientDevice:t.responder.deviceId,packetId}};
  const publication=prepareFile?await prepareFile({release,admission:item},a,change.expected):undefined;
  const saved=must(await storage.commitPersonalAdmissionRelease(release,change.next,publication));
  return {...saved,admission:item,file:publication?.file,authorizationSnapshot:change.next.authorizationSnapshot};
 }

 async function install(envelope,recipient,master,masterId,keyRef,prepareCopy){
  if(role!=='responder'||!!offeredParent!==!!prepareCopy)throw Error('UNAUTHORIZED');
  if(typeof masterId!=='string'||!masterId||typeof keyRef!=='string'||!keyRef)throw Error('MALFORMED');
  if(typeof storage.localKeys!=='function')throw Error('LOCAL_KEY_REQUIRED');
  const localKeys=storage.localKeys(master,s);
  envelope=structuredClone(envelope);
  const release=envelope?.release,change=await transition(envelope?.admission),c=validateRelease(release,change);
  const identity={version:1,operationId:release.operationId,scope:t.scope,guardId:g.guardId,direction:g.direction,purpose:t.purpose,
   epochId:a.scope.epochId,packetId:release.packet.id,packetDigest:s.crypto_generichash(32,release.packet.bytes),transcript:t,recipientDevice:t.responder.deviceId};
  const aad=signed('wrapped-key',[c,release.packet.id,masterId]);
  const localIdentity={version:1,scope:t.scope,deviceId:t.responder.deviceId,purpose:'data',epochId:a.scope.epochId};
  const localOperation='personal-pairing:'+release.packet.id;
  const existing=must(await recipient.findRecipient(identity));
  const copy=prepareCopy?await prepareCopy(a,change,!!existing):undefined;
  const receiptBytes=signed('receipt',copy?[c,release.packet.id,keyRef,copy.fileHash]:[c,release.packet.id,keyRef]);
  let stored;
  if(existing){
   if(existing.keyRef!==keyRef||!s.crypto_sign_verify_detached(existing.acceptanceReceipt,receiptBytes,t.responder.signingPublicKey))throw Error('CONFLICT');
   stored=must(await recipient.readWrapped(identity,keyRef));
   if(!stored||stored.masterKeyId!==masterId)throw Error('CONFLICT');
  }
  return withOpenedKeyPackage(s,release.packet.bytes,c,wrappingSecret,async key=>{
   if(existing){
    const storedKey=await master.unwrap(masterId,stored.wrappedLocalKey,aad);
    try{if(storedKey.length!==key.length||!storedKey.every((byte,index)=>byte===key[index]))throw Error('CONFLICT')}
    finally{storedKey.fill(0)}
   }
   const localKey=await localKeys.preparePairedDataKey(localOperation,localIdentity,key);
   const wrapped=existing?stored.wrappedLocalKey:await master.wrap(masterId,key,aad);
   const receipt=existing?existing.acceptanceReceipt:s.crypto_sign_detached(receiptBytes,signingSecret);
   const saved=must(await recipient.installPersonalAdmissionAndReceipt({identity,keyRef,masterKeyId:masterId,
    wrappedLocalKey:wrapped,acceptanceReceipt:receipt},change.expected,change.next,localKey,copy));
   return {...saved,identity,aad,head:change.next.acceptedParent,authorizationSnapshot:change.next.authorizationSnapshot};
  });
 }
 return {release,install};
}
