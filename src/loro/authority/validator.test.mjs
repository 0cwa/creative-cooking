import {test} from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import {validateSuccessor, domain} from './validator.mjs';
await sodium.ready;
const hex = b => Buffer.from(b).toString('hex');
const pairs = Object.fromEntries(['a1','a2','b1','c1','revoked'].map(id=>[id,sodium.crypto_sign_keypair()]));
const provider = {hash:async b=>sodium.crypto_generichash(32,b),verify:async (id,b,s)=>!!pairs[id] && sodium.crypto_sign_verify_detached(s,b,pairs[id].publicKey)};
const sign = (id,purpose,value)=>hex(sodium.crypto_sign_detached(domain(purpose,value),pairs[id].privateKey));
const parent = {householdId:'house',head:'head',policyHash:'policy',generation:1,epochId:'epoch',roster:['a','b','c'],devices:[{deviceId:'a1',signingKeyRef:'a1',adultId:'a',active:true},{deviceId:'a2',signingKeyRef:'a2',adultId:'a',active:true},{deviceId:'b1',signingKeyRef:'b1',adultId:'b',active:true},{deviceId:'c1',signingKeyRef:'c1',adultId:'c',active:true},{deviceId:'revoked',signingKeyRef:'revoked',adultId:'a',active:false}],policy:{kind:'allMinusOne',fixedCount:null},runtime:{documentId:'cooking',authorPeers:{a1:'1',a2:'2',b1:'3',c1:'4'},acceptedRecipients:['a1','a2','b1','c1']}};
const event = (changes={})=>({version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',householdId:'house',parentHead:'head',policyHash:'policy',generation:1,epochId:'epoch',proposalId:'proposal',kind:'changePolicy',authorDeviceId:'a1',frozenAdultRoster:['a','b','c'],subject:null,nextPolicy:{kind:'unanimous',fixedCount:null},...changes});
async function run(p,e,votes) {
 const digest=hex(await provider.hash(domain('event',e)));
 const approvals=votes.map(([adultId,deviceId])=>{const a={version:1,householdId:e.householdId,eventHash:digest,parentHead:e.parentHead,policyHash:e.policyHash,generation:e.generation,epochId:e.epochId,adultId,deviceId}; return {...a,signature:sign(deviceId,'approval-signature',a)};});
 return validateSuccessor(p,e,sign(e.authorDeviceId,'event-signature',e),approvals,provider);
}
test('distinct devices of one adult count once; parent rule authorizes transition',async()=>{
 assert.equal((await run(parent,event(),[['a','a1'],['a','a2']])).reason,'QUORUM_REQUIRED');
 assert.equal((await run(parent,event(),[['a','a1'],['b','b1']])).status,'validated');
});
test('valid children remain distinct and approvals bind exact child',async()=>{
 const a=await run(parent,event(),[['a','a1'],['b','b1']]);
 const b=await run(parent,event({proposalId:'other'}),[['a','a1'],['b','b1']]);
 assert.equal(a.status,'validated'); assert.equal(b.status,'validated'); assert.notEqual(a.eventHash,b.eventHash);
});
test('parent, policy, generation and epoch are bound',async()=>{
 for(const [field,value,reason] of [['parentHead','wrong','PARENT_UNRESOLVED'],['policyHash','wrong','CONTEXT_MISMATCH'],['generation',2,'CONTEXT_MISMATCH'],['epochId','wrong','CONTEXT_MISMATCH']]) assert.equal((await run(parent,event({[field]:value}),[])).reason,reason);
});
test('revoked sponsor fails and active own-device sponsorship awaits ceremony',async()=>{
 const pair={kind:'pairOwnDevice',subject:{adultId:'a',deviceId:'new',signingKeyRef:'new-key'},nextPolicy:null};
 assert.equal((await run(parent,event({...pair,authorDeviceId:'revoked'}),[])).reason,'UNAUTHORIZED_DEVICE');
 assert.equal((await run(parent,event(pair),[])).reason,'CEREMONY_AND_POSSESSION_REQUIRED');
});
test('unanimity and fixed quorum follow the accepted parent policy',async()=>{
 const unanimous={...parent,policy:{kind:'unanimous',fixedCount:null}};
 assert.equal((await run(unanimous,event(),[['a','a1'],['b','b1']])).reason,'QUORUM_REQUIRED');
 assert.equal((await run(unanimous,event(),[['a','a1'],['b','b1'],['c','c1']])).status,'validated');
 const fixed={...parent,policy:{kind:'fixed',fixedCount:1}};
 assert.equal((await run(fixed,event(),[['b','b1']])).status,'validated');
 assert.equal((await run(parent,event({nextPolicy:{kind:'fixed',fixedCount:4}}),[['a','a1'],['b','b1']])).reason,'INVALID_INPUT');
});
test('invitations do not grant access without independent admission evidence',async()=>{
 const invitation=event({kind:'inviteAdult',subject:{adultId:'d'},nextPolicy:null});
 assert.equal((await run(parent,invitation,[['a','a1'],['b','b1']])).reason,'ADMISSION_AND_PROJECTION_REQUIRED');
});
test('signature corruption fails closed',async()=>{
 const e=event(); const sig=sign('a1','event-signature',e); const bad=(sig[0]==='0'?'1':'0')+sig.slice(1);
 assert.equal((await validateSuccessor(parent,e,bad,[],provider)).reason,'INVALID_PROOF');
});
test('v2 invite signs exact recipient keys, peers and fresh runtime; legacy remains pending',async()=>{
 const subject={adultId:'d',devices:[{deviceId:'d1',signingKeyRef:'new-sign',wrappingKeyRef:'new-wrap',peerId:'9'}],documentId:'fresh',newGeneration:2,newEpochId:'fresh-epoch'};
 const e=event({version:2,kind:'inviteAdult',subject,nextPolicy:null});
 assert.equal((await run(parent,e,[['a','a1'],['b','b1']])).reason,'ADMISSION_AND_PROJECTION_REQUIRED');
 const hash=hex(await provider.hash(domain('event',e))),approval={version:1,householdId:'house',eventHash:hash,parentHead:'head',policyHash:'policy',generation:1,epochId:'epoch',adultId:'a',deviceId:'a1'};
 const approvals=[{...approval,signature:sign('a1','approval-signature',approval)}], sig=sign('a1','event-signature',e);
 for(const change of [{...subject,devices:[{...subject.devices[0],signingKeyRef:'other'}]},{...subject,devices:[{...subject.devices[0],peerId:'1'}]},{...subject,documentId:'cooking'},{...subject,newEpochId:'epoch'}]) assert.notEqual((await validateSuccessor(parent,{...e,subject:change},sig,approvals,provider)).reason,'ADMISSION_AND_PROJECTION_REQUIRED');
});

test('v6 policy set subject uses the existing author and adult quorum rules; v3 remains valid',async()=>{
 const baseline={frontiers:[],historyHash:'a'.repeat(64)};
 const e=event({version:6,subject:{baseline,setHash:'b'.repeat(64),documentCount:2}});
 assert.equal((await run(parent,e,[['a','a1']])).reason,'QUORUM_REQUIRED');
 assert.equal((await run(parent,e,[['a','a1'],['b','b1']])).status,'validated');
 assert.equal((await validateSuccessor(parent,e,'0'.repeat(128),[],provider)).reason,'INVALID_PROOF');
 const sig=sign('a1','event-signature',e);
 assert.equal((await validateSuccessor(parent,{...e,subject:{...e.subject,setHash:'c'.repeat(64)}},sig,[],provider)).reason,'INVALID_PROOF');
 for(const changed of [{kind:'pairOwnDevice'},{version:7},{subject:{...e.subject,documentCount:0}},{subject:baseline}])
  assert.equal((await run(parent,{...e,...changed},[])).reason,'INVALID_INPUT');
 assert.equal((await run(parent,event({version:3,subject:baseline}),[['a','a1'],['b','b1']])).status,'validated');
});
