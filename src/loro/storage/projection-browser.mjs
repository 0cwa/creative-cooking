import sodium from 'libsodium-wrappers';
import {LoroDoc} from 'loro-crdt';
import {openIndexedDBStorage} from './indexeddb.ts';
export async function run(){
 await sodium.ready;const name='projection-'+crypto.randomUUID();let count=0,failAt=0,db=await openIndexedDBStorage(name,x=>{if(x==='write' && ++count===failAt)throw Error('injected')});
 const ok=(v,m)=>{if(!v)throw Error(m)};let masterKey,masterId;
 const master={async provision(id){masterId=id;masterKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])},async wrap(id,p,a){if(id!==masterId)throw Error('LOCKED');const iv=crypto.getRandomValues(new Uint8Array(12)),v=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:a},masterKey,p));return new Uint8Array([...iv,...v])},async unwrap(id,v,a){if(id!==masterId)throw Error('LOCKED');return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:v.slice(0,12),additionalData:a},masterKey,v.slice(12)))}};
 const scope={kind:'household',id:'scope'};
 try{
  const s=db.storage,keys=db.localKeys(master,sodium);await keys.provision('master');
  const child={expectedAuthority:{version:2,scope:{kind:'personal',id:'personal'},record:null},scopeId:'personal',operationId:'group-child',documents:[{documentId:'personal-doc',bytes:new Uint8Array([1]),expectedRevision:null}],commands:[{version:1,commandId:'cmd',effectId:'effect',documentId:'personal-doc',kind:'test',payload:new Uint8Array([2]),dependencyEffectIds:[]}],outbound:[]};
  ok((await s.commitLocalGroup({groupId:'group',children:[child]})).ok,'group');ok((await s.getLocalGroup('group')).value.group.children[0].operationId==='group-child','group recovery');
  ok((await s.compareAndSwapPairingAuthority({expectedRevision:null,record:{scope,revision:0,acceptedParent:'parent',authorizationSnapshot:'before',authorityState:new Uint8Array([1])}})).ok,'bootstrap');
  const recipient=sodium.crypto_box_keypair(),identity={version:1,scope,deviceId:'device',purpose:'data',epochId:'new-epoch'};
  const prepared=await keys.prepareForAtomicInstall('keyop',identity,secret=>sodium.crypto_box_seal(secret,recipient.publicKey));
  const doc=new LoroDoc();doc.getMap('recipe').set('title','soup');
  const input={version:1,operationId:'pub',expectedAuthority:{version:2,scope,record:{revision:0,acceptedParent:'parent',authorizationSnapshot:'before'}},nextAuthority:{scope,revision:1,acceptedParent:'child',authorizationSnapshot:'after',authorityState:new Uint8Array([2])},admissionEventHash:'admission',grantHash:'grant',manifest:{id:'manifest',bytes:new Uint8Array([3])},epochId:'new-epoch',documents:[{documentId:'fresh',generation:2,bytes:doc.export({mode:'snapshot'})}],packages:[{id:'packet',recipientDevice:'recipient',bytes:prepared.packets}],localKey:{record:prepared.record,catalog:prepared.catalog},pendingEdits:[]};
  for(let n=1;n<=10;n++){count=0;failAt=n;ok(!(await s.publishProjection(input)).ok,'write did not fail '+n);ok((await s.readPairingAuthority(scope)).value.revision===0,'authority advanced');ok((await s.reopenDocument('scope','fresh')).value===null,'document persisted');}
  count=0;failAt=0;ok((await s.publishProjection(input)).ok,'publication');db.close();db=await openIndexedDBStorage(name);
  ok((await db.storage.getLocalGroup('group')).value.group.children[0].operationId==='group-child','group reopen');
  const saved=await db.storage.getProjectionPublication('scope','pub');ok(saved.ok && saved.value,'reopen');ok((await db.storage.publishProjection(input)).value.replayed,'retry');
  const received=sodium.crypto_box_seal_open(saved.value.packages[0].bytes,recipient.publicKey,recipient.privateKey);await db.localKeys(master,sodium).use('keyop',identity,key=>ok(sodium.memcmp(key,received),'key mismatch'));
  const fresh=new LoroDoc();fresh.import((await db.storage.reopenDocument('scope','fresh')).value.bytes);ok(fresh.getMap('recipe').get('title')==='soup','document');
  return 'IndexedDB publication: every write rolled back, real key package and Loro document survived reopen';
 }finally{db.close();await new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase(name);q.onsuccess=resolve;q.onerror=()=>reject(q.error)})}
}
