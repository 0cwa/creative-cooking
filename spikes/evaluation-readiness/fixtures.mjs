// Both real engine formats -> independent sealed binary changes -> opaque transport.
// Fixture AES-GCM is test-only; it does not implement ARK, Keyhive, ACLs or pairing.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as A from '@automerge/automerge';
import { LoroDoc } from 'loro-crdt';
import { makeUpdate, assertUpdate } from './boundary.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const ids = { automerge: { engine:'automerge', spaceId:'space:personal:automerge', documentId:'doc:recipe-1' },
  loro: { engine:'loro', spaceId:'space:personal:loro', documentId:'doc:recipe-1' } };
const PARTS = ['base','offline-left-4','offline-right-6','causal-resolution-5'];
function syntheticA() {
  const seed = A.change(A.init({ actor:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), {message:'base'}, d=>{
    d.recipes = { 'recipe-1': {id:'recipe-1',title:'Tomato toast', portions:2} };
    d.pantry = { 'pantry-1': {id:'pantry-1',name:'chickpeas (cooked)',preference:5} };
  });
  const left = A.change(A.clone(seed, { actor:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), {message:'iphone 4'}, d=>{
    d.recipes['recipe-1'].portions = 4;
  });
  const right = A.change(A.clone(seed, { actor:'cccccccccccccccccccccccccccccccc' }), {message:'tablet 6'}, d=>{
    d.recipes['recipe-1'].portions = 6;
  });
  const merged = A.merge(A.clone(left), right);
  const resolved = A.change(A.clone(merged,{actor:'dddddddddddddddddddddddddddddddd'}), {message:'review later: 5'}, d=>{
    d.recipes['recipe-1'].portions = 5;
  });
  const only = (base, target) => {
    const found = A.getChanges(base,target);
    assert.equal(found.length,1,'each edit must be an incremental change, not a snapshot');
    return Uint8Array.from(found[0]);
  };
  return [Uint8Array.from(A.getLastLocalChange(seed)),only(seed,left),only(seed,right),only(merged,resolved)];
}
function syntheticLoro() {
  const seed=new LoroDoc(); seed.setPeerId('900');
  const r=seed.getMap('recipe:recipe-1');
  r.set('id','recipe-1'); r.set('title','Tomato toast'); r.set('portions',2);
  const p=seed.getMap('pantry:pantry-1');
  p.set('id','pantry-1'); p.set('name','chickpeas (cooked)'); p.set('preference',5);
  seed.commit({message:'base'});
  const base=Uint8Array.from(seed.export({mode:'update'}));
  const baseVersion=seed.oplogVersion();
  const left=seed.fork(); left.setPeerId('101'); left.getMap('recipe:recipe-1').set('portions',4);left.commit({message:'iphone 4'});
  const right=seed.fork(); right.setPeerId('202');right.getMap('recipe:recipe-1').set('portions',6);right.commit({message:'tablet 6'});
  const leftBytes=Uint8Array.from(left.export({mode:'update',from:baseVersion}));
  const rightBytes=Uint8Array.from(right.export({mode:'update',from:baseVersion}));
  const joined=left.fork(); joined.import(right.export({mode:'update'}));
  const beforeResolution=joined.oplogVersion();
  joined.setPeerId('303');joined.getMap('recipe:recipe-1').set('portions',5);joined.commit({message:'review later: 5'});
  const resolution=Uint8Array.from(joined.export({mode:'update',from:beforeResolution}));
  return [base,leftBytes,rightBytes,resolution];
}
function encrypt(key, plain) {
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]);
}
function decrypt(key, wire) {
  assert.ok(wire.length>28,'missing AES-GCM envelope');
  const decipher=createDecipheriv('aes-256-gcm',key,wire.subarray(0,12));
  decipher.setAuthTag(wire.subarray(12,28));
  return Buffer.concat([decipher.update(wire.subarray(28)),decipher.final()]);
}
function makeFixture(engine, plainUpdates) {
  assert.equal(plainUpdates.length,4);
  const key=randomBytes(32),ctx=ids[engine],commits=[];
  for (const [i,plain] of plainUpdates.entries()) {
    assert.ok(plain.length>0 && plain instanceof Uint8Array);
    const parents=i===0?[]:i===1||i===2?[commits[0].id]:[commits[1].id,commits[2].id];
    const wire=encrypt(key,plain);
    const item=makeUpdate({...ctx,dependencies:parents,bytes:wire});
    commits.push({kind:PARTS[i],...Object.fromEntries(
      ['schemaVersion','engine','spaceId','documentId','dependencies','payloadSha256','id','byteLength'].map(k=>[k,item[k]])),
      ciphertextBase64:wire.toString('base64'),plainSha256:sha(plain),plainByteLength:plain.length});
  }
  return { ...ctx, fixtureKeyHex:key.toString('hex'), commits };
}
function loroWrites(doc) {
  const result=[];
  for (const [peer,list] of doc.getAllChanges()) for (const change of list) {
    for (const op of doc.getOpsInChange({peer:String(peer),counter:change.counter})) {
      const root=op?.container?.Root??op?.container?.root;
      const name=typeof op?.container==='string'?
        (op.container.startsWith('cid:root-')&&op.container.endsWith(':Map')?op.container.slice(9,-4):null) :
        root?.name??null;
      const content=op?.content?.Map??op?.content?.map??(op?.content?.type==='insert'?op.content:null);
      if(name==='recipe:recipe-1'&&content?.key==='portions')
        result.push({value:typeof content.value==='bigint'?Number(content.value):content.value,peer:String(peer),counter:Number(op.counter),id:String(op.counter)+'@'+String(peer)});
    }
  }
  return result;
}
function proveEngine(engine, plain, phase) {
  assert.ok(phase==='conflict'||phase==='resolved','phase name required');
  const doc=engine==='automerge'?A.init({actor:'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'}):new LoroDoc();
  let result=doc;
  const expected=phase==='conflict'?3:4;
  if(engine==='automerge') {
    [result]=A.applyChanges(result,plain.slice(0,expected));
    const recipe=result.recipes['recipe-1'];
    assert.equal(recipe.title,'Tomato toast');
    assert.equal(result.pantry['pantry-1'].name,'chickpeas (cooked)');
    if(phase==='conflict') {
      const alternatives=Object.values(A.getConflicts(recipe,'portions')??{});
      assert.deepEqual(alternatives.sort(),[4,6]);
      const restarted=A.load(A.save(result));
      assert.deepEqual(Object.values(A.getConflicts(restarted.recipes['recipe-1'],'portions')??{}).sort(),[4,6]);
      return {phase,portionsAlternatives:alternatives,conflictPersistedAfterSnapshot:true,
        frontier:A.getHeads(result).sort()};
    }
    assert.equal(recipe.portions,5);
    assert.equal(A.getHeads(result).length,1,'resolution must causally dominate branch heads');
    // The 4/6 alternatives remain derivable from the original authenticated update history,
    // but are no longer a live getConflicts result after causal resolution.
    const earlier=A.init({actor:'ffffffffffffffffffffffffffffffff'});
    const [prior]=A.applyChanges(earlier,plain.slice(0,3));
    assert.deepEqual(Object.values(A.getConflicts(prior.recipes['recipe-1'],'portions')??{}).sort(),[4,6]);
    return {phase,portions:5,historicalAlternatives:[4,6],resolutionCausal:true};
  }
  for(const update of plain.slice(0,expected)) result.import(update);
  assert.equal(result.getMap('recipe:recipe-1').get('title'),'Tomato toast');
  assert.equal(result.getMap('pantry:pantry-1').get('name'),'chickpeas (cooked)');
  const writes=loroWrites(result),left=writes.find(x=>x.value===4),right=writes.find(x=>x.value===6);
  assert.ok(left&&right,'Loro must preserve public operation history alternatives; values='+JSON.stringify(writes));
  const front=(op)=>[{peer:op.peer,counter:op.counter}];
  assert.equal(result.cmpFrontiers(front(left),front(right)),undefined,'4 and 6 must be concurrent');
  if(phase==='conflict') {
    assert.ok([4,6].includes(result.getMap('recipe:recipe-1').get('portions')),'LWW display is not approval');
    const restarted=new LoroDoc();restarted.import(result.export({mode:'snapshot'}));
    assert.deepEqual(new Set(loroWrites(restarted).filter(x=>[4,6].includes(x.value)).map(x=>x.value)),new Set([4,6]));
    return {phase,portionsAlternatives:[4,6],conflictPersistedAfterSnapshot:true,
      frontiers:result.frontiers().map(x=>String(x.counter)+'@'+String(x.peer))};
  }
  const resolution=writes.find(x=>x.value===5);
  assert.ok(resolution);
  assert.equal(result.getMap('recipe:recipe-1').get('portions'),5);
  assert.equal(result.cmpFrontiers(front(left),front(resolution)),-1);
  assert.equal(result.cmpFrontiers(front(right),front(resolution)),-1);
  const restarted=new LoroDoc();restarted.import(result.export({mode:'snapshot'}));
  assert.deepEqual(new Set(loroWrites(restarted).filter(x=>[4,6].includes(x.value)).map(x=>x.value)),new Set([4,6]));
  return {phase,portions:5,historicalAlternatives:[4,6],resolutionCausal:true};
}
export function verifyRecovered(fixture, blobs, phase) {
  const expected=phase==='conflict'?3:phase==='resolved'?4:null;
  assert.ok(expected,'invalid phase');
  const received=(blobs??[]).map(x=>Buffer.from(x));
  assert.equal(received.length,expected,'unexpected count or duplicate stored blobs');
  const hashes=new Set(received.map(sha));
  assert.equal(hashes.size,expected,'duplicate opaque ciphertext');
  const key=Buffer.from(fixture.fixtureKeyHex,'hex'),plain=[];
  for(const item of fixture.commits.slice(0,expected)){
    const exact=Buffer.from(item.ciphertextBase64,'base64');
    const wire=received.find(x=>sha(x)===item.payloadSha256);
    assert.ok(wire&&wire.equals(exact),'lost or mutated exact encrypted update bytes');
    assertUpdate({...item,bytes:wire},{engine:fixture.engine,spaceId:fixture.spaceId,documentId:fixture.documentId});
    const restored=decrypt(key,wire);
    assert.equal(sha(restored),item.plainSha256,'decrypted original update hash');
    plain.push(Uint8Array.from(restored));
  }
  const proof=proveEngine(fixture.engine,plain,phase);
  return {engine:fixture.engine,spaceId:fixture.spaceId,documentId:fixture.documentId,
    phase,exactCiphertextBytes:true,actualEngineChangeSha256:fixture.commits.slice(0,expected).map(x=>x.plainSha256),
    wireLengths:fixture.commits.slice(0,expected).map(x=>x.byteLength),...proof};
}
const [, , command, ...args]=process.argv;
if(command==='generate'){
  const [filename]=args;
  assert.ok(filename,'Usage: node fixtures.mjs generate <filename>');
  const output={schemaVersion:1,source:'real-engine-incremental-binaries',testOnlyCrypto:'AES-256-GCM; no ARK/Keyhive or authorization',
    generatedAt:new Date().toISOString(),scenarios:[makeFixture('automerge',syntheticA()),makeFixture('loro',syntheticLoro())],
    plaintextSentinels:['chickpeas (cooked)','Tomato toast','SYNTHETIC_PROVIDER_API_KEY_NEVER_REPLICATE_XYZZY']};
  for(const scenario of output.scenarios)
    verifyRecovered(scenario,scenario.commits.slice(0,3).map(x=>[...Buffer.from(x.ciphertextBase64,'base64')]),'conflict');
  mkdirSync(dirname(filename),{recursive:true});writeFileSync(filename,JSON.stringify(output,null,2));
  console.log(JSON.stringify({generated:filename,engines:output.scenarios.map(s=>s.engine),plainLengths:output.scenarios.map(s=>s.commits.map(x=>x.plainByteLength))}));
}else if(command==='verify'){
  const [filename,engine,receivedFile,phase]=args;
  const fixture=JSON.parse(readFileSync(filename,'utf8')).scenarios.find(x=>x.engine===engine);
  assert.ok(fixture,'Unknown engine');
  const observed=JSON.parse(readFileSync(receivedFile,'utf8'));
  console.log(JSON.stringify(verifyRecovered(fixture,observed,phase)));
}else if(command!==undefined) throw new Error('Usage: node fixtures.mjs generate ... | verify ...');
