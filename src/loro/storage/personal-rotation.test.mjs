import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import sodium from 'libsodium-wrappers';
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';
import {openSQLiteStorage} from './sqlite.ts';
import {domain} from '../authority/validator.mjs';
import {initializePersonalAuthority,personalRootPin,preparePersonalAdmission,personalAdmissionBytes,
 resolvePersonalAuthority} from '../authority/personal.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {localProvider} from '../app/local-provider.mjs';
import {personalRotation,personalRecipientTransfer} from '../app/personal-rotation.mjs';
import {workspaceRecovery} from '../app/workspace-recovery.mjs';
import {openRecoveryArchive} from '../app/recovery-archive.mjs';

await sodium.ready;
const scope={kind:'personal',id:'personal'};
const epoch='old-epoch';
const masterId='local';
const randomUUID=()=>crypto.randomUUID();
const command=(key,value)=>({version:1,kind:'personal-preference-put',commandId:key,effectId:key,dependencyEffectIds:[],
 data:{key:'city',value}});
const value=result=>{assert.equal(result.ok,true,JSON.stringify(result.error));return result.value};

function open(path){
 const db=new DatabaseSync(path);
 let failedAt=0,writes=0;
 const storage=openSQLiteStorage({executeSync(sql,args=[]){
  const statement=db.prepare(sql);
  return {rows:sql.startsWith('SELECT')?statement.all(...args):(statement.run(...args),[])};
 }},step=>{if(step==='write'&&++writes===failedAt)throw Error('injected write fault')});
 return {storage,db,failAt(n){failedAt=n;writes=0}};
}

async function makeDevice(deviceId,path){
 const masterKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const master={
  async ensure(){},
  async wrap(_,bytes,aad){const iv=crypto.getRandomValues(new Uint8Array(12));return new Uint8Array([
   ...iv,...new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},masterKey,bytes))]);},
  async unwrap(_,bytes,aad){return new Uint8Array(await crypto.subtle.decrypt({
   name:'AES-GCM',iv:bytes.slice(0,12),additionalData:aad},masterKey,bytes.slice(12)));}
 };
 const identity=(purpose,epochId=epoch,where=scope)=>({version:1,scope:where,deviceId,purpose,epochId});
 const signing={operationId:'sign',identity:identity('device-signing')};
 const wrapping={operationId:'wrap',identity:identity('device-wrapping')};
 let connection;
 const device={deviceId,signing,wrapping,identity,master,
  open(){
   connection=open(path);
   Object.assign(device,connection);
   device.keys=connection.storage.localKeys(master,sodium);
   if(device.signingKey)device.setProvider();
  },
  close(){connection.db.close();},
  setProvider(){
   device.provider=localProvider(sodium,device.keys,{signing:{...signing,publicKey:device.signingKey},
    content:(epochId,fn)=>device.keys.useIdentity(identity('data',epochId),fn)});
  },
  async runtime(pin){
   const resolved=await resolvePersonalAuthority(device.storage,scope,pin,device.provider,deviceId);
   return new OfflineRuntime({storage:device.storage,codec:candidateCodec(device.provider),LoroDoc,
    decodeImportBlobMeta,scope:resolved.scope,keyRef:resolved.scope.epochId,
    authority:{kind:'personal',rootPin:pin,provider:device.provider}});
  },
  async service(pin,overrides={}){
   const selection=value(await device.storage.readPersonalSelection(deviceId));
   const original={scopeId:scope.id,pin};
   return personalRotation({sodium,LoroDoc,randomUUID,selected:selection??original,selection,
    storage:device.storage,keys:device.keys,provider:device.provider,deviceId,signing,wrapping,
    signingKey:device.signingKey,wrappingKey:device.wrappingKey,...overrides});
  }
 };
 device.open();
 await device.keys.provision(masterId);
 device.signingKey=sodium.to_hex((await device.keys.generate(signing.operationId,signing.identity)).publicKey);
 device.wrappingKey=sodium.to_hex((await device.keys.generate(wrapping.operationId,wrapping.identity)).publicKey);
 device.setProvider();
 return device;
}

test('signed rotation guards the exact reviewed source and authority and atomically publishes and installs across disk reopen',async t=>{
 const dir=mkdtempSync(join(process.env.RECOVERY_TEST_DIR??homedir(),'cc-rotation-'));
 const devices=[];
 t.after(()=>{for(const d of devices)d.close();rmSync(dir,{recursive:true,force:true});});
 const device=async name=>{const result=await makeDevice(name,join(dir,name+'.sqlite'));devices.push(result);return result;};
 const sponsor=await device('survivor'),lost=await device('affected'),paired=await device('paired'),fresh=await device('fresh');
 const root={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',scopeId:scope.id,ownerId:'owner',
  signerDeviceId:sponsor.deviceId,devices:[{deviceId:sponsor.deviceId,ownerId:'owner',signingKeyRef:sponsor.signingKey,peerId:'1',active:true}],
  documentId:'old-doc',generation:1,epochId:epoch};
 const pin=await personalRootPin(sponsor.provider,root);
 const state={version:1,root,signature:sodium.to_hex(await sponsor.provider.sign(sponsor.signingKey,domain('personal-root-signature',root)))};
 await initializePersonalAuthority(sponsor.storage,scope,pin,sponsor.provider,state);
 const add=async (device,peerId)=>{
  const old=value(await sponsor.storage.readPairingAuthority(scope));
  const admission={version:1,scopeId:scope.id,ownerId:'owner',parentSnapshot:old.authorizationSnapshot,
   sponsorDeviceId:sponsor.deviceId,recipientDeviceId:device.deviceId,recipientSigningKeyRef:device.signingKey,
   recipientWrappingKeyRef:device.wrappingKey,recipientSigningKey:device.signingKey,
   recipientWrappingKey:device.wrappingKey,peerId,transcriptHash:'a'.repeat(64),guardId:'guard-'+device.deviceId};
  const signature=sodium.to_hex(await sponsor.provider.sign(sponsor.signingKey,personalAdmissionBytes(admission)));
  const {next}=await preparePersonalAdmission(sponsor.storage,scope,pin,sponsor.provider,{admission,signature});
  value(await sponsor.storage.compareAndSwapPairingAuthority({expectedRevision:old.revision,record:next}));
  return next;
 };
 await add(lost,'2');
 const originalAuthority=await add(paired,'3');
 value(await paired.storage.compareAndSwapPairingAuthority({expectedRevision:null,record:{...originalAuthority,revision:0}}));
 await sponsor.keys.generate('old-data',sponsor.identity('data'));
 const oldKey=await sponsor.keys.useIdentity(sponsor.identity('data'),key=>sodium.to_hex(key));
 let runtime=await sponsor.runtime(pin);
 await runtime.execute({operationId:'first',deviceSequence:1,command:command('first','Before review')});
 let service=await sponsor.service(pin);
 const reviewed=await service.review();
 await runtime.execute({operationId:'after-review',deviceSequence:2,command:command('after-review','After review')});
 const pairedRequest=await (await paired.service(pin)).request();
 await assert.rejects(()=>service.publish(reviewed,[lost.deviceId],[pairedRequest]),/CONFLICT/);

 function race(action){
  const commit=sponsor.storage.commitPersonalRotation.bind(sponsor.storage);
  return new Proxy(sponsor.storage,{get(target,name){
   if(name==='commitPersonalRotation')return async input=>{await action();return commit(input);};
   const member=target[name];return typeof member==='function'?member.bind(target):member;
  }});
 }
 let raced=await sponsor.service(pin,{storage:race(()=>runtime.execute({
  operationId:'during-preparation',deviceSequence:3,command:command('during-preparation','During preparation')
 }))});
 const latest=await raced.review();
 await assert.rejects(()=>raced.publish(latest,[lost.deviceId],[pairedRequest]),/CONFLICT/);
 assert.equal(value(await sponsor.storage.readPersonalRotation(scope.id,latest.operationId)),null);

 raced=await sponsor.service(pin,{storage:race(async()=>{
  const old=value(await sponsor.storage.readPairingAuthority(scope));
  value(await sponsor.storage.compareAndSwapPairingAuthority({expectedRevision:old.revision,record:{...old,revision:old.revision+1}}));
 })});
 const staleAuthority=await raced.review();
 await assert.rejects(()=>raced.publish(staleAuthority,[lost.deviceId],[pairedRequest]),/CONFLICT/);
 const accepted=value(await sponsor.storage.readPairingAuthority(scope));
 assert.equal(accepted.authorizationSnapshot,originalAuthority.authorizationSnapshot);
 assert.equal(accepted.revision,originalAuthority.revision+1);
 await assert.rejects(()=>service.publish(staleAuthority,[lost.deviceId],[pairedRequest]),/CONFLICT/);

 const keyPath=JSON.stringify(['document',scope.id,root.documentId]);
 const originalRow=sponsor.db.prepare('SELECT value FROM loro_records WHERE key=?').get(keyPath).value;
 const changed=JSON.parse(originalRow);
 changed.bytes.__storageBytes[0]^=1;
 const sameRevisionRace=await sponsor.service(pin,{storage:race(async()=>{
  sponsor.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(changed),keyPath);
 })});
 const exactSource=await sameRevisionRace.review();
 await assert.rejects(()=>sameRevisionRace.publish(exactSource,[lost.deviceId],[pairedRequest]),/CONFLICT/);
 sponsor.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(originalRow,keyPath);

 const freshService=await fresh.service(pin,{selected:{scopeId:'local-fresh',pin:'0'.repeat(64)},
  recoveryImport:{target:async()=>({scopeId:scope.id,pin,owner:'owner'})}});
 const freshRequest=await freshService.request('archive');
 const requests=[pairedRequest,freshRequest],review=await service.review();
 const sourceBytes=(await runtime.document()).doc.export({mode:'snapshot'});
 const originals=value(await sponsor.storage.listOutboundObjects(scope.id));
 await assert.rejects(()=>service.publish(review,[],requests),/INVALID_RECIPIENTS/);
 await assert.rejects(()=>service.publish(review,[lost.deviceId],[{...freshRequest,signature:'0'.repeat(128)},pairedRequest]),/INVALID_REQUEST/);

 // Two key indexes, six inherited identities, document, owner, authority and receipt.
 for(const position of Array.from({length:12},(_,i)=>i+1)){
  sponsor.failAt(position);
  await assert.rejects(()=>service.publish(review,[lost.deviceId],requests),/IO/);
  assert.deepEqual(value(await sponsor.storage.readPairingAuthority(scope)),accepted);
  assert.equal(value(await sponsor.storage.readPersonalRotation(scope.id,review.operationId)),null);
  assert.equal(value(await sponsor.storage.listRecords('document',scope.id)).length,1);
 }
 sponsor.failAt(0);
 const result=await service.publish(review,[lost.deviceId],requests);
 assert.equal(result.replayed,false);
 assert.notEqual(result.head,pin);
 const newAuthority=value(await sponsor.storage.readPairingAuthority(scope));
 assert.equal(JSON.parse(new TextDecoder().decode(newAuthority.authorityState)).base.version,2);
 assert.equal(Object.hasOwn(result.transfer.packages,lost.deviceId),false);
 await assert.rejects(()=>resolvePersonalAuthority(sponsor.storage,scope,pin,sponsor.provider,lost.deviceId),/UNAUTHORIZED_DEVICE/);
 await assert.rejects(()=>runtime.execute({operationId:'late',deviceSequence:4,command:command('late','Too late')}),/INVALID_AUTHORITY/);

 // Installing is separate. Compare the parent with the source device out of band.
 const packet=personalRecipientTransfer(result.transfer,fresh.deviceId);
 await assert.rejects(()=>freshService.install(packet,pin,'a'.repeat(64)),/VERIFY_PERSONAL_PARENT/);
 const invalidSuccessor={...packet,item:{...packet.item,signature:'0'.repeat(128)}};
 await assert.rejects(()=>freshService.install(invalidSuccessor,pin,review.parent),/INVALID_PROOF/);
 assert.equal(value(await fresh.storage.readPairingAuthority(scope)),null);
 const noArchive=await fresh.service(pin,{selected:{scopeId:'local-fresh',pin:'0'.repeat(64)}});
 await assert.rejects(()=>noArchive.install(packet,pin,review.parent),/VERIFY_PERSONAL_PARENT/);
 const wrongRecipient=personalRecipientTransfer(result.transfer,paired.deviceId);
 await assert.rejects(()=>freshService.install(wrongRecipient,pin,review.parent),/UNAUTHORIZED_DEVICE|INVALID_PROOF/);
 // The paired device has the signed parent, but has an independent SQLite revision.
 const pairedResult=await (await paired.service(pin)).install(wrongRecipient,pin,review.parent);
 assert.equal(pairedResult.replayed,false);
 // Include the selection write in the recipient fault matrix.
 for(const position of Array.from({length:13},(_,i)=>i+1)){
  fresh.failAt(position);
  await assert.rejects(()=>freshService.install(packet,pin,review.parent),/IO/);
  assert.equal(value(await fresh.storage.readPairingAuthority(scope)),null);
  assert.equal(value(await fresh.storage.readPersonalSelection(fresh.deviceId)),null);
  assert.equal(value(await fresh.storage.readPersonalRotation(scope.id,review.operationId)),null);
  assert.deepEqual(value(await fresh.storage.listRecords('document',scope.id)),[]);
 }
 fresh.failAt(0);
 const installed=await freshService.install(packet,pin,review.parent);
 assert.equal(installed.replayed,false);

 sponsor.close();sponsor.open();fresh.close();fresh.open();
 service=await sponsor.service(pin);
 const retry=await service.publish(review,[lost.deviceId],requests);
 assert.equal(retry.replayed,true);
 assert.deepEqual(retry.transfer,result.transfer);
 await assert.rejects(()=>service.publish(review,[lost.deviceId],[pairedRequest]),/CONFLICT/);
 assert.deepEqual(await service.retainedTransfer(),result.transfer);
 assert.equal((await (await fresh.service(pin)).install(packet,pin,review.parent)).replayed,true);
 const opened=await sponsor.runtime(pin);
 const recipientRuntime=await fresh.runtime(pin);
 assert.equal(opened.scope.documentGeneration,2);
 assert.equal(recipientRuntime.scope.documentId,opened.scope.documentId);
 assert.equal((await opened.document()).doc.getMap('personal-preferences').get('city'),'During preparation');
 assert.equal((await recipientRuntime.document()).doc.getMap('personal-preferences').get('city'),'During preparation');
 const newKey=await sponsor.keys.useIdentity(sponsor.identity('data',opened.scope.epochId),key=>sodium.to_hex(key));
 assert.notEqual(newKey,oldKey);
 assert.equal(await fresh.keys.useIdentity(fresh.identity('data',opened.scope.epochId),key=>sodium.to_hex(key)),newKey);
 await assert.rejects(()=>lost.keys.useIdentity(lost.identity('data',opened.scope.epochId),()=>{}),/NOT_FOUND/);
 const oldDoc=value(await sponsor.storage.listRecords('document',scope.id)).find(v=>v.identity[0]===root.documentId);
 const oldLoro=new LoroDoc();oldLoro.import(oldDoc.value.bytes);
 const source=new LoroDoc();source.import(sourceBytes);
 assert.deepEqual(oldLoro.toJSON(),source.toJSON());
 assert.deepEqual(value(await sponsor.storage.listOutboundObjects(scope.id)),originals);
 const wrongKeyPacket={...packet,recipientPackage:packet.recipientPackage.replace(/^../,'00')};
 const reopenedService=await fresh.service(pin);
 await assert.rejects(()=>reopenedService.install(wrongKeyPacket,pin,review.parent),/CONFLICT/);
 const sibling=await device('sibling');
 const oldAuthority=value(await sponsor.storage.readPairingAuthority(scope));
 await add(sibling,'4');
 const advanced=value(await sponsor.storage.readPairingAuthority(scope));
 assert.equal(advanced.acceptedParent,oldAuthority.acceptedParent);
 assert.equal((await resolvePersonalAuthority(sponsor.storage,scope,pin,sponsor.provider,sibling.deviceId)).scope.epochId,opened.scope.epochId);
 await assert.rejects(()=>resolvePersonalAuthority(sponsor.storage,scope,pin,sponsor.provider,lost.deviceId),/UNAUTHORIZED_DEVICE/);
 await recipientRuntime.execute({operationId:'new-save',deviceSequence:1,command:command('new-save','After rotation')});
 const recovery=workspaceRecovery({sodium,storage:fresh.storage,keys:fresh.keys,run:fresh.storage.recoveryTransaction,
  master:fresh.master,masterId,scopeId:scope.id,deviceId:fresh.deviceId,pin,provider:fresh.provider});
 const archive=await recovery.create(),verified=await openRecoveryArchive(sodium,archive.archive,archive.code);
 assert.deepEqual(verified.body.catalog.keyRefs,[opened.scope.epochId]);
 assert.deepEqual(verified.body.catalog.trustedCheckpoints,[result.head]);
 assert.equal(verified.body.snapshot.documentId,opened.scope.documentId);
});
