// An offline archive is sealed with a key derived separately from the recovery code.
// It carries accepted personal authority and optional encrypted outbound objects only.
import {resolvePersonalAuthority} from '../authority/personal.mjs';
import {inspectPersonal,authenticatePersonal} from '../recovery/recovery.mjs';
import {recoveryHash} from '../recovery/enrollment.mjs';
import {validLocalIdentity} from '../storage/local-keys.ts';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const MAX_PLAIN=8*1024*1024;
const id=x=>typeof x==='string'&&x.length>0&&enc.encode(x).length<=256;
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=(s,n)=>{if(typeof s!=='string'||!Number.isSafeInteger(n)||n<0||s.length!==n*2||!/^[0-9a-f]*$/.test(s))throw Error('INVALID_ARCHIVE');const out=new Uint8Array(n);for(let i=0;i<n;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16);return out};
const aad=enc.encode('creative-cooking/personal-recovery-archive/v1');
const signingProvider=s=>({hash:async b=>s.crypto_generichash(32,b),verify:async(ref,b,sig)=>{try{return s.crypto_sign_verify_detached(sig,b,unhex(ref,32))}catch{return false}}});
const key=(s,code)=>{const secret=unhex(code,32);try{return s.crypto_kdf_derive_from_key(32,2,'CCRECOV1',secret)}finally{secret.fill(0)}};
async function validate(s,body){
 if(!exact(body,['version','scopeId','owner','deviceId','pin','authority','catalog','bindings','objects','snapshot','package'])||body.version!==1||![body.scopeId,body.owner,body.deviceId,body.pin].every(id)||!Array.isArray(body.bindings)||!Array.isArray(body.objects)||body.bindings.length>1024||body.objects.length>1024)throw Error('INVALID_ARCHIVE');
 const record=body.authority;
 if(!exact(record,['scope','revision','acceptedParent','authorizationSnapshot','authorityState'])||record.scope?.kind!=='personal'||record.scope.id!==body.scopeId||typeof record.authorityState!=='string'||record.authorityState.length>2097152||record.authorityState.length%2||!/^[0-9a-f]+$/.test(record.authorityState))throw Error('INVALID_ARCHIVE');
 const authority={...record,authorityState:unhex(record.authorityState,record.authorityState.length/2)};
 const resolved=await resolvePersonalAuthority({readPairingAuthority:async()=>({ok:true,value:authority})},{kind:'personal',id:body.scopeId},body.pin,signingProvider(s),body.deviceId);
 if(resolved.scope.ownerId!==body.owner||body.catalog?.owner!==body.owner||!Array.isArray(body.catalog.keyRefs)||body.catalog.keyRefs.length!==body.bindings.length)throw Error('INVALID_ARCHIVE');
 const refs=new Set(),ops=new Set(),identities=new Set();
 for(const [i,b] of body.bindings.entries()){
  if(!exact(b,['ref','operationId','identity'])||!id(b.ref)||!id(b.operationId)||b.ref!==body.catalog.keyRefs[i]||!validLocalIdentity(b.identity)||b.identity.scope.kind!=='personal'||b.identity.scope.id!==body.scopeId||b.identity.purpose!=='data'||b.identity.deviceId!==body.deviceId||refs.has(b.ref)||ops.has(b.operationId)||identities.has(JSON.stringify(b.identity)))throw Error('INVALID_ARCHIVE');
  refs.add(b.ref);ops.add(b.operationId);identities.add(JSON.stringify(b.identity));
 }
 if(resolved.rotation&&(body.catalog.keyRefs.length!==1||body.catalog.keyRefs[0]!==resolved.scope.epochId||
    body.catalog.trustedCheckpoints?.length!==1||body.catalog.trustedCheckpoints[0]!==resolved.scope.branchHead))throw Error('INVALID_ARCHIVE');
 if(!body.bindings.some(b=>b.identity.epochId===resolved.scope.epochId))throw Error('INVALID_ARCHIVE');
 if(body.snapshot!==null&&(!exact(body.snapshot,['documentId','bytes'])||body.snapshot.documentId!==resolved.scope.documentId||typeof body.snapshot.bytes!=='string'||body.snapshot.bytes.length>8*1024*1024||body.snapshot.bytes.length%2||!/^[0-9a-f]+$/.test(body.snapshot.bytes)))throw Error('INVALID_ARCHIVE');
 const epochs=new Set(body.bindings.map(b=>b.identity.epochId));
 const seen=new Set();for(const o of body.objects){if(!exact(o,['objectId','epochId','branchHead','bytes'])||![o.objectId,o.epochId,o.branchHead].every(id)||typeof o.bytes!=='string'||o.bytes.length>2097152||o.bytes.length%2||!/^[0-9a-f]+$/.test(o.bytes)||seen.has(o.objectId)||!body.catalog.encryptedObjectRefs.includes(o.objectId)||!epochs.has(o.epochId))throw Error('INVALID_ARCHIVE');seen.add(o.objectId)}
 return resolved;
}
/** Source must provide the actual durable authority and LocalKeys, not package-asserted bindings. */
export async function createRecoveryArchive({sodium,storage,keys,scopeId,owner,deviceId,pin,catalog,bindings,kit,includeObjects=false,includeSnapshot=false}){
 const read=await storage.readPairingAuthority({kind:'personal',id:scopeId});if(!read.ok)throw Error(read.error);if(!read.value)throw Error('MISSING_AUTHORITY');
 const objects=await storage.listOutboundObjects(scopeId);if(!objects.ok)throw Error(objects.error);
 const selected=includeObjects?objects.value.filter(o=>catalog.encryptedObjectRefs.includes(o.objectId)):[];
 if(selected.length>1024||!(read.value.authorityState instanceof Uint8Array)||read.value.authorityState.length>1048576)throw Error('TOO_LARGE');
 let encodedBytes=read.value.authorityState.length*2;
 for(const o of selected){if(!(o.bytes instanceof Uint8Array)||o.bytes.length>1048576)throw Error('TOO_LARGE');encodedBytes+=o.bytes.length*2;if(encodedBytes>MAX_PLAIN)throw Error('TOO_LARGE')}
 const body={version:1,scopeId,owner,deviceId,pin,authority:{...read.value,authorityState:''},catalog:structuredClone(catalog),bindings:structuredClone(bindings),objects:selected.map(o=>({...o,bytes:''})),snapshot:null,package:structuredClone(kit.package)};
 const metadataBytes=enc.encode(JSON.stringify(body)).length;
 if(metadataBytes+encodedBytes>MAX_PLAIN)throw Error('TOO_LARGE');
 body.authority.authorityState=hex(read.value.authorityState);
 for(let i=0;i<selected.length;i++)body.objects[i].bytes=hex(selected[i].bytes);
 const resolved=await validate(sodium,body);
 if(includeSnapshot){const doc=await storage.reopenBranchDocument(resolved.expectedAuthority,resolved.scope.documentId);if(!doc.ok)throw Error(doc.error);if(doc.value){
  if(!(doc.value.bytes instanceof Uint8Array)||doc.value.bytes.length>4*1024*1024)throw Error('TOO_LARGE');
  const snapshotOverhead=enc.encode(JSON.stringify({documentId:resolved.scope.documentId,bytes:''})).length-4;
  if(metadataBytes+encodedBytes+snapshotOverhead+doc.value.bytes.length*2>MAX_PLAIN)throw Error('TOO_LARGE');
  body.snapshot={documentId:resolved.scope.documentId,bytes:hex(doc.value.bytes)};
 }}
 authenticatePersonal(sodium,kit.package,kit.code,{owner,generation:catalog.generation});inspectPersonal(sodium,kit,{owner,generation:catalog.generation,catalogHash:recoveryHash(sodium,catalog)});
 for(const b of body.bindings)await keys.use(b.operationId,b.identity,()=>undefined);
 const k=key(sodium,kit.code),nonce=sodium.randombytes_buf(24);try{const plain=enc.encode(JSON.stringify(body));if(plain.length>MAX_PLAIN)throw Error('TOO_LARGE');try{return {version:1,nonce:hex(nonce),ciphertext:hex(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain,aad,null,nonce,k))}}finally{plain.fill(0)}}finally{k.fill(0)}
}
/** Authenticate everything before creating a destination or writing any records. */
export async function openRecoveryArchive(sodium,archive,code){
 if(!exact(archive,['version','nonce','ciphertext'])||archive.version!==1||typeof archive.ciphertext!=='string'||archive.ciphertext.length<32||archive.ciphertext.length>16*1024*1024+32||archive.ciphertext.length%2||!/^[0-9a-f]+$/.test(archive.ciphertext))throw Error('INVALID_ARCHIVE');
 const k=key(sodium,code);let plain,body;try{plain=sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,unhex(archive.ciphertext,archive.ciphertext.length/2),aad,unhex(archive.nonce,24),k);body=JSON.parse(dec.decode(plain))}catch{throw Error('INVALID_ARCHIVE')}finally{k.fill(0);plain?.fill(0)}
 const resolved=await validate(sodium,body);
 authenticatePersonal(sodium,body.package,code,{owner:body.owner,generation:body.catalog.generation});inspectPersonal(sodium,{code,package:body.package},{owner:body.owner,generation:body.catalog.generation,catalogHash:recoveryHash(sodium,body.catalog)});
 return {body,resolved,archiveAccess:body.snapshot?'snapshot-available-read-only':'missing-snapshot',householdAuthority:'readmission-required'};
}

/** Open and authenticate before invoking the destination factory, which may create storage. */
export async function restoreOfflineArchive({sodium,archive,code,operationId,openDestination}){
 const verified=await openRecoveryArchive(sodium,archive,code),body=verified.body;
 if(!id(operationId)||typeof openDestination!=='function')throw Error('INVALID_CONTEXT');
 const destination=await openDestination();
 try{
  const {personalRecovery}=await import('./personal-recovery.mjs');
  const recovery=personalRecovery({sodium,keys:destination.keys,run:destination.run,storage:destination.storage,master:destination.master,masterId:destination.masterId,owner:body.owner,scopeId:body.scopeId,bindings:body.bindings,operationId});
  const result=await recovery.restore(body.package,code,body.catalog.generation);
  if(body.snapshot){
   const key=JSON.stringify(['recovery-install',body.owner,`snapshot:${operationId}`]),context=enc.encode(JSON.stringify(['creative-cooking/recovery-snapshot/v1',body.owner,body.scopeId,operationId,body.snapshot.documentId])),plain=unhex(body.snapshot.bytes,body.snapshot.bytes.length/2);
   try{
    const old=await destination.run(false,tx=>tx.get(key));
    if(old!==undefined){if(!old||old.version!==1||old.documentId!==body.snapshot.documentId||!(old.wrapped instanceof Uint8Array))throw Error('LOCKED');const saved=await destination.master.unwrap(destination.masterId,old.wrapped,context);try{if(!sodium.memcmp(saved,plain))throw Error('CONFLICT')}finally{saved.fill(0)}}
    else{const wrapped=await destination.master.wrap(destination.masterId,plain,context);await destination.run(true,async tx=>{if(await tx.get(key)!==undefined)throw Error('CONFLICT');await tx.put(key,{version:1,documentId:body.snapshot.documentId,wrapped})})}
   }finally{plain.fill(0)}
  }
  return {...result,archiveAccess:verified.archiveAccess,archiveCiphertextCopies:body.objects.length};
 }finally{destination.close?.()}
}
/** Open a recovered snapshot without authorizing the new device to modify its old authority. */
export async function readRecoveredSnapshot({sodium,run,master,masterId,owner,scopeId,operationId,documentId,LoroDoc}){
 const key=JSON.stringify(['recovery-install',owner,`snapshot:${operationId}`]),record=await run(false,tx=>tx.get(key));
 if(record===undefined)return null;
 if(!record||record.version!==1||record.documentId!==documentId||!(record.wrapped instanceof Uint8Array))throw Error('LOCKED');
 const context=enc.encode(JSON.stringify(['creative-cooking/recovery-snapshot/v1',owner,scopeId,operationId,documentId])),plain=await master.unwrap(masterId,record.wrapped,context);
 try{const doc=new LoroDoc();doc.import(plain);return doc}finally{plain.fill(0)}
}
