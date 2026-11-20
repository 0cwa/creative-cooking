import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import sodium from 'libsodium-wrappers';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {domain} from '../authority/validator.mjs';
import {rootPin,policyId,initializeAuthority,observeSuccessor,readAuthority} from '../authority/chain.mjs';
await sodium.ready;

test('signed policy successor rejects every extraneous rotation before durable authority changes',async()=>{
 const db=new DatabaseSync(':memory:');
 const conn={executeSync:(sql,params=[])=>{const statement=db.prepare(sql);return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])}}};
 const storage=openSQLiteStorage(conn),scope={kind:'household',id:'house'},keys=Object.fromEntries(['a','b'].map(d=>[d,sodium.crypto_sign_keypair()]));
 const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async(k,b,s)=>sodium.crypto_sign_verify_detached(s,b,keys[k].publicKey)};
 const hex=b=>Buffer.from(b).toString('hex'),sign=(d,p,v)=>hex(sodium.crypto_sign_detached(domain(p,v),keys[d].privateKey));
 const policy={kind:'allMinusOne',fixedCount:null},root={householdId:'house',head:'',policyHash:await policyId(provider,policy),generation:1,epochId:'epoch',roster:['a','b'],devices:['a','b'].map(d=>({adultId:d,deviceId:d,signingKeyRef:d,active:true})),policy,runtime:{documentId:'cooking',authorPeers:{a:'1',b:'2'},acceptedRecipients:['a','b']}};
 root.head=await rootPin(provider,root);
 const event={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',householdId:'house',parentHead:root.head,policyHash:root.policyHash,generation:1,epochId:'epoch',proposalId:'policy',kind:'changePolicy',authorDeviceId:'a',frozenAdultRoster:['a','b'],subject:null,nextPolicy:{kind:'unanimous',fixedCount:null}};
 const eventHash=hex(await provider.hash(domain('event',event))),approval={version:1,householdId:'house',eventHash,parentHead:root.head,policyHash:root.policyHash,generation:1,epochId:'epoch',adultId:'a',deviceId:'a'},item={event,authorSignature:sign('a','event-signature',event),approvals:[{...approval,signature:sign('a','approval-signature',approval)}]};
 try {
  await initializeAuthority(storage,root,root.head,provider);
  const before=await storage.readPairingAuthority(scope),raw=()=>JSON.stringify(db.prepare('SELECT key,value FROM loro_records ORDER BY key').all()),original=raw();
  for(const rotation of [{},null,false,[]]){
   await assert.rejects(observeSuccessor(storage,scope,root.head,provider,{...item,rotation}),/UNSUPPORTED_TRANSITION/);
   assert.equal(raw(),original);
   assert.deepEqual(await storage.readPairingAuthority(scope),before);
   const state=await readAuthority(storage,scope,root.head,provider);assert.equal(state.revision,0);assert.equal(state.activeHead,root.head);assert.equal(state.state.events.length,0);
  }
  assert.equal(await observeSuccessor(storage,scope,root.head,provider,item),eventHash);
  const result=await readAuthority(openSQLiteStorage(conn),scope,root.head,provider);assert.equal(result.revision,1);assert.equal(result.state.events.length,1);assert.equal(result.state.events[0].event.proposalId,'policy');
 } finally {db.close()}
});
