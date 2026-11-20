import {createGuardianPreparation} from './guardian-preparation.mjs';
import {test} from 'node:test';import {randomUUID} from 'node:crypto';import {unlinkSync} from 'node:fs';import {join} from 'node:path';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {webcrypto} from 'node:crypto';import sodium from 'libsodium-wrappers';import {openSQLiteStorage} from '../../storage/sqlite.ts';import {personalRootPin,initializePersonalAuthority,preparePersonalRotation,personalRotationBytes,preparePersonalAdmission,personalAdmissionBytes,resolvePersonalAuthority} from '../../authority/personal.mjs';import {domain} from '../../authority/validator.mjs';import {ownerGuardians,pinHolder,holderFingerprint,acceptGuardianAuthority,guardianReconstructor,guardianTransferText,parseGuardianTransfer,MAX_GUARDIAN_MESSAGE} from './guardian-workflow.mjs';import {ownerGuardians as beforeOwner} from './guardian-before-r1.mjs';
await sodium.ready;
function fixture(path=':memory:'){const db=new DatabaseSync(path),storage=openSQLiteStorage({executeSync(sql,p=[]){const s=db.prepare(sql);return {rows:sql.startsWith('SELECT')?s.all(...p):(s.run(...p),[])}}});let key;const master={async provision(){key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])},async wrap(_,p,a){const iv=webcrypto.getRandomValues(new Uint8Array(12));return new Uint8Array([...iv,...new Uint8Array(await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:a},key,p))])},async unwrap(_,p,a){return new Uint8Array(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:p.slice(0,12),additionalData:a},key,p.slice(12)))}};return {db,storage,master,keys:storage.localKeys(master,sodium),run:storage.recoveryTransaction}}
const identity=(purpose,epochId)=>({version:1,scope:{kind:'personal',id:'scope'},deviceId:'device',purpose,epochId});const rows=f=>f.db.prepare('SELECT key,value FROM loro_records ORDER BY key').all().map(x=>[x.key,x.value]);
async function ownerFixture(factory,path,beforeDraft=async()=>{}){const f=fixture(path);await f.keys.provision('master');const signing={operationId:'sign',identity:identity('device-signing','device')},pub=(await f.keys.generate(signing.operationId,signing.identity)).publicKey,dataIdentity=identity('data','epoch');await f.keys.generate('data',dataIdentity);const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async(ref,b,s)=>sodium.crypto_sign_verify_detached(s,b,sodium.from_hex(ref))},root={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',scopeId:'scope',ownerId:'owner',signerDeviceId:'device',devices:[{deviceId:'device',ownerId:'owner',signingKeyRef:sodium.to_hex(pub),peerId:'1',active:true}],documentId:'doc',generation:1,epochId:'epoch'},pin=await personalRootPin(provider,root),signature=await f.keys.use(signing.operationId,signing.identity,s=>sodium.to_hex(sodium.crypto_sign_detached(domain('personal-root-signature',root),s)));await initializePersonalAuthority(f.storage,{kind:'personal',id:'scope'},pin,provider,{version:1,root,signature});for(const name of ['alice','bob','carol']){const sp=sodium.crypto_sign_keypair(),wp=sodium.crypto_box_keypair(),bundle={version:1,holder:name,signingKey:sodium.to_hex(sp.publicKey),wrappingKey:sodium.to_hex(wp.publicKey)};await pinHolder({sodium,run:f.run,bundle,confirmedFingerprint:holderFingerprint(sodium,bundle),authorityPin:factory===beforeOwner?undefined:pin});sp.privateKey.fill(0);wp.privateKey.fill(0)}let inject=true;const faultRun=(write,fn)=>f.run(write,tx=>fn({...tx,put:async(k,v)=>{if(inject&&JSON.parse(k)[0]==='recovery-generation'){inject=false;throw Error('interrupted after draft')}return tx.put(k,v)}}));const args={sodium,run:faultRun,storage:f.storage,authorityProvider:provider,scopeId:'scope',owner:'owner',deviceId:'device',pin,keys:f.keys,signing,master:f.master,masterId:'master'};await beforeDraft(f,args);const workflow=factory(args);await assert.rejects(()=>workflow.createGeneration({operationId:'op',holders:['alice','bob'],threshold:2}),/interrupted after draft/);assert.equal(await f.run(false,tx=>tx.get(JSON.stringify(['recovery-generation-head','owner']))),undefined);assert.ok(await f.run(false,tx=>tx.get(JSON.stringify(['recovery-generation-operation','guardian-draft','owner','op']))));return {f,args,workflow}}
test('before control reproduces durable generation write on changed retry after draft interruption',async()=>{const {f,workflow}=await ownerFixture(beforeOwner);try{const saved=rows(f);await assert.rejects(()=>workflow.createGeneration({operationId:'op',holders:['alice','bob'],threshold:1}),/CONFLICT/);assert.notDeepEqual(rows(f),saved);assert.ok(await f.run(false,tx=>tx.get(JSON.stringify(['recovery-generation-head','owner']))))}finally{f.db.close()}});
test('an unpublished legacy draft requires confirmation under the selected root before issuance',async()=>{
 const {f,args}=await ownerFixture(beforeOwner);
 try{
  const workflow=ownerGuardians(args),before=rows(f);
  await assert.rejects(()=>workflow.resume({operationId:'op'}),/MISSING_HOLDER_PIN/);
  assert.deepEqual(rows(f),before);
  for(const holder of ['alice','bob']){
   const bundle=await f.run(false,tx=>tx.get(JSON.stringify(['recovery-custody-ack','pinned-holder',holder])));
   await pinHolder({sodium,run:f.run,bundle,authorityPin:args.pin,confirmedFingerprint:holderFingerprint(sodium,bundle)});
  }
  assert.equal((await workflow.resume({operationId:'op'})).status.generation,0);
 }finally{f.db.close()}
});
test('an unpublished legacy draft can retry with a distinct root-confirmed key for the same guardian',async()=>{
 const {f,args}=await ownerFixture(beforeOwner);
 try{
  const signing=sodium.crypto_sign_keypair(),wrapping=sodium.crypto_box_keypair();
  const alice={version:1,holder:'alice',signingKey:sodium.to_hex(signing.publicKey),wrappingKey:sodium.to_hex(wrapping.publicKey)};
  signing.privateKey.fill(0);wrapping.privateKey.fill(0);
  const bob=await f.run(false,tx=>tx.get(JSON.stringify(['recovery-custody-ack','pinned-holder','bob'])));
  for(const bundle of [alice,bob])await pinHolder({sodium,run:f.run,bundle,authorityPin:args.pin,confirmedFingerprint:holderFingerprint(sodium,bundle)});
  const prepare=workflow=>createGuardianPreparation({run:f.run,owner:'owner',workspaceName:'scope',
   locks:{request:async(_name,_options,use)=>use()},createGeneration:workflow.createGeneration});
  const pending=JSON.stringify(['recovery-generation-operation','app-pending','owner']);
  await f.run(true,tx=>tx.put(pending,{operationId:'op',holders:['alice','bob'],threshold:2}));
  const before=rows(f);
  const faultRun=(write,use)=>f.run(write,tx=>use({...tx,put:async(key,value)=>{
   await tx.put(key,value);
   if(JSON.parse(key)[1]==='guardian-draft')throw Error('interrupted after replacing draft');
  }}));
  await assert.rejects(()=>prepare(ownerGuardians({...args,run:faultRun}))(['alice','bob'],2),/interrupted after replacing draft/);
  assert.deepEqual(rows(f),before);
  const draftSlot=JSON.stringify(['recovery-generation-operation','guardian-draft','owner','op']);
  const publishedSlot=JSON.stringify(['recovery-generation-operation','owner','op']);
  let guardChecked=false;
  const racedRun=(write,use)=>f.run(write,tx=>{
   let readPublication=false;
   return use({...tx,get:async key=>{
    const stored=await tx.get(key);
    if(key===publishedSlot)readPublication=true;
    if(write&&readPublication&&key===draftSlot){
     guardChecked=true;
     return {...stored,requestHash:'0'.repeat(64)};
    }
    return stored;
   }});
  });
  await assert.rejects(()=>prepare(ownerGuardians({...args,run:racedRun}))(['alice','bob'],2),/CONFLICT/);
  assert.equal(guardChecked,true);
  assert.equal(await f.run(false,tx=>tx.get(publishedSlot)),undefined);
  const retry=prepare(ownerGuardians(args));
  const result=await retry(['alice','bob'],2);
  assert.equal(result.message.manifest.generation,0);
  assert.equal(result.message.manifest.roster[0].signingKey,alice.signingKey);
  assert.equal(result.message.manifest.roster[0].wrappingKey,alice.wrappingKey);
  assert.deepEqual(await retry(['alice','bob'],2),result);
 }finally{f.db.close()}
});
test('legacy key replacement cannot reauthorize a draft after personal authority changes',async()=>{
 const scope={kind:'personal',id:'scope'},operationId='op';
 const sign=(f,args,bytes)=>f.keys.use(args.signing.operationId,args.signing.identity,secret=>
  sodium.to_hex(sodium.crypto_sign_detached(bytes,secret)));
 async function rotate(f,args){
  const {value:parent}=await f.storage.readPairingAuthority(scope);
  const rotation={version:1,scopeId:scope.id,ownerId:args.owner,parentSnapshot:parent.authorizationSnapshot,
   sponsorDeviceId:args.deviceId,operationId:'rotation',sourceDocumentId:'doc',sourceRevision:null,sourceHash:null,
   documentId:'rotated-doc',generation:2,epochId:'new-epoch',snapshotHash:'a'.repeat(64),keyHash:'b'.repeat(64),
   retiredDevices:[],recipients:[],seedPeerId:'3'};
  const record=await preparePersonalRotation(parent,args.pin,args.authorityProvider,{
   rotation,signature:await sign(f,args,personalRotationBytes(rotation))
  });
  assert.equal((await f.storage.compareAndSwapPairingAuthority({expectedRevision:parent.revision,record})).ok,true);
  await f.keys.generate('data-new',identity('data','new-epoch'));
 }
 for(const mode of ['same-epoch admission','rotation']){
  const {f,args}=await ownerFixture(ownerGuardians,undefined,mode==='same-epoch admission'?rotate:undefined);
  try{
   // The wrapped draft and request digest are those of the old unscoped format.
   const slot=JSON.stringify(['recovery-generation-operation','guardian-draft','owner',operationId]);
   await f.run(true,async tx=>{
    const {authorityPin:_,...legacy}=await tx.get(slot);
    await tx.put(slot,legacy);
   });
   const before=await resolvePersonalAuthority(f.storage,scope,args.pin,args.authorityProvider,args.deviceId);
   if(mode==='rotation')await rotate(f,args);
   else{
    const extraKey='c'.repeat(64),extraWrap='d'.repeat(64);
    const admission={version:1,scopeId:scope.id,ownerId:args.owner,parentSnapshot:before.scope.authorizationSnapshot,
     sponsorDeviceId:args.deviceId,recipientDeviceId:'second',recipientSigningKeyRef:extraKey,recipientSigningKey:extraKey,
     recipientWrappingKeyRef:extraWrap,recipientWrappingKey:extraWrap,peerId:'2',transcriptHash:'e'.repeat(64),guardId:'guard'};
    const transition=await preparePersonalAdmission(f.storage,scope,args.pin,args.authorityProvider,{
     admission,signature:await sign(f,args,personalAdmissionBytes(admission))
    });
    assert.equal((await f.storage.compareAndSwapPairingAuthority({expectedRevision:transition.expected.revision,record:transition.next})).ok,true);
   }
   const after=await resolvePersonalAuthority(f.storage,scope,args.pin,args.authorityProvider,args.deviceId);
   assert.notEqual(before.scope.authorizationSnapshot,after.scope.authorizationSnapshot);
   if(mode==='same-epoch admission')assert.equal(after.scope.epochId,before.scope.epochId);
   const slotAlice=JSON.stringify(['recovery-custody-ack','pinned-owner-holder',args.pin,'alice']);
   f.db.prepare('DELETE FROM loro_records WHERE key=?').run(slotAlice);
   const signing=sodium.crypto_sign_keypair(),wrapping=sodium.crypto_box_keypair();
   const bundle={version:1,holder:'alice',signingKey:sodium.to_hex(signing.publicKey),wrappingKey:sodium.to_hex(wrapping.publicKey)};
   signing.privateKey.fill(0);wrapping.privateKey.fill(0);
   await pinHolder({sodium,run:f.run,bundle,authorityPin:args.pin,confirmedFingerprint:holderFingerprint(sodium,bundle)});
   const saved=rows(f);
   await assert.rejects(()=>ownerGuardians(args).resume({operationId}),/CONFLICT/,mode);
   assert.deepEqual(rows(f),saved,mode);
  }finally{f.db.close()}
 }
});
test('interrupted draft rejects changed threshold and roster without changing any stored record; exact retry publishes and reopens',async()=>{if(!process.env.GUARDIAN_TEST_DIR)throw Error('GUARDIAN_TEST_DIR required');const path=join(process.env.GUARDIAN_TEST_DIR,`regression-${randomUUID()}.sqlite`),{f,args,workflow}=await ownerFixture(ownerGuardians,path);let closed=false,reopenedDb;try{const saved=rows(f);for(const retry of [{holders:['alice','bob'],threshold:1},{holders:['alice','carol'],threshold:2},{holders:['bob','alice'],threshold:2}]){await assert.rejects(()=>workflow.createGeneration({operationId:'op',...retry}),/CONFLICT/);assert.deepEqual(rows(f),saved)}const result=await workflow.createGeneration({operationId:'op',holders:['alice','bob'],threshold:2});assert.equal(result.status.generation,0);assert.equal(result.status.threshold,2);f.db.close();closed=true;reopenedDb=new DatabaseSync(path);const reopenedStorage=openSQLiteStorage({executeSync(sql,p=[]){const st=reopenedDb.prepare(sql);return {rows:sql.startsWith('SELECT')?st.all(...p):(st.run(...p),[])}}}),reopenedArgs={...args,run:reopenedStorage.recoveryTransaction,storage:reopenedStorage,keys:reopenedStorage.localKeys(f.master,sodium)},reopened=await ownerGuardians(reopenedArgs).resume({operationId:'op'});assert.deepEqual(reopened,result);assert.deepEqual(await ownerGuardians(reopenedArgs).createGeneration({operationId:'op',holders:['alice','bob'],threshold:2}),result)}finally{if(!closed)f.db.close();reopenedDb?.close();unlinkSync(path)}});
test('multibyte authority and contribution messages fail before clone, storage, or crypto',async()=>{const huge='é'.repeat(Math.floor(MAX_GUARDIAN_MESSAGE/2)+20);assert.ok(huge.length<MAX_GUARDIAN_MESSAGE);assert.ok(new TextEncoder().encode(huge).length>MAX_GUARDIAN_MESSAGE);let clones=0,reads=0,crypto=0;const original=globalThis.structuredClone;globalThis.structuredClone=(...a)=>{clones++;return original(...a)};const storage={readPairingAuthority:async()=>{reads++;throw Error('unexpected store')}},authorityProvider={hash:async()=>{crypto++;throw Error('unexpected crypto')},verify:async()=>{crypto++;throw Error('unexpected crypto')}},run=async()=>{reads++;throw Error('unexpected store')};try{await assert.rejects(()=>acceptGuardianAuthority({storage,authorityProvider,bundle:{oversize:huge},confirmedPin:'x'}),/GUARDIAN_MESSAGE_TOO_LARGE/);assert.equal(clones,0);assert.equal(reads,0);assert.equal(crypto,0);const fresh=guardianReconstructor({sodium,run,storage,authorityProvider,pin:'pin'});await assert.rejects(()=>fresh.reconstruct({message:{},contributions:[huge]}),/GUARDIAN_MESSAGE_TOO_LARGE/);assert.equal(clones,0);assert.equal(reads,0);assert.equal(crypto,0);const owner=ownerGuardians({sodium,run,storage,authorityProvider,scopeId:'scope',owner:'owner',deviceId:'device',pin:'pin',keys:{},signing:{},master:{},masterId:'master'});await assert.rejects(()=>owner.reconstruct({message:{},contributions:[huge]}),/GUARDIAN_MESSAGE_TOO_LARGE/);assert.equal(clones,0);assert.equal(reads,0);assert.equal(crypto,0)}finally{globalThis.structuredClone=original}});
test('UTF-8 transfer limit accepts exact byte boundary and rejects next multibyte character before parse',()=>{const exact='é'.repeat((MAX_GUARDIAN_MESSAGE-2)/2),encoded=guardianTransferText(exact);assert.equal(new TextEncoder().encode(encoded).length,MAX_GUARDIAN_MESSAGE);assert.equal(parseGuardianTransfer(encoded),exact);const oversized=JSON.stringify(exact+'é');assert.ok(oversized.length<MAX_GUARDIAN_MESSAGE);let parses=0;const original=JSON.parse;try{JSON.parse=(...args)=>{parses++;return original(...args)};assert.throws(()=>parseGuardianTransfer(oversized),/GUARDIAN_MESSAGE_TOO_LARGE/);assert.equal(parses,0);assert.throws(()=>guardianTransferText(exact+'é'),/GUARDIAN_MESSAGE_TOO_LARGE/)}finally{JSON.parse=original}});

test('caller cannot rewrite parameters after an interrupted durable draft',async()=>{const {f,workflow}=await ownerFixture(ownerGuardians);try{const slot=JSON.stringify(['recovery-generation-operation','app-pending','owner']);await f.run(true,tx=>tx.put(slot,{operationId:'op',holders:['alice','bob'],threshold:2}));const prepare=createGuardianPreparation({run:f.run,owner:'owner',workspaceName:'scope',locks:{request:async(_name,_opts,fn)=>fn()},createGeneration:args=>workflow.createGeneration(args)}),before=rows(f);for(const [holders,threshold] of [[['alice','bob'],1],[['alice','carol'],2]]){await assert.rejects(()=>prepare(holders,threshold),/CONFLICT/);assert.deepEqual(rows(f),before)}const result=await prepare(['alice','bob'],2);assert.equal(result.status.threshold,2)}finally{f.db.close()}});
