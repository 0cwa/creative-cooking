import {openIndexedDBStorage} from './indexeddb.js';
import {openBrowserMaster} from './browser-master.js';
const check=(v,m)=>{if(!v)throw Error(m)};
const equal=(a,b)=>JSON.stringify(Array.from(a))===JSON.stringify(Array.from(b));
const del=name=>new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('blocked '+name));});
const reject=async(fn,label)=>{try{await fn()}catch(e){check(e.message.includes('LOCKED')||e.message.includes('injected'),label+': '+e);return}throw Error(label+' unexpectedly succeeded')};
const record=async(name,operation)=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const tx=db.transaction('master','readwrite'),s=tx.objectStore('master');let result;operation(s,x=>{result=x});tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}finally{db.close()}};
export async function run(){
 const names=[];const name=prefix=>{const n=prefix+'-'+crypto.randomUUID();names.push(n);return n};
 const aad=new Uint8Array([9]),plain=new Uint8Array([4,5,6]);
 try{
  for(const phase of ['reservation','master','ready']){
   const records=name('records'),masters=name('master');let db=await openIndexedDBStorage(records),master=await openBrowserMaster(masters);
   const fault=async()=>{throw Error('injected '+phase)};const proxy={...master};
   if(phase==='reservation')proxy.ensure=fault;
   if(phase==='master')proxy.wrap=fault;
   let originalPut;
   if(phase==='ready'){originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(key===JSON.stringify(['local-master-catalog'])&&value?.state==='ready')throw Error('injected ready');return originalPut.apply(this,arguments)}}
   try{await reject(()=>db.localKeys(proxy,{}).provision('master'),phase)}finally{if(originalPut)IDBObjectStore.prototype.put=originalPut}
   const saved=phase==='reservation'?null:await master.wrap('master',plain,aad);
   db.close();master.close();db=await openIndexedDBStorage(records);master=await openBrowserMaster(masters);const keys=db.localKeys(master,{});
   await reject(()=>keys.provision('wrong'),'wrong reservation');await keys.provision('master');const first=await keys.unlock();await keys.provision('master');const second=await keys.unlock();check(equal(first.check,second.check),'ready retry replaced catalog');if(saved)check(equal(await master.unwrap('master',saved,aad),plain),'master replaced at '+phase);
   const after=await master.wrap('master',plain,aad);db.close();master.close();db=await openIndexedDBStorage(records);master=await openBrowserMaster(masters);check(equal(await master.unwrap('master',after,aad),plain),'reopen master '+phase);await db.localKeys(master,{}).unlock();db.close();master.close();
  }
  {const records=name('concurrent-records'),masters=name('concurrent-master'),db1=await openIndexedDBStorage(records),db2=await openIndexedDBStorage(records),m1=await openBrowserMaster(masters),m2=await openBrowserMaster(masters);await Promise.all([m1.ensure('master'),m2.ensure('master')]);const saved=await m1.wrap('master',plain,aad);await Promise.all([db1.localKeys(m1,{}).provision('master'),db2.localKeys(m2,{}).provision('master')]);check(equal(await m2.unwrap('master',saved,aad),plain),'concurrent master replacement');db1.close();db2.close();m1.close();m2.close();}
  for(const mode of ['missing marker','missing key','wrong marker','invalid key']){
   const records=name('damaged-records'),masters=name('damaged-master');let db=await openIndexedDBStorage(records),master=await openBrowserMaster(masters);await db.localKeys(master,{}).provision('master');const saved=await master.wrap('master',plain,aad);db.close();master.close();
   const invalid=mode==='invalid key'?await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']):null;
   await record(masters,s=>{if(mode==='missing marker')s.delete('marker');if(mode==='missing key')s.delete('key');if(mode==='wrong marker')s.put('wrong','marker');if(mode==='invalid key')s.put(invalid,'key')});
   db=await openIndexedDBStorage(records);master=await openBrowserMaster(masters);const readPair=()=>record(masters,(s,set)=>{const a=s.get('marker'),b=s.get('key');b.onsuccess=()=>set({marker:a.result,key:b.result})});const before=await readPair();
   await reject(()=>db.localKeys(master,{}).provision('master'),mode);await reject(()=>master.ensure('master'),mode+' ensure');
   const after=await readPair();check(before.marker===after.marker,mode+' marker overwritten');check((before.key===undefined)===(after.key===undefined),mode+' key presence changed');if(mode==='invalid key'){check(after.key instanceof CryptoKey && after.key.extractable,mode+' key changed');const iv=new Uint8Array(12);const probe=await crypto.subtle.encrypt({name:'AES-GCM',iv},before.key,plain);check(equal(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv},after.key,probe)),plain),mode+' key replaced')}if(mode==='missing marker'||mode==='wrong marker'){await record(masters,s=>s.put('master','marker'));check(equal(await master.unwrap('master',saved,aad),plain),mode+' surviving key replaced')}db.close();master.close();
  }
  {const records=name('owned-records'),masters=name('owned-master'),db=await openIndexedDBStorage(records),master=await openBrowserMaster(masters);const scope={kind:'household',id:'home'},authority={scope,revision:0,acceptedParent:'head',authorizationSnapshot:'snapshot',authorityState:new Uint8Array([1])};check((await db.storage.compareAndSwapPairingAuthority({expectedRevision:null,record:authority})).ok,'authority');const input={expectedAuthority:{version:2,scope,record:{revision:0,acceptedParent:'head',authorizationSnapshot:'snapshot'}},scopeId:'home',operationId:'edit',documents:[{documentId:'doc',bytes:new Uint8Array([1]),expectedRevision:null}],commands:[{version:1,commandId:'command',effectId:'effect',documentId:'doc',kind:'write',payload:new Uint8Array([1]),dependencyEffectIds:[]}],outbound:[]};check((await db.storage.commitLocal(input)).ok,'owned document');await db.localKeys(master,{}).provision('master');check((await db.storage.reopenDocument('home','doc')).value.revision===0,'owned document reopen');db.close();master.close();}
  return 'IndexedDB/WebCrypto: reservation, master and ready recovery; concurrent ensure/provision; four damaged master cases; authority-owned document passed';
 }finally{for(const n of names)await del(n)}
}
