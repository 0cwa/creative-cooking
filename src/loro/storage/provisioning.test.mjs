import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webcrypto} from 'node:crypto';
import sodium from 'libsodium-wrappers';
import {openSQLiteStorage} from './sqlite.ts';
await sodium.ready;
function persistentMaster(){
 let key,id,creations=0;
 async function provision(name){if(key||id)throw Error('LOCKED');key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);id=name;creations++;}
 async function ensure(name){if(key||id){if(!key||id!==name)throw Error('LOCKED');return;}await provision(name);}
 return {provision,ensure,get creations(){return creations;},async wrap(name,p,a){if(name!==id||!key)throw Error('LOCKED');const iv=webcrypto.getRandomValues(new Uint8Array(12));return new Uint8Array([...iv,...new Uint8Array(await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:a},key,p))]);},async unwrap(name,v,a){if(name!==id||!key)throw Error('LOCKED');return new Uint8Array(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:v.slice(0,12),additionalData:a},key,v.slice(12)));}};
}
for(const phase of ['reservation','master','ready'])test(`matching master provisioning resumes after ${phase} interruption without replacement`,async()=>{
 const directory=mkdtempSync(join(tmpdir(),'loro-provisioning-')),path=join(directory,'records.sqlite');
 let db=new DatabaseSync(path),failReady=phase==='ready';
 const conn={executeSync(sql,args=[]){if(failReady&&sql.startsWith('INSERT')&&args[0]===JSON.stringify(['local-master-catalog'])&&JSON.parse(args[1]).state==='ready')throw Error('injected ready');const st=db.prepare(sql);return {rows:sql.startsWith('SELECT')?st.all(...args):(st.run(...args),[])};}};
 const master=persistentMaster(),fail=async()=>{throw Error('injected interruption');};
 try{
  const failing={...master,provision:phase==='reservation'?fail:master.provision,ensure:phase==='reservation'?fail:master.ensure,wrap:phase==='master'?fail:master.wrap};
  await assert.rejects(openSQLiteStorage(conn).localKeys(failing,sodium).provision('master'),/injected/);
  const aad=new Uint8Array([1]),plain=new Uint8Array([4,5,6]),saved=phase==='reservation'?null:await master.wrap('master',plain,aad);
  db.close();db=new DatabaseSync(path);failReady=false;
  const keys=openSQLiteStorage(conn).localKeys(master,sodium);
  await assert.rejects(keys.provision('different'),/LOCKED/);
  await keys.provision('master');assert.equal(master.creations,1);
  const catalog=await keys.unlock();await keys.provision('master');assert.deepEqual(await keys.unlock(),catalog);assert.equal(master.creations,1);
  if(saved)assert.deepEqual(await master.unwrap('master',saved,aad),plain);
  await assert.rejects(master.provision('master'),/LOCKED/);
  const identity={version:1,scope:{kind:'personal',id:'owner'},deviceId:'device',purpose:'data',epochId:'epoch'};
  await keys.generate('data',identity);await keys.use('data',identity,key=>assert.equal(key.length,32));
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
test('authority-owned documents do not prevent first master provisioning',async()=>{
 const db=new DatabaseSync(':memory:'),storage=openSQLiteStorage({executeSync(sql,args=[]){const st=db.prepare(sql);return {rows:sql.startsWith('SELECT')?st.all(...args):(st.run(...args),[])};}});
 try{
  const scope={kind:'household',id:'home'},record={scope,revision:0,acceptedParent:'head',authorizationSnapshot:'snapshot',authorityState:new Uint8Array([1])};
  assert.equal((await storage.compareAndSwapPairingAuthority({expectedRevision:null,record})).ok,true);
  assert.equal((await storage.commitLocal({expectedAuthority:{version:2,scope,record:{revision:0,acceptedParent:'head',authorizationSnapshot:'snapshot'}},scopeId:'home',operationId:'edit',documents:[{documentId:'doc',bytes:new Uint8Array([1]),expectedRevision:null}],commands:[{version:1,commandId:'command',effectId:'effect',documentId:'doc',kind:'write',payload:new Uint8Array([1]),dependencyEffectIds:[]}],outbound:[]})).ok,true);
  const keys=storage.localKeys(persistentMaster(),sodium);await keys.provision('master');assert.equal((await keys.unlock()).id,'master');
  assert.equal((await storage.reopenDocument('home','doc')).value.revision,0);
 }finally{db.close();}
});
