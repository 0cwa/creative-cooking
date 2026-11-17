import {openSQLiteStorage} from '../storage/sqlite.ts';
import {rootPin,policyId,initializeAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {personalRootPin,initializePersonalAuthority,resolvePersonalAuthority} from '../authority/personal.mjs';
import {domain} from '../authority/validator.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {localProvider} from '../app/local-provider.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {workspaceRecovery} from '../app/workspace-recovery.mjs';
import {openNativeSequences} from './sequences.mjs';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const aad=enc.encode('creative-cooking/native-bootstrap/v1');
const fields=['device','adult','house','personal','houseDoc','personalDoc','houseEpoch','personalEpoch'];
const valid=x=>typeof x==='string'&&/^[a-z0-9-]{1,100}$/.test(x);
const exec=(db,q,p=[])=>db.executeSync(q,p);
const rows=(db,q,p=[])=>exec(db,q,p).rows??[];
async function transaction(db,fn){exec(db,'BEGIN IMMEDIATE');try{const r=await fn();exec(db,'COMMIT');return r}catch(e){try{exec(db,'ROLLBACK')}catch{}throw e}}
function check(r){if(!r||r.version!==1||!fields.every(k=>valid(r[k]))||new Set(fields.map(k=>r[k])).size!==fields.length)throw Error('LOCKED');return r}
const decode=bytes=>check(JSON.parse(dec.decode(bytes)));
const serial=new Map();
export function openNativeWorkspaceWith({name,create,openDatabase,openMaster,sodium,LoroDoc,decodeImportBlobMeta}) {
 if(!valid(name)||typeof create!=='boolean')throw Error('MALFORMED');
 const previous=serial.get(name)??Promise.resolve();const current=previous.catch(()=>{}).then(()=>open({name,create,openDatabase,openMaster,sodium,LoroDoc,decodeImportBlobMeta}));serial.set(name,current);current.finally(()=>{if(serial.get(name)===current)serial.delete(name)}).catch(()=>{});return current;
}
async function open({name,create,openDatabase,openMaster,sodium,LoroDoc,decodeImportBlobMeta}){
 await sodium.ready;const db=openDatabase(name), master=openMaster(name);let sequences;
 try {
  exec(db,'CREATE TABLE IF NOT EXISTS loro_bootstrap (id INTEGER PRIMARY KEY CHECK(id=1), stage TEXT NOT NULL, data BLOB NOT NULL)');
  const storage=openSQLiteStorage(db);
  const load=()=>rows(db,'SELECT stage,data FROM loro_bootstrap WHERE id=1')[0];
  let state=await transaction(db,async()=>{
   let record=load();if(record)return record;
   if(!create)throw Error('MISSING_BOOTSTRAP');
   if(rows(db,'SELECT key FROM loro_records LIMIT 1').length || await master.exists('workspace-master'))throw Error('LOCKED');
   const r={version:1};for(const key of fields)r[key]=sodium.to_hex(sodium.randombytes_buf(16));check(r);
   exec(db,'INSERT INTO loro_bootstrap VALUES (1,?,?)',['reserved',enc.encode(JSON.stringify(r))]);return load();
  });
  if(!['reserved','sealed','ready'].includes(state.stage))throw Error('LOCKED');
  let r;
  if(state.stage==='reserved'){
   await transaction(db,async()=>{const now=load();if(now.stage!=='reserved')return;const pending=decode(new Uint8Array(now.data));await master.ensure('workspace-master');const wrapped=await master.wrap('workspace-master',enc.encode(JSON.stringify({...pending,stage:'sealed'})),aad);exec(db,'UPDATE loro_bootstrap SET stage=?,data=? WHERE id=1',['sealed',wrapped]);});state=load();
  }
  const ready=state.stage==='ready';if(!['sealed','ready'].includes(state.stage))throw Error('LOCKED');
  try{const decoded=decode(await master.unwrap('workspace-master',new Uint8Array(state.data),aad));if(decoded.stage!==state.stage)throw Error('LOCKED');const {stage,...rest}=decoded;r=rest}catch{throw Error('LOCKED')}
  sequences=openNativeSequences(db,[r.house,r.personal],!ready);
  const keys=storage.localKeys(master,sodium);if(ready)await keys.unlock();else await keys.provision('workspace-master');
  const identity=(kind,scopeId,purpose,epochId)=>({version:1,scope:{kind,id:scopeId},deviceId:r.device,purpose,epochId});
  const signing={operationId:'device-signing',identity:identity('personal',r.personal,'device-signing',r.personalEpoch)},wrapping={operationId:'device-wrapping',identity:identity('personal',r.personal,'device-wrapping',r.personalEpoch)},houseKey={operationId:'household-data',identity:identity('household',r.house,'data',r.houseEpoch)},personalKey={operationId:'personal-data',identity:identity('personal',r.personal,'data',r.personalEpoch)};
  let publicKey,wrappingPublicKey;
  if(ready){publicKey=await keys.use(signing.operationId,signing.identity,secret=>{const pair=sodium.crypto_sign_seed_keypair(secret.slice(0,32));pair.privateKey.fill(0);return pair.publicKey});wrappingPublicKey=await keys.use(wrapping.operationId,wrapping.identity,secret=>sodium.crypto_scalarmult_base(secret));await keys.use(houseKey.operationId,houseKey.identity,()=>{});await keys.use(personalKey.operationId,personalKey.identity,()=>{});}
  else {publicKey=(await keys.generate(signing.operationId,signing.identity)).publicKey;wrappingPublicKey=(await keys.generate(wrapping.operationId,wrapping.identity)).publicKey;await keys.generate(houseKey.operationId,houseKey.identity);await keys.generate(personalKey.operationId,personalKey.identity)}
  const signingRef=sodium.to_hex(publicKey),provider=localProvider(sodium,keys,{signing:{...signing,publicKey:signingRef},content:{[r.houseEpoch]:houseKey,[r.personalEpoch]:personalKey}});
  const policy={kind:'allMinusOne',fixedCount:null},root={householdId:r.house,head:'',policyHash:await policyId(provider,policy),generation:1,epochId:r.houseEpoch,roster:[r.adult],devices:[{adultId:r.adult,deviceId:r.device,signingKeyRef:signingRef,active:true}],policy,runtime:{documentId:r.houseDoc,authorPeers:{[r.device]:'1'},acceptedRecipients:[r.device]}};root.head=await rootPin(provider,root);
  const personalRoot={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',scopeId:r.personal,ownerId:r.adult,signerDeviceId:r.device,devices:[{deviceId:r.device,ownerId:r.adult,signingKeyRef:signingRef,peerId:'2',active:true}],documentId:r.personalDoc,generation:1,epochId:r.personalEpoch},pin=await personalRootPin(provider,personalRoot),signature=sodium.to_hex(await provider.sign(signingRef,domain('personal-root-signature',personalRoot)));
  const ensure=async(scope,initialize)=>{const old=await storage.readPairingAuthority(scope);if(!old.ok)throw Error(old.error);if(!old.value){if(ready)throw Error('MISSING_AUTHORITY');try{await initialize()}catch(e){const raced=await storage.readPairingAuthority(scope);if(!raced.ok||!raced.value)throw e}}};
  await ensure({kind:'household',id:r.house},()=>initializeAuthority(storage,root,root.head,provider));
  await ensure({kind:'personal',id:r.personal},()=>initializePersonalAuthority(storage,{kind:'personal',id:r.personal},pin,provider,{version:1,root:personalRoot,signature}));
  const house=await resolveRuntimeAuthority(storage,{kind:'household',id:r.house},root.head,provider,r.device),personal=await resolvePersonalAuthority(storage,{kind:'personal',id:r.personal},pin,provider,r.device);
  const runtime=(resolved,kind,rootPin)=>{const p=localProvider(sodium,keys,{signing:{...signing,publicKey:signingRef},content:(epoch,fn)=>keys.useIdentity(identity(kind,resolved.scope.scopeId,'data',epoch),fn)});return new OfflineRuntime({storage,codec:candidateCodec(p),LoroDoc,decodeImportBlobMeta,scope:resolved.scope,keyRef:resolved.scope.epochId,authority:{kind,rootPin,provider}})};
  const disclosure=disclosureService({storage,scope:{kind:'household',id:r.house},rootPin:root.head,provider,deviceId:r.device});const active=await storage.readDisclosureActive(r.house);if(!active.ok)throw Error(active.error);if(active.value)await disclosure.active();
  if(!ready)await transaction(db,async()=>{const now=load();if(!now||!['sealed','ready'].includes(now.stage))throw Error('LOCKED');const decoded=decode(await master.unwrap('workspace-master',new Uint8Array(now.data),aad));if(decoded.stage!==now.stage)throw Error('LOCKED');const {stage,...current}=decoded;if(JSON.stringify(current)!==JSON.stringify(r))throw Error('LOCKED');if(now.stage==='sealed'){const complete=await master.wrap('workspace-master',enc.encode(JSON.stringify({...r,stage:'ready'})),aad);exec(db,'UPDATE loro_bootstrap SET stage=?,data=? WHERE id=1',['ready',complete])}});
  const recovery=workspaceRecovery({sodium,keys,run:storage.recoveryTransaction,storage,master,masterId:'workspace-master',scopeId:r.personal,deviceId:r.device,pin,provider});
  return {household:runtime(house,'household',root.head),personal:runtime(personal,'personal',pin),disclosure,disclosureProvider:provider,needsDisclosureSetup:!active.value,deviceId:r.device,wrappingPublicKey:sodium.to_hex(wrappingPublicKey),sequences,recovery,close:()=>{sequences.close();db.close();master.close()}};
 }catch(e){sequences?.close();db.close();master.close();throw e}
}
