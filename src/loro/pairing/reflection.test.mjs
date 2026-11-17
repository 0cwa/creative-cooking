import {test} from 'node:test';import {rmSync} from 'node:fs';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import sodium from 'libsodium-wrappers';import {durableSession,verifySessionEvidence,householdSessionContextBytes,verifyHouseholdSessionEvidence} from './durable-session.mjs';import {ceremonyBytes,beginCeremony,answerChallenge} from './candidate-v2.mjs';await sodium.ready;
const hex=x=>sodium.to_hex(x),clone=x=>structuredClone(x);
function store(db){db.exec('CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY,v TEXT NOT NULL)');return {transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn({get:k=>{const row=db.prepare('SELECT v FROM state WHERE k=?').get(k);return row?JSON.parse(row.v):undefined},put:(k,v)=>db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,JSON.stringify(v))});db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}}
function setup(files){const roles=['initiator','responder'],signs=Object.fromEntries(roles.map(r=>[r,sodium.crypto_sign_keypair()])),boxes=Object.fromEntries(roles.map(r=>[r,sodium.crypto_box_keypair()])),key=r=>({signingSecret:signs[r].privateKey,wrappingSecret:boxes[r].privateKey}),role=r=>({role:r,deviceId:r,signingPublicKey:signs[r].publicKey,wrappingPublicKey:boxes[r].publicKey,nonce:sodium.randombytes_buf(32)}),t={version:1,sessionId:'s',action:'pairOwnDevice',scope:{kind:'personal',id:'p'},purpose:'data',acceptedParent:'parent',authorizationSnapshot:'snapshot',initiator:role('initiator'),responder:role('responder'),signaling:[new Uint8Array([1])]},g={version:1,guardId:'guard',scope:t.scope,direction:'initiator-to-responder',purpose:'data'},oob={hash:hex(sodium.crypto_generichash(32,ceremonyBytes(t,g))),pins:Object.fromEntries(roles.map(r=>[r,{deviceId:t[r].deviceId,signingKey:hex(t[r].signingPublicKey),wrappingKey:hex(t[r].wrappingPublicKey)}]))},dbs=roles.map((_,i)=>new DatabaseSync(files?.[i]??':memory:')),stores=dbs.map(store),open=(r)=>durableSession(sodium,stores[roles.indexOf(r)],key(r),t,g,r,oob);return {t,g,oob,dbs,stores,open,key}}
test('reflected challenge never reveals a token for a wrapping key the recipient does not own',async()=>{
 const f=setup();
 try {
  f.t.responder.wrappingPublicKey=new Uint8Array(f.t.initiator.wrappingPublicKey);
  f.oob.pins.responder.wrappingKey=hex(f.t.responder.wrappingPublicKey);
  f.oob.hash=hex(sodium.crypto_generichash(32,ceremonyBytes(f.t,f.g)));
  const a=f.open('initiator'),offer=a.initialize();
  const message={role:'responder',hash:offer.hash,challenge:offer.challenge};
  message.signature=hex(sodium.crypto_sign_detached(new TextEncoder().encode(JSON.stringify(['creative-cooking/durable-ceremony/v2','offer',message.role,message.hash,{challenge:message.challenge}])),f.key('responder').signingSecret));
  assert.throws(()=>a.respond(message,0),/INVALID_PROOF/);
  assert.deepEqual(a.status(),{revision:0,complete:false});
  assert.throws(()=>a.evidence(),/INCOMPLETE/);
 }finally{f.dbs.forEach(x=>x.close());}
});
test('standalone wrapping challenges bind the transcript and intended role',()=>{
 const f=setup();try {
  const transcript=ceremonyBytes(f.t,f.g),trusted={confirmedTranscriptHash:sodium.crypto_generichash(32,transcript),pins:Object.fromEntries(['initiator','responder'].map(r=>[r,{deviceId:f.t[r].deviceId,signingPublicKey:f.t[r].signingPublicKey,wrappingPublicKey:f.t[r].wrappingPublicKey}]))};
  const c=beginCeremony(sodium,f.t,f.g,trusted),answer=(role,bytes)=>answerChallenge(sodium,role,bytes,c.challenges.responder,f.t.responder.wrappingPublicKey,f.key('responder').wrappingSecret,f.key('responder').signingSecret);
  assert.throws(()=>answer('initiator',transcript),/INVALID_PROOF/);
  assert.throws(()=>answer('responder',new Uint8Array([...transcript,0])),/INVALID_PROOF/);
  assert.equal(answer('responder',transcript).token.length,32);
 }finally{f.dbs.forEach(x=>x.close());}
});
