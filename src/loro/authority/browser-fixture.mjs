import sodium from 'libsodium-wrappers';
import {openIndexedDBStorage} from '../storage/indexeddb.ts';
import {domain} from './validator.mjs';
import {rootPin,policyId,initializeAuthority,observeSuccessor,readAuthority} from './chain.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export async function run() {
 await sodium.ready; const kp=sodium.crypto_sign_keypair();
 const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async(k,b,s)=>k==='key' && sodium.crypto_sign_verify_detached(s,b,kp.publicKey)};
 const sign=(purpose,v)=>hex(sodium.crypto_sign_detached(domain(purpose,v),kp.privateKey));
 const policy={kind:'allMinusOne',fixedCount:null};
 const root={householdId:'house',head:'',policyHash:await policyId(provider,policy),generation:1,epochId:'epoch',roster:['a'],devices:[{adultId:'a',deviceId:'a1',signingKeyRef:'key',active:true}],policy}; root.head=await rootPin(provider,root);
 const name='authority-'+crypto.randomUUID(), scope={kind:'household',id:'house'}; let fail=false;
 let db=await openIndexedDBStorage(name,x=>{if(fail && x==='write')throw Error('injected')});
 try {
  await initializeAuthority(db.storage,root,root.head,provider);
  const event={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',householdId:'house',parentHead:root.head,policyHash:root.policyHash,generation:1,epochId:'epoch',proposalId:'p',kind:'changePolicy',authorDeviceId:'a1',frozenAdultRoster:['a'],subject:null,nextPolicy:{kind:'unanimous',fixedCount:null}};
  const eventHash=hex(await provider.hash(domain('event',event))), a={version:1,householdId:'house',eventHash,parentHead:root.head,policyHash:root.policyHash,generation:1,epochId:'epoch',adultId:'a',deviceId:'a1'};
  const item={event,authorSignature:sign('event-signature',event),approvals:[{...a,signature:sign('approval-signature',a)}]};
  fail=true; let rejected=false;try {await observeSuccessor(db.storage,scope,root.head,provider,item)} catch {rejected=true} if(!rejected)throw Error('fault did not abort');
  fail=false; if ((await readAuthority(db.storage,scope,root.head,provider)).heads[0]!==root.head)throw Error('failed write persisted');
  await observeSuccessor(db.storage,scope,root.head,provider,item); db.close(); db=await openIndexedDBStorage(name);
  const view=await readAuthority(db.storage,scope,root.head,provider); if(view.activeHead!==root.head || view.heads.length!==1 || view.heads[0]!==eventHash)throw Error('reopen mismatch');
  return 'IndexedDB signed successor, rollback and reopen passed';
 } finally {db.close();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});}
}
