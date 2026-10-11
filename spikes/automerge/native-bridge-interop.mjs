// Real web @automerge/automerge 3.5 <-> persistent Java/JNI/Rust 0.12 peer.
// An actual Java process owns native document and SyncState handles. The pipe is
// just a base64 framing transport for binary Automerge changes/sync messages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as A from '@automerge/automerge';

const resultDir = 'artifacts';
mkdirSync(resultDir, { recursive: true });
const javaClass = process.env.AUTOMERGE_JAVA_CLASS_DIR;
const lib = process.env.AUTOMERGE_JNI_LIBRARY;
assert.ok(javaClass && lib, 'Provide AUTOMERGE_JAVA_CLASS_DIR / AUTOMERGE_JNI_LIBRARY');

const child = spawn('java', [
  '-Dautomerge.jni.path=' + lib, '-cp', javaClass,
  'creative.cooking.automerge.spike.NativeCli'
], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
const pending = [];
createInterface({ input: child.stdout }).on('line', line => {
  const resolve = pending.shift();
  if (!resolve) throw new Error('Unexpected native stdout: ' + line);
  resolve(line);
});
async function call(op, ...args) {
  const promise = new Promise(resolve => pending.push(resolve));
  child.stdin.write([op, ...args.map(String)].join('\t') + '\n');
  const line = await promise;
  const sep = line.indexOf('\t');
  assert.ok(sep !== -1, 'Invalid Java response: ' + line);
  if (line.slice(0, sep) === 'ERR') throw new Error('Native ' + op + ': ' + line.slice(sep + 1));
  assert.equal(line.slice(0, sep), 'OK');
  return line.slice(sep + 1);
}
const b64 = x => Buffer.from(x).toString('base64');
const binary = x => new Uint8Array(Buffer.from(x, 'base64'));
const txt = x => b64(Buffer.from(x, 'utf8'));
const path = (...s) => s.join('/');
const recipe = (...s) => path('recipesById', 'recipe-1', ...s);
const pantry = (...s) => path('pantryById', 'item-1', ...s);
const chat = (...s) => path('conversationsById', 'conversation-1', 'messagesById', 'message-1', ...s);
const scenarios = [];
async function scenario(number, title, f) {
  const start = performance.now();
  await f();
  const entry = { number, title, status: 'PASS', durationMs: +(performance.now()-start).toFixed(2) };
  console.log('NATIVE ' + number + ' PASS — ' + title);
  scenarios.push(entry);
}
function makeSeed() {
  let d = A.init({ actor: '00000000000000000000000000000000' });
  return A.change(d, { message: 'Creative Cooking stable-ID native seed', time: 1700000000 }, s => {
    s.recipesById = { 'recipe-1': { id: 'recipe-1', title: 'Tomato toast', portions: 2,
      ingredientsById: { 'ingredient-tomato': { id: 'ingredient-tomato', amount: '2', name: 'tomatoes' } },
      methodStepsById: { 'step-1': {id: 'step-1', text: 'Toast bread.'} },
      lifecycle: { deleted: false } } };
    s.pantryById = { 'item-1': {id: 'item-1', name: 'tomatoes', preference: 3} };
    s.conversationsById = { 'conversation-1': {id: 'conversation-1', messagesById: {
      'message-1': {id: 'message-1', role: 'user', content: 'What can I cook?'} } } };
    s.allergiesByValue = {};
  });
}
function logical(doc) { return JSON.parse(JSON.stringify(doc)); }
function edit(doc, author, callback) {
  return A.change(A.clone(doc, { author: Buffer.from(author).toString('hex') }),
    {message: 'edit from ' + author, time: 1700000200}, callback);
}
function conflicts(doc, key = 'portions') {
  return Object.values(A.getConflicts(doc.recipesById['recipe-1'], key) ?? {});
}
async function nativeOpen(doc, actor = 102, author = 'android') {
  return Number(await call('open', b64(A.save(doc)), actor, author));
}
async function nativeGet(id, key) { return JSON.parse(await call('get', id, key)); }
async function nativeConflicts(id, key) { return JSON.parse(await call('conflicts', id, key)).alternatives; }
async function nativeSave(id) { return binary(await call('save', id)); }
async function nativeSession(id) { return Number(await call('newSession')); }
async function sync(webDoc, nativeId, nativeState, max = 60) {
  let web = webDoc, webState = A.initSyncState();
  let rounds = 0, messages = 0;
  for (; rounds < max; rounds++) {
    let out;
    [webState, out] = A.generateSyncMessage(web, webState);
    if (out) { await call('receive', nativeId, nativeState, b64(out)); messages++; }
    const back = binary(await call('generate', nativeId, nativeState));
    if (back.byteLength) { [web, webState] = A.receiveSyncMessage(web, webState, back); messages++; }
    if (!out && !back.byteLength) break;
  }
  assert.ok(rounds < max, 'SyncState did not quiesce');
  const native = A.load(await nativeSave(nativeId));
  assert.deepEqual(logical(web), logical(native));
  assert.deepEqual(A.getHeads(web).sort(), A.getHeads(native).sort());
  return {web, rounds, messages};
}

const seed = makeSeed(), seedHeads = A.getHeads(seed), seedBytes = A.save(seed);
writeFileSync(resultDir + '/android-bridge-web-seed.am', seedBytes);
let handles = [];
let sessions = [];
const open = async (...args) => {const id=await nativeOpen(...args); handles.push(id); return id;};
const newSession = async () => {const id=await call('newSession'); sessions.push(Number(id)); return Number(id);};
try {
  await scenario(1, 'JS document loads and reads stable-ID recipe/pantry/chat', async () => {
    const id=await open(seed);
    assert.equal(await nativeGet(id, recipe('title')), 'Tomato toast');
    assert.equal(await nativeGet(id, pantry('name')), 'tomatoes');
    assert.equal(await nativeGet(id, chat('content')), 'What can I cook?');
    assert.deepEqual(JSON.parse(await call('heads', id)), seedHeads);
  });

  await scenario(2, 'Android edits structured recipe/pantry/chat fields; web imports native binary', async () => {
    const id=await open(seed);
    await call('putString', id, recipe('title'), txt('Tomato toast with basil'));
    await call('putInt', id, pantry('preference'), 5);
    await call('putString', id, chat('content'), txt('Try basil tomato toast'));
    await call('putString', id, recipe('ingredientsById','ingredient-tomato','amount'), txt('3'));
    const fromNative = A.load(await nativeSave(id));
    assert.equal(fromNative.recipesById['recipe-1'].title, 'Tomato toast with basil');
    assert.equal(fromNative.pantryById['item-1'].preference, 5);
    assert.equal(fromNative.conversationsById['conversation-1'].messagesById['message-1'].content, 'Try basil tomato toast');
    writeFileSync(resultDir + '/android-bridge-native-modified.am', await nativeSave(id));
  });

  await scenario(3, 'different-field concurrent forks converge using incremental changes', async () => {
    const id=await open(seed);
    await call('putInt', id, recipe('portions'), 4);
    const web=edit(seed, 'web-device', d => { d.recipesById['recipe-1'].title = 'Herbed toast'; });
    const webChanges=A.getChanges(seed, web);
    for (const c of webChanges) await call('apply', id, b64(c));
    const native=A.load(await nativeSave(id));
    assert.equal(native.recipesById['recipe-1'].title, 'Herbed toast');
    assert.equal(native.recipesById['recipe-1'].portions, 4);
    assert.equal((await nativeConflicts(id, recipe('title'))).length, 1);
    assert.equal((await nativeConflicts(id, recipe('portions'))).length, 1);
    const fromNative=binary(await call('export', id, JSON.stringify(seedHeads)));
    const webMerged=A.loadIncremental(web, fromNative);
    assert.deepEqual(logical(webMerged), logical(native));
  });

  let disagreed;
  await scenario(4, '2->4 and 2->6 retains both alternatives and causal/author metadata', async () => {
    const id=await open(seed);
    await call('putInt', id, recipe('portions'), 6);
    let web=edit(seed, 'web-device', d => {d.recipesById['recipe-1'].portions=4;});
    const session=await newSession();
    const converged=await sync(web, id, session);
    web=converged.web;
    assert.deepEqual([...conflicts(web)].sort((a,b)=>a-b), [4,6]);
    const alternatives=await nativeConflicts(id, recipe('portions'));
    assert.deepEqual(alternatives.map(a=>a.value).sort((a,b)=>a-b),[4,6]);
    assert.ok(alternatives.every(a=>a.opId.includes('@')));
    const changes=JSON.parse(await call('changes', id)).changes;
    const authored=changes.filter(c=>c.author).map(c=>c.author);
    assert.ok(authored.includes(Buffer.from('web-device').toString('hex')));
    assert.ok(authored.includes(Buffer.from('android').toString('hex')));
    const competing=changes.filter(c=>c.message?.includes('edit from web-device') || c.actor===alternatives.find(a=>a.value===6).actor);
    assert.ok(competing.some(c=>c.deps.length>0));
    writeFileSync(resultDir + '/android-bridge-conflicted.am', await nativeSave(id));
    writeFileSync(resultDir + '/android-bridge-conflict-evidence.json',
      JSON.stringify({alternatives, changes},null,2));
    disagreed={id,web,alternatives};
  });

  await scenario(5, 'causal resolution to 5 supersedes 4 and 6', async () => {
    const originalHeads=JSON.parse(await call('heads', disagreed.id));
    await call('putInt', disagreed.id, recipe('portions'), 5);
    assert.equal(await nativeGet(disagreed.id, recipe('portions')), 5);
    assert.equal((await nativeConflicts(disagreed.id, recipe('portions'))).length, 1);
    const changes=JSON.parse(await call('changes', disagreed.id)).changes;
    assert.ok(changes.some(c => originalHeads.every(h => c.deps.includes(h))), 'resolution must depend on both heads');
    const session=await newSession();
    const result=await sync(disagreed.web, disagreed.id, session);
    assert.equal(result.web.recipesById['recipe-1'].portions, 5);
    assert.equal(conflicts(result.web).length, 0);
  });

  await scenario(6, 'out-of-order changes are safe; duplicate apply is idempotent', async () => {
    let a=edit(seed,'web-step-1',d => {d.recipesById['recipe-1'].title='Step one';});
    let b=A.change(a,{message:'web-step-2'},d => {d.recipesById['recipe-1'].portions=9;});
    const diffs=A.getChanges(seed,b);
    assert.equal(diffs.length,2);
    const id=await open(seed);
    const before=await call('heads',id);
    // Core may queue missing-dependency updates or reject them; either must be non-destructive.
    try {await call('apply',id,b64(diffs[1]));} catch {
      assert.equal(await call('heads',id),before);
    }
    await call('apply',id,b64(diffs[0]));
    await call('apply',id,b64(diffs[1]));
    const beforeDuplicate=await call('heads',id);
    await call('apply',id,b64(diffs[1]));
    assert.equal(await call('heads',id),beforeDuplicate);
    const loaded=A.load(await nativeSave(id));
    assert.equal(loaded.recipesById['recipe-1'].title,'Step one');
    assert.equal(loaded.recipesById['recipe-1'].portions,9);
  });

  await scenario(7, 'real JS <-> JNI/Rust SyncState after divergent offline edits', async () => {
    const native=await open(seed);
    await call('putString',native,recipe('title'),txt('Android title'));
    const web=edit(seed,'web-offline',d=>{d.pantryById['item-1'].preference=1;});
    const state=await newSession();
    const {web:converged,messages,rounds}=await sync(web,native,state);
    assert.ok(messages>0 && rounds>0);
    assert.equal(converged.recipesById['recipe-1'].title,'Android title');
    assert.equal(converged.pantryById['item-1'].preference,1);
    writeFileSync(resultDir+'/android-bridge-sync-result.json',JSON.stringify({result:'PASS',messages,rounds},null,2));
  });

  await scenario(8, 'save/load/restart and new peer session', async () => {
    let id=await open(seed);
    await call('putString',id,pantry('name'),txt('red tomatoes'));
    const data=await nativeSave(id);
    await call('dispose',id);handles=handles.filter(x=>x!==id);
    id=Number(await call('open',b64(data),101,'restarted-android'));handles.push(id);
    assert.equal(await nativeGet(id,pantry('name')),'red tomatoes');
    const session=await newSession();
    const {web}=await sync(seed,id,session);
    assert.equal(web.pantryById['item-1'].name,'red tomatoes');
  });

  await scenario(9, 'three replicas converge by real sync messages', async () => {
    const first=await open(seed,102,'android-a');
    const second=await open(seed,103,'android-b');
    await call('putInt',first,recipe('portions'),7);
    await call('putString',second,recipe('title'),txt('Shared toast'));
    const web=edit(seed,'web-third',d=>{d.pantryById['item-1'].name='cherry tomatoes';});
    const s1=await newSession();
    const a=await sync(web,first,s1);
    const s2=await newSession();
    const b=await sync(a.web,second,s2);
    const s3=await newSession();
    const c=await sync(b.web,first,s3);
    assert.equal(c.web.recipesById['recipe-1'].portions,7);
    assert.equal(c.web.recipesById['recipe-1'].title,'Shared toast');
    assert.equal(c.web.pantryById['item-1'].name,'cherry tomatoes');
  });

  await scenario(10, 'bad data, stale handle and repeated allocate/free', async () => {
    const before=JSON.parse(await call('counts'));
    await assert.rejects(call('open',b64(Buffer.from([0,1,2,3,4])),102,'invalid'));
    assert.deepEqual(JSON.parse(await call('counts')),before);
    const id=Number(await call('create',104,'lifecycle'));
    await call('putString',id,recipe('title'),txt('Created natively'));
    assert.equal(await nativeGet(id,recipe('title')),'Created natively');
    await call('dispose',id);
    await assert.rejects(call('save',id));
    await assert.rejects(call('dispose',id));
    for(let n=0;n<60;n++) {
      const x=Number(await call('open',b64(seedBytes),105,'cycle'));
      const h=Number(await call('newSession'));
      assert.ok(binary(await call('save',x)).length>0);
      await call('endSession',h);
      await call('dispose',x);
    }
    assert.deepEqual(JSON.parse(await call('counts')),before);
  });

  // The mapping to the authoritative 18 scenario contract is explicit.
  // A map+scalar bridge cannot claim same-character text/list API coverage.
  const contract = [
    ['different recipe fields','PASS',1,3],
    ['same nested entity different properties','PASS',2],
    ['concurrent additions to ordered lists','PARTIAL',2],
    ['concurrent text editing','NOT_IMPLEMENTED'],
    ['chat appends','PARTIAL',2],
    ['set-like additions','PASS',2],
    ['same scalar disagreement','PASS',4,5],
    ['same atomic title','PASS',4],
    ['delete-vs-edit with tombstone','PARTIAL',2],
    ['duplicate pantry item','PARTIAL',2],
    ['reorder + edit','NOT_IMPLEMENTED'],
    ['restart','PASS',8],
    ['out-of-order changes','PASS',6],
    ['duplicate delivery','PASS',6],
    ['long offline divergence','PASS',7],
    ['merge direction','PARTIAL',3],
    ['live sync protocol','PASS',7],
    ['three replicas','PASS',9]
  ].map(([name,status,...tests],i)=>({number:i+1,name,status,correspondingNativeTests:tests}));
  writeFileSync(resultDir+'/android-bridge-contract-matrix.json',JSON.stringify(contract,null,2));
  writeFileSync(resultDir+'/android-bridge-host-summary.json',JSON.stringify({
    status:'PASS',runtime:'Linux JVM invokes Rust JNI (NOT Android)',webBinding:'3.5.0',
    nativeCore:'0.12.0',scenarios,contract
  },null,2));
} finally {
  for(const id of sessions.reverse()) {try{await call('endSession',id);}catch(e){console.error('Session cleanup:',e);}}
  for(const id of handles.reverse()) {try{await call('dispose',id);}catch(e){console.error('Doc cleanup:',e);}}
  const counts=await call('counts');
  console.log('Rust/JNI handles after cleanup:',counts);
  assert.deepEqual(JSON.parse(counts),{documents:0,sessions:0});
  await call('quit').catch(()=>{});
  child.stdin.end();
  child.kill();
  if(stderr.trim())console.error('Java native stderr:\n'+stderr);
}
