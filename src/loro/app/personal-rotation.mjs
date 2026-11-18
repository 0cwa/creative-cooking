import {domain} from '../authority/validator.mjs';
import {
 personalDataCommitment,personalRotationBytes,preparePersonalRotation,resolvePersonalAuthority,verifyPersonalRecord
} from '../authority/personal.mjs';
import {makeKeyPackage,withOpenedKeyPackage} from '../pairing/key-package.mjs';
import {personalCopyIdentities} from '../pairing/personal-copy.mjs';
import {recoveryHash} from '../recovery/enrollment.mjs';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const maxSnapshot=2*1024*1024;
export const MAX_PERSONAL_TRANSFER=7*1024*1024;
const key32=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const id=x=>typeof x==='string'&&x.length>0&&encoder.encode(x).length<=256;
const exact=(v,fields)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const must=result=>{if(!result.ok)throw Error(result.error);return result.value};
const scope=id=>({kind:'personal',id});
const aad=head=>domain('personal-rotation-snapshot',head);
const requestFields=['version','scopeId','pin','deviceId','signingKey','wrappingKey','peerId'];

export function parsePersonalTransfer(text,limit=MAX_PERSONAL_TRANSFER){
 if(typeof text!=='string'||text.length>limit||encoder.encode(text).length>limit)throw Error('TOO_LARGE');
 return JSON.parse(text);
}

function unhex(sodium,text,max){
 if(typeof text!=='string'||!text.length||text.length%2||text.length>2*max||!/^[0-9a-f]+$/.test(text))throw Error('INVALID_PROOF');
 return sodium.from_hex(text);
}
function encodeRecord(sodium,record){
 return JSON.stringify({...record,authorityState:sodium.to_hex(record.authorityState)});
}
function decodeRecord(sodium,text){
 const record=parsePersonalTransfer(text,2_200_000);
 if(!exact(record,['scope','revision','acceptedParent','authorizationSnapshot','authorityState'])||
    !Number.isSafeInteger(record.revision)||record.revision<0)throw Error('INVALID_AUTHORITY');
 return {...record,authorityState:unhex(sodium,record.authorityState,1048576)};
}
function requestBytes(request){
 if(!exact(request,requestFields)||request.version!==1||![request.scopeId,request.deviceId].every(id)||
  ![request.pin,request.signingKey,request.wrappingKey].every(key32)||
  typeof request.peerId!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(request.peerId)||
  BigInt(request.peerId)>18446744073709551615n)throw Error('INVALID_REQUEST');
 return domain('personal-rotation-request',requestFields.map(k=>request[k]));
}
function packageContext(pin,head,r,recipient,senderSigningKey,senderWrappingKey){
 return {version:1,transcriptHash:recipient.requestHash,releaseId:r.operationId,scopeKind:'personal',
  scopeId:r.scopeId,purpose:'data',epochId:r.epochId,generation:r.generation,senderDevice:r.sponsorDeviceId,
  senderSigningKey,senderWrappingKey,recipientDevice:recipient.deviceId,recipientSigningKey:recipient.signingKey,
  recipientWrappingKey:recipient.wrappingKey,policyHash:pin,grantHash:'personal-rotation',
  projectionId:r.documentId,manifestHash:head};
}

function freshSnapshot(LoroDoc,source,devices){
 const current=new LoroDoc();
 if(source)current.import(source);
 const state=current.toJSON(),fresh=new LoroDoc();
 const used=new Set(devices.map(d=>d.peerId));
 let peer=18446744073709551614n;
 while(used.has(String(peer)))peer--;
 fresh.setPeerId(String(peer));
 for(const name of Object.keys(state).sort()){
  // Only containers owned by the personal runtime can enter the new epoch.
  if(!['personal-preferences','personal-conversations','personal-conversation-deletions','domain-effects'].includes(name)&&
     !name.startsWith('personal-messages:')&&!name.startsWith('chef-proposal:'))continue;
  for(const entry of Object.keys(state[name]).sort())fresh.getMap(name).set(entry,state[name][entry]);
 }
 const identities=personalCopyIdentities(fresh),bytes=fresh.export({mode:'snapshot'});
 if(bytes.length>maxSnapshot)throw Error('TOO_LARGE');
 return {bytes,identities,seedPeerId:String(peer)};
}

/** Applies only to personal authority pinned by the local workspace. */
export function personalRotation({sodium,storage,keys,provider,LoroDoc,deviceId,signing,wrapping,signingKey,wrappingKey,
 selected,selection,recoveryImport,randomUUID}){
 const currentScope=scope(selected.scopeId),pin=selected.pin;
 const identity=(scopeId,epochId)=>({version:1,scope:scope(scopeId),deviceId,purpose:'data',epochId});
 const dataHash=(purpose,bytes)=>personalDataCommitment(provider,purpose,bytes);
 const resolve=()=>resolvePersonalAuthority(storage,currentScope,pin,provider,deviceId);
 async function exactParent(){
  const resolved=await resolve(),expected=must(await storage.readPairingAuthority(currentScope));
  if(expected?.authorizationSnapshot!==resolved.scope.authorizationSnapshot||
     expected?.revision!==resolved.expectedAuthority.record.revision)throw Error('CONFLICT');
  return {resolved,expected};
 }
 async function review(){
  const {resolved,expected}=await exactParent();
  const opened=must(await storage.reopenBranchDocument(resolved.expectedAuthority,resolved.scope.documentId));
  if(opened?.bytes.length>maxSnapshot)throw Error('TOO_LARGE');
  return {operationId:randomUUID(),source:{documentId:resolved.scope.documentId,revision:opened?.revision??null,
   hash:opened?await dataHash('source',opened.bytes):null},parent:expected.authorizationSnapshot,
   authorityRevision:expected.revision,pin,devices:resolved.devices.filter(d=>d.active).map(d=>d.deviceId),deviceId};
 }
 async function request(target='current'){
  const recovered=target==='archive'?await recoveryImport?.target():null;
  if(target==='archive'&&!recovered)throw Error('MISSING_RECOVERY');
  const existing=target==='current'?await resolve():null;
  const request={version:1,scopeId:recovered?.scopeId??selected.scopeId,pin:recovered?.pin??pin,deviceId,signingKey,wrappingKey,
   peerId:existing?.scope.authorPeers[deviceId]??String(BigInt('0x'+sodium.to_hex(sodium.randombytes_buf(8)))%18446744073709551615n)};
  return {request,signature:sodium.to_hex(await provider.sign(signingKey,requestBytes(request)))};
 }
 async function checkedRequest(item){
  if(!exact(item,['request','signature']))throw Error('INVALID_REQUEST');
  const d=item.request,payload=requestBytes(d);
  if(!await provider.verify(d.signingKey,payload,unhex(sodium,item.signature,64)))throw Error('INVALID_REQUEST');
  return {deviceId:d.deviceId,signingKey:d.signingKey,wrappingKey:d.wrappingKey,peerId:d.peerId,requestHash:recoveryHash(sodium,item)};
 }
 async function publish(review,retiredDevices,requests=[]){
  ({review,retiredDevices,requests}=structuredClone({review,retiredDevices,requests}));
  if(!id(review?.operationId)||!review.source||!Array.isArray(retiredDevices)||!Array.isArray(requests)||requests.length>127)throw Error('INVALID_INPUT');
  retiredDevices.sort();
  const requestHash=recoveryHash(sodium,[review,retiredDevices,requests]);
  async function completed(){
   const saved=must(await storage.readPersonalRotation(selected.scopeId,review.operationId));
   if(!saved)return null;
   if(saved.requestHash!==requestHash)throw Error('CONFLICT');
   return {transfer:saved.transfer,head:saved.head,scopeId:selected.scopeId,replayed:true};
  }
  const saved=await completed();
  if(saved)return saved;
  try{return await publishNew(review,retiredDevices,requests,requestHash);}
  catch(error){
   // A competing publication can advance authority or claim the key operation.
   if(error?.message==='CONFLICT'||error?.message==='LOCKED'){
    const saved=await completed();
    if(saved)return saved;
   }
   throw error;
  }
 }
 async function publishNew(review,retiredDevices,requests,requestHash){
  const {resolved,expected}=await exactParent();
  if(review.pin!==pin||review.parent!==expected.authorizationSnapshot||
    review.authorityRevision!==expected.revision||review.source.documentId!==resolved.scope.documentId)throw Error('CONFLICT');
  const opened=must(await storage.reopenBranchDocument(resolved.expectedAuthority,resolved.scope.documentId));
  if(opened?.bytes.length>maxSnapshot)throw Error('TOO_LARGE');
  const sourceHash=opened?await dataHash('source',opened.bytes):null;
  if((opened?.revision??null)!==review.source.revision||sourceHash!==review.source.hash)throw Error('CONFLICT');
  const recipients=[];
  for(const item of requests){
   const recipient=await checkedRequest(item);
   if(item.request.pin!==pin||item.request.scopeId!==selected.scopeId)throw Error('INVALID_REQUEST');
   recipients.push(recipient);
  }
  recipients.sort((a,b)=>a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0);
  const fresh=freshSnapshot(LoroDoc,opened?.bytes,[...resolved.devices,...recipients]);
  const documentId=randomUUID(),epochId=randomUUID();
  const source={documentId:resolved.scope.documentId,revision:opened?.revision??null,bytes:opened?.bytes??null};
  const localKey=await keys.prepareForAtomicInstall('personal-rotation:'+review.operationId,identity(selected.scopeId,epochId),async key=>{
   const rotation={version:1,scopeId:selected.scopeId,ownerId:resolved.scope.ownerId,parentSnapshot:expected.authorizationSnapshot,
    sponsorDeviceId:deviceId,operationId:review.operationId,sourceDocumentId:source.documentId,
    sourceRevision:source.revision,sourceHash,documentId,generation:resolved.scope.documentGeneration+1,epochId,
    snapshotHash:await dataHash('snapshot',fresh.bytes),keyHash:await dataHash('key',key),retiredDevices,recipients,seedPeerId:fresh.seedPeerId};
   const signature=sodium.to_hex(await provider.sign(resolved.signingKeyRefs[deviceId],personalRotationBytes(rotation)));
   const item={rotation,signature},next=await preparePersonalRotation(expected,pin,provider,item);
   if(!recipients.length)return {next,transfer:null};
   const nonce=sodium.randombytes_buf(24);
   const cipher=sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(fresh.bytes,aad(next.acceptedParent),null,nonce,key);
   const packages=await keys.use(signing.operationId,signing.identity,secret=>Object.fromEntries(recipients.map(recipient=>
    [recipient.deviceId,sodium.to_hex(makeKeyPackage(sodium,
     packageContext(pin,next.acceptedParent,rotation,recipient,signingKey,wrappingKey),key,secret))])));
   return {next,transfer:{parent:encodeRecord(sodium,expected),item,senderWrappingKey:wrappingKey,
    sealedSnapshot:sodium.to_hex(new Uint8Array([...nonce,...cipher])),packages}};
  });
  const receipt={requestHash,transfer:localKey.packets.transfer};
  const result=must(await storage.commitPersonalRotation({deviceId,operationId:review.operationId,selection:{expected:selection,next:null},
   expected,next:localKey.packets.next,source,document:{id:documentId,bytes:fresh.bytes},epochId,localKey:{record:localKey.record,catalog:localKey.catalog},
   identities:fresh.identities,receipt}));
  return {...result,transfer:receipt.transfer,head:localKey.packets.next.acceptedParent,scopeId:selected.scopeId};
 }
 async function retainedTransfer(){
  const resolved=await resolve();
  if(!resolved.rotation||resolved.rotation.sponsorDeviceId!==deviceId)return null;
  return must(await storage.readPersonalRotation(selected.scopeId,resolved.rotation.operationId))?.transfer??null;
 }
 function inspection(transfer){
  if(!exact(transfer,['parent','item','senderWrappingKey','sealedSnapshot','recipientPackage'])||
    !key32(transfer.senderWrappingKey))throw Error('INVALID_PROOF');
  const expected=decodeRecord(sodium,transfer.parent),r=transfer.item?.rotation;
  personalRotationBytes(r);
  if(expected.scope?.kind!=='personal'||expected.scope.id!==r.scopeId||r.parentSnapshot!==expected.authorizationSnapshot)throw Error('INVALID_PROOF');
  return {expected,r};
 }
 async function install(transfer,confirmedPin,confirmedParent){
  transfer=structuredClone(transfer);
  const {expected:parent,r}=inspection(transfer);
  const sameScope=r.scopeId===selected.scopeId;
  const restored=sameScope?null:await recoveryImport?.target();
  const trustedPin=sameScope?pin:restored?.scopeId===r.scopeId?restored.pin:null;
  if(!trustedPin||confirmedPin!==trustedPin||confirmedParent!==parent.authorizationSnapshot||
    (!sameScope&&restored.owner!==r.ownerId))throw Error('VERIFY_PERSONAL_PARENT');
  const {root}=await verifyPersonalRecord(parent,scope(r.scopeId),trustedPin,provider);
  const recipient=r.recipients.find(x=>x.deviceId===deviceId);
  if(!recipient||recipient.signingKey!==signingKey||recipient.wrappingKey!==wrappingKey)throw Error('UNAUTHORIZED_DEVICE');
  const signedNext=await preparePersonalRotation(parent,trustedPin,provider,transfer.item);
  const requestHash=recoveryHash(sodium,transfer);
  const previous=must(await storage.readPersonalRotation(r.scopeId,r.operationId));
  if(previous){
   if(previous.requestHash!==requestHash)throw Error('CONFLICT');
   return {replayed:true,head:previous.head,scopeId:r.scopeId};
  }
  const expected=must(await storage.readPairingAuthority(scope(r.scopeId)));
  if(expected){
   await verifyPersonalRecord(expected,scope(r.scopeId),trustedPin,provider);
   if(expected.authorizationSnapshot!==parent.authorizationSnapshot)throw Error('CONFLICT');
  }
  const next={...signedNext,revision:expected?expected.revision+1:signedNext.revision};
  const sponsor=root.devices.find(d=>d.deviceId===r.sponsorDeviceId);
  const context=packageContext(trustedPin,next.acceptedParent,r,recipient,sponsor.signingKeyRef,transfer.senderWrappingKey);
  const sealed=unhex(sodium,transfer.sealedSnapshot,maxSnapshot+40),packet=unhex(sodium,transfer.recipientPackage,16384);
  return keys.use(wrapping.operationId,wrapping.identity,secret=>
   withOpenedKeyPackage(sodium,packet,context,secret,async key=>{
    if(await dataHash('key',key)!==r.keyHash)throw Error('INVALID_PROOF');
    const bytes=sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,sealed.slice(24),aad(next.acceptedParent),sealed.slice(0,24),key);
    try{
     if(await dataHash('snapshot',bytes)!==r.snapshotHash)throw Error('INVALID_PROOF');
     const doc=new LoroDoc();doc.import(bytes);
     const identities=personalCopyIdentities(doc);
     const localKey=await keys.preparePairedDataKey('personal-rotation:'+r.operationId,identity(r.scopeId,r.epochId),key);
     const result=must(await storage.commitPersonalRotation({deviceId,operationId:r.operationId,expected,next,epochId:r.epochId,
      selection:{expected:selection,next:{scopeId:r.scopeId,pin:trustedPin}},document:{id:r.documentId,bytes},localKey,identities,
      receipt:{requestHash,transfer:null}}));
     return {...result,head:next.acceptedParent,scopeId:r.scopeId};
    }finally{bytes.fill(0)}
   }));
 }
 return {review,request,publish,retainedTransfer,install,
  fingerprint:async item=>(await checkedRequest(item)).requestHash,
  current:{scopeId:selected.scopeId}};
}

export function personalRecipientTransfer(transfer,deviceId){
 if(!Object.hasOwn(transfer.packages,deviceId))throw Error('UNAUTHORIZED_DEVICE');
 const {packages,...publicParts}=transfer;
 return {...publicParts,recipientPackage:packages[deviceId]};
}
