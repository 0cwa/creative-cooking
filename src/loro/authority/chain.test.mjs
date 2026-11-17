import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import sodium from 'libsodium-wrappers';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {domain} from './validator.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt';
import {candidateCodec} from '../crypto/candidate.mjs';
import {testProvider} from '../crypto/test-provider.mjs';
import {rootPin,policyId,initializeAuthority,observeSuccessor,selectHead,readAuthority,resolveRuntimeAuthority,verifyAuthority,acceptAdmissionAgreement} from './chain.mjs';
await sodium.ready;
const hex=b=>Buffer.from(b).toString('hex');
const pair=Object.fromEntries(['a','b'].map(k=>[k,sodium.crypto_sign_keypair()]));
const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async(k,b,s)=>sodium.crypto_sign_verify_detached(s,b,pair[k].publicKey)};
const sign=(k,p,v)=>hex(sodium.crypto_sign_detached(domain(p,v),pair[k].privateKey));
const db=new DatabaseSync(':memory:');
const conn={executeSync:(sql,params=[])=>{const s=db.prepare(sql);return {rows:sql.startsWith('SELECT')?s.all(...params):(s.run(...params),[])}}};
const scope={kind:'household',id:'house'};
const p={kind:'allMinusOne',fixedCount:null};
const root={householdId:'house',head:'',policyHash:await policyId(provider,p),generation:1,epochId:'epoch',roster:['a','b'],devices:[{adultId:'a',deviceId:'a',signingKeyRef:'a',active:true},{adultId:'b',deviceId:'b',signingKeyRef:'b',active:true}],policy:p,runtime:{documentId:'cooking',authorPeers:{a:'1',b:'2'},acceptedRecipients:['a','b']}};
root.head=await rootPin(provider,root);
const event=name=>({version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',householdId:'house',parentHead:root.head,policyHash:root.policyHash,generation:1,epochId:'epoch',proposalId:name,kind:'changePolicy',authorDeviceId:'a',frozenAdultRoster:['a','b'],subject:null,nextPolicy:{kind:'unanimous',fixedCount:null}});
async function item(name){const e=event(name),eventHash=hex(await provider.hash(domain('event',e)));const approval={version:1,householdId:'house',eventHash,parentHead:root.head,policyHash:root.policyHash,generation:1,epochId:'epoch',adultId:'a',deviceId:'a'};return {event:e,authorSignature:sign('a','event-signature',e),approvals:[{...approval,signature:sign('a','approval-signature',approval)}]}}
function isolatedStore() {const database=new DatabaseSync(':memory:');return {database,storage:openSQLiteStorage({executeSync:(sql,params=[])=>{const statement=database.prepare(sql);return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])}}})};}
for (const field of ['acceptedRecipients','roster','devices']) test(`sparse ${field} cannot initialize durable authority`,async()=>{
 const {database,storage}=isolatedStore();
 try {
  const candidate=structuredClone(root);
  if(field==='acceptedRecipients')candidate.runtime.acceptedRecipients=Array(1);
  else candidate[field].length++;
  candidate.head=await rootPin(provider,candidate);
  await assert.rejects(initializeAuthority(storage,candidate,candidate.head,provider),/INVALID_ROOT/);
  assert.equal((await storage.readPairingAuthority(scope)).value,null);
  await initializeAuthority(storage,root,root.head,provider);
  assert.equal((await readAuthority(storage,scope,root.head,provider)).activeHead,root.head);
 } finally {database.close();}
});
test('authority state cannot be an array with named record fields',async()=>{
 const state=Object.assign([],{version:1,root,events:[],selections:[],activeHead:root.head});
 await assert.rejects(verifyAuthority(state,root.head,provider),/MALFORMED/);
});
test('array event wrappers leave the durable authority unchanged',async()=>{
 const {database,storage}=isolatedStore();
 try {await initializeAuthority(storage,root,root.head,provider);const before=await storage.readPairingAuthority(scope);
  await assert.rejects(observeSuccessor(storage,scope,root.head,provider,Object.assign([],await item('array-event'))),/MALFORMED/);
  assert.deepEqual(await storage.readPairingAuthority(scope),before);
  assert.equal((await readAuthority(storage,scope,root.head,provider)).activeHead,root.head);
 } finally {database.close();}
});
test('array selection wrappers leave the durable authority unchanged',async()=>{
 const {database,storage}=isolatedStore();
 try {await initializeAuthority(storage,root,root.head,provider);const to=await observeSuccessor(storage,scope,root.head,provider,await item('array-selection'));
  const before=await storage.readPairingAuthority(scope),payload={root:root.head,householdId:'house',from:root.head,to,deviceId:'a',index:0};
  const selection=Object.assign([],{from:root.head,to,deviceId:'a',index:0,signature:sign('a','select-head',payload)});
  await assert.rejects(selectHead(storage,scope,root.head,provider,selection),/INVALID_SELECTION/);
  assert.deepEqual(await storage.readPairingAuthority(scope),before);
  assert.equal((await readAuthority(storage,scope,root.head,provider)).activeHead,root.head);
 } finally {database.close();}
});
test('durable siblings and signed deliberate selection survive reopen; failed CAS leaves state',async()=>{
 let fail=false; const store=openSQLiteStorage(conn,x=>{if(fail && x==='write')throw Error('fault')});
 await initializeAuthority(store,root,root.head,provider);
 const resolved=await resolveRuntimeAuthority(store,scope,root.head,provider,'a');
 const recipient=sodium.crypto_box_keypair();
 const crypto=testProvider(sodium,{signing:pair.a,publicSigning:pair.a.publicKey,recipient,publicRecipient:recipient.publicKey,initialKey:sodium.randombytes_buf(32)});
 const cp={...crypto,sign:async (who,bytes)=>{if(who!=='a')throw Error('MISSING_KEY');return sodium.crypto_sign_detached(bytes,pair.a.privateKey)},verify:async(who,bytes,sig)=>who==='a' && sodium.crypto_sign_verify_detached(sig,bytes,pair.a.publicKey)};
 const makeRuntime=opts=>new OfflineRuntime({storage:store,codec:candidateCodec(cp),LoroDoc,decodeImportBlobMeta,scope:resolved.scope,keyRef:'data',authority:{rootPin:root.head,provider},...opts});
 const runtime=makeRuntime({}); await runtime.execute({operationId:'op',command:{kind:'recipe-title',commandId:'c',effectId:'e',value:'soup'},deviceSequence:1});
 assert.equal((await runtime.read()).recipe.title,'soup');
 const altered=structuredClone(resolved.scope); altered.authorPeers.a='99';
 await assert.rejects(makeRuntime({scope:altered}).authorize(),/INVALID_AUTHORITY/);
 await assert.rejects(makeRuntime({authority:{rootPin:'wrong',provider}}).authorize(),/INVALID_ROOT/);

 const before=await store.readPairingAuthority(scope);
 await assert.rejects(observeSuccessor(store,scope,root.head,provider,{...await item('malformed'),extra:true}),/MALFORMED/);
 assert.deepEqual(await store.readPairingAuthority(scope),before);
 const firstItem=await item('first');
 const first=await observeSuccessor(store,scope,root.head,provider,firstItem);
 const reused=await item('second'); reused.approvals=firstItem.approvals;
 await assert.rejects(observeSuccessor(store,scope,root.head,provider,reused),/CONTEXT_MISMATCH/);
 const second=await observeSuccessor(store,scope,root.head,provider,await item('second'));
 let view=await readAuthority(openSQLiteStorage(conn),scope,root.head,provider);
 assert.deepEqual(new Set(view.heads),new Set([first,second])); assert.equal(view.activeHead,root.head);
 const payload={root:root.head,householdId:'house',from:root.head,to:first,deviceId:'a',index:0};
 const selection={from:root.head,to:first,deviceId:'a',index:0,signature:sign('a','select-head',payload)};
 fail=true; await assert.rejects(selectHead(store,scope,root.head,provider,selection)); fail=false;
 assert.equal((await readAuthority(store,scope,root.head,provider)).activeHead,root.head);
 await selectHead(store,scope,root.head,provider,selection);
 await assert.rejects(runtime.authorize(),/INVALID_AUTHORITY/);
 const switched=await resolveRuntimeAuthority(store,scope,root.head,provider,'a');
 const siblingRuntime=makeRuntime({scope:switched.scope});
 await assert.rejects(siblingRuntime.read(),/CHECKOUT_REQUIRED/);
 await assert.rejects(siblingRuntime.execute({operationId:'branch-op',command:{kind:'recipe-title',commandId:'branch-c',effectId:'branch-e',value:'branch'},deviceSequence:2}),/CHECKOUT_REQUIRED/);
 view=await readAuthority(openSQLiteStorage(conn),scope,root.head,provider);assert.equal(view.activeHead,first);assert.deepEqual(new Set(view.heads),new Set([first,second]));
 await assert.rejects(readAuthority(store,scope,'wrong',provider),/INVALID_ROOT/);
 db.close();
});
test('switching sibling heads cannot read or extend the other branch snapshot',async()=>{
 const mk=()=>{const db=new DatabaseSync(':memory:');const c={executeSync:(sql,args=[])=>{const st=db.prepare(sql);return {rows:sql.startsWith('SELECT')?st.all(...args):(st.run(...args),[])}}};return {db,store:openSQLiteStorage(c)}};
 const one=mk(),two=mk(); const clients=[one,two];
 try {
  for(const x of clients)await initializeAuthority(x.store,root,root.head,provider);
  const firstItem=await item('branch-a'),secondItem=await item('branch-b');let first,second;
  for(const x of clients){first=await observeSuccessor(x.store,scope,root.head,provider,firstItem);second=await observeSuccessor(x.store,scope,root.head,provider,secondItem)}
  const select=async(x,from,to,index)=>{const p={root:root.head,householdId:'house',from,to,deviceId:'a',index};await selectHead(x.store,scope,root.head,provider,{from,to,deviceId:'a',index,signature:sign('a','select-head',p)})};
  await select(one,root.head,first,0);await select(two,root.head,second,0);
  const recipient=sodium.crypto_box_keypair(), crypt=testProvider(sodium,{signing:pair.a,publicSigning:pair.a.publicKey,recipient,publicRecipient:recipient.publicKey,initialKey:sodium.randombytes_buf(32)});
  const cp={...crypt,sign:async(w,b)=>sodium.crypto_sign_detached(b,pair.a.privateKey),verify:async(w,b,s)=>sodium.crypto_sign_verify_detached(s,b,pair.a.publicKey)};
  const runtime=async(x)=>new OfflineRuntime({storage:x.store,codec:candidateCodec(cp),LoroDoc,decodeImportBlobMeta,scope:(await resolveRuntimeAuthority(x.store,scope,root.head,provider,'a')).scope,keyRef:'data',authority:{rootPin:root.head,provider}});
  await (await runtime(one)).execute({operationId:'a-op',command:{kind:'recipe-title',commandId:'a-c',effectId:'a-e',value:'A secret'},deviceSequence:1});
  await select(one,first,second,1);const switched=await runtime(one);
  await assert.rejects(switched.read(),/CHECKOUT_REQUIRED/);await assert.rejects(switched.execute({operationId:'b-op',command:{kind:'recipe-title',commandId:'b-c',effectId:'b-e',value:'B'},deviceSequence:2}),/CHECKOUT_REQUIRED/);
  const b=await runtime(two);assert.deepEqual((await b.read()).recipe,{});await b.execute({operationId:'b-op',command:{kind:'recipe-title',commandId:'b-c',effectId:'b-e',value:'B'},deviceSequence:2});assert.equal((await b.read()).recipe.title,'B');
  const bObject=(await two.store.listOutboundObjects('house')).value[0];
  await assert.rejects(switched.importItem({itemId:bObject.objectId,bytes:bObject.bytes}),/CHECKOUT_REQUIRED/);
  await select(one,second,first,2);assert.equal((await (await runtime(one)).read()).recipe.title,'A secret');
 } finally {one.db.close();two.db.close()}
});

test('signed delegation persists and replays from the pinned parent; bad acceptance writes nothing',async()=>{
 const {database,storage}=isolatedStore();
 try {
  await initializeAuthority(storage,root,root.head,provider);
  const agreement={version:1,householdId:'house',parentHead:root.head,policyHash:root.policyHash,roster:['a','b'],delegation:'currentCooking',sourcePolicyHashes:[root.policyHash]};
  const acceptances=['a','b'].map(deviceId=>({adultId:deviceId,deviceId,signature:sign(deviceId,'admission-agreement-acceptance',{agreement,adultId:deviceId,deviceId})}));
  const before=await storage.readPairingAuthority(scope);
  await assert.rejects(acceptAdmissionAgreement(storage,scope,root.head,provider,{...agreement,acceptances:acceptances.slice(0,1)}));
  assert.deepEqual(await storage.readPairingAuthority(scope),before);
  const hash=await acceptAdmissionAgreement(storage,scope,root.head,provider,{...agreement,acceptances});
  assert.match(hash,/^[0-9a-f]{64}$/);
  const view=await readAuthority(storage,scope,root.head,provider);
  assert.equal(view.state.agreements.length,1);
  await assert.rejects(acceptAdmissionAgreement(storage,scope,root.head,provider,{...agreement,acceptances}),/INVALID_AGREEMENT/);
 } finally {database.close()}
});
