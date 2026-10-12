// Actual on-device web 3.5.0 ↔ Android ART/JNI Automerge 0.12.0 live sync.
// Test-only adb broadcast transport: no Automerge protocol or document semantics
// implemented by the transport. Android owns its own native doc + SyncState.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as A from '@automerge/automerge';

mkdirSync('artifacts',{recursive:true});
const COMPONENT = 'creative.cooking.automerge.spike.expoapp/creative.cooking.automerge.spike.expo.AutomergeInteropReceiver';
const b64=bytes=>Buffer.from(bytes).toString('base64');
const un64=s=>new Uint8Array(Buffer.from(s,'base64'));
const asText=s=>Buffer.from(s,'base64').toString('utf8');
const toJson=s=>JSON.parse(asText(s));
const recipe = (...parts)=>['recipesById','recipe-1',...parts].join('/');
const pantry = (...parts)=>['pantryById','item-1',...parts].join('/');
let broadcasts=0;
function remote(command, extras={}) {
  const args=['shell','am','broadcast','--receiver-foreground','-a',
    'creative.cooking.automerge.spike.EXCHANGE','-n',COMPONENT,'--es','cmd',command];
  for(const [name,value] of Object.entries(extras)){
    if (name==='number') args.push('--ei',name,String(value));
    else args.push('--es',name,String(value));
  }
  const output=execFileSync('adb',args,{encoding:'utf8',timeout:20000,maxBuffer:2e6});
  broadcasts++;
  const match=output.match(/Broadcast completed:\s+result=(\d+)(?:,\s*data="([^"]*)")?/);
  assert.ok(match,'No Android ordered broadcast result for '+command+': '+output);
  const value=match[2]??'';
  assert.equal(Number(match[1]),0,'Android JNI '+command+' failure: '+
    (value.startsWith('ERROR_') ? asText(value.slice(6)) : value));
  return value;
}
function logical(doc){return JSON.parse(JSON.stringify(doc));}
function textValue(value){return value === null || value === undefined ? value : String(value);}
const seedBytes=readFileSync('artifacts/android-bridge-web-seed.am');
const seed=A.load(seedBytes);
const author='web-device';
const authorHex=Buffer.from(author).toString('hex');
const change=(doc, mutate)=>A.change(A.clone(doc,{author:authorHex}),
  {time:1700000800,message:'web device offline edit'},mutate);
const results=[];
async function test(name,fn) {
  const start=performance.now();
  const detail=await fn();
  results.push({name,status:'PASS',elapsedMs:+(performance.now()-start).toFixed(1),...detail});
  console.log('ANDROID_DEVICE '+name+' PASS '+JSON.stringify(detail??{}));
}
let savedBinary=0;
let syncMessages=0;
function sync(initialWeb,max=60) {
  let web=initialWeb, state=A.initSyncState(),count=0,rounds=0;
  for(;rounds<max;rounds++){
    let out;[state,out]=A.generateSyncMessage(web,state);
    if(out){remote('receive',{data:b64(out)});count++;}
    const back=un64(remote('generate'));
    if(back.length){[web,state]=A.receiveSyncMessage(web,state,back);count++;}
    if(!out && !back.length)break;
  }
  assert.ok(rounds<max,'Actual web↔Android SyncState failed to quiesce');
  syncMessages+=count;
  const nativeBytes=un64(remote('save'));
  const native=A.load(nativeBytes);
  assert.deepEqual(logical(web),logical(native),'actual native/web convergence');
  assert.deepEqual(A.getHeads(web).sort(),A.getHeads(native).sort());
  savedBinary=nativeBytes.length;
  return {web,messages:count,rounds:rounds+1,nativeBytes:nativeBytes.length};
}
try {
  await test('Web JS save → Android native open + read',()=>{
    remote('open',{data:b64(seedBytes)});
    const title=toJson(remote('get',{path:recipe('title')}));
    assert.equal(title,seed.recipesById['recipe-1'].title);
    return {loadedBytes:seedBytes.length,title};
  });
  await test('Android structured edits → native binary → web 3.5 load',()=>{
    remote('putString',{path:recipe('title'),data:b64('Basil tomato toast')});
    remote('putInt',{path:pantry('preference'),number:5});
    const native=A.load(un64(remote('save')));
    assert.equal(textValue(native.recipesById['recipe-1'].title),'Basil tomato toast');
    assert.equal(native.pantryById['item-1'].preference,5);
    return {heads:A.getHeads(native).length};
  });
  await test('Actual web↔Android live SyncState session after offline divergence',()=>{
    const web=change(seed,d=>{d.recipesById['recipe-1'].portions=3;});
    const result=sync(web);
    assert.equal(textValue(result.web.recipesById['recipe-1'].title),'Basil tomato toast');
    assert.equal(result.web.pantryById['item-1'].preference,5);
    assert.equal(result.web.recipesById['recipe-1'].portions,3);
    return {messages:result.messages,rounds:result.rounds};
  });
  let disagreement;
  await test('Web=4 / Android=6 retains op-id alternatives and authors',()=>{
    remote('open',{data:b64(seedBytes)});
    const web=change(seed,d=>{d.recipesById['recipe-1'].portions=4;});
    remote('putInt',{path:recipe('portions'),number:6});
    const result=sync(web);
    const alternatives=toJson(remote('conflicts',{path:recipe('portions')})).alternatives;
    assert.deepEqual(alternatives.map(x=>x.value).sort((a,b)=>a-b),[4,6]);
    assert.ok(alternatives.every(x=>x.opId.includes('@')));
    assert.deepEqual(Object.values(A.getConflicts(result.web.recipesById['recipe-1'],'portions')??{}).sort((a,b)=>a-b),[4,6]);
    const changes=toJson(remote('changes')).changes;
    assert.ok(changes.some(c=>c.author===authorHex));
    assert.ok(changes.some(c=>c.author===Buffer.from('android-broadcast').toString('hex')));
    disagreement=result.web;
    return {alternatives,authoredChanges:changes.filter(x=>x.author).length};
  });
  await test('Native causal resolution to 5 and fresh SyncState reconnect',()=>{
    const previousHeads=toJson(remote('heads'));
    remote('putInt',{path:recipe('portions'),number:5});
    const changes=toJson(remote('changes')).changes;
    assert.ok(changes.some(c=>previousHeads.every(h=>c.deps.includes(h))));
    remote('resetSession');
    const updated=sync(disagreement);
    assert.equal(updated.web.recipesById['recipe-1'].portions,5);
    assert.equal(A.getConflicts(updated.web.recipesById['recipe-1'],'portions'),undefined);
    assert.equal(toJson(remote('conflicts',{path:recipe('portions')})).alternatives.length,1);
    return {messages:updated.messages,resolved:5};
  });
  await test('Persist/restart and fresh web↔Android offline sync',()=>{
    const web=A.load(un64(remote('save')));
    remote('restart');
    assert.equal(toJson(remote('get',{path:recipe('portions')})),5);
    const changed=change(web,d=>{d.pantryById['item-1'].name='cherry tomatoes';});
    const result=sync(changed);
    assert.equal(textValue(result.web.pantryById['item-1'].name),'cherry tomatoes');
    return {messages:result.messages};
  });
  await test('Three replicas converge through Android when web peers do not overlap',()=>{
    remote('open',{data:b64(seedBytes)});
    const a=change(seed,d=>{d.recipesById['recipe-1'].title='Web A toast';});
    const b=A.change(A.clone(seed,{actor:'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1'}),
      {message:'offline B edit'},d=>{d.pantryById['item-1'].preference=2;});
    let convergedA=sync(a);
    const convergedB=sync(b);
    remote('resetSession');
    convergedA=sync(convergedA.web);
    assert.equal(textValue(convergedA.web.recipesById['recipe-1'].title),'Web A toast');
    assert.equal(convergedA.web.pantryById['item-1'].preference,2);
    assert.deepEqual(logical(convergedA.web),logical(convergedB.web));
    return {messages:convergedA.messages+convergedB.messages};
  });
  await test('Malformed SyncState input rejected without corrupting native heads',()=>{
    const before=remote('heads');
    let rejected=false;
    try{remote('receive',{data:b64(Buffer.from([1,2,3,4,5]))});}
    catch{rejected=true;}
    assert.ok(rejected);
    assert.equal(remote('heads'),before);
    return {rejected};
  });
  const evidence={result:'PASS',runtime:'actual Android Expo 57 ART JNI; host JS Automerge 3.5.0 peer via adb',
    protocol:'Automerge SyncState V2 binary',broadcasts,syncMessages,savedBinaryBytes:savedBinary,results};
  writeFileSync('artifacts/android-device-web-native-result.json',JSON.stringify(evidence,null,2));
  console.log('AUTOMERGE_ANDROID_WEB_NATIVE_PASS '+JSON.stringify({
    scenarios:results.length,broadcasts,syncMessages,savedBinaryBytes:savedBinary}));
} finally {
  try{remote('dispose');}catch(e){console.error('Device cleanup:',e);}
}
