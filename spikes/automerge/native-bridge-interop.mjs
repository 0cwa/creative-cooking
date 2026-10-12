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
function rawText(value) { return typeof value === 'object' && value !== null ? String(value) : value; }
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
    assert.equal(rawText(fromNative.recipesById['recipe-1'].title), 'Tomato toast with basil');
    assert.equal(fromNative.pantryById['item-1'].preference, 5);
    assert.equal(rawText(fromNative.conversationsById['conversation-1'].messagesById['message-1'].content), 'Try basil tomato toast');
    writeFileSync(resultDir + '/android-bridge-native-modified.am', await nativeSave(id));
  });

  await scenario(3, 'different-field concurrent forks converge using incremental changes', async () => {
    const id=await open(seed);
    await call('putInt', id, recipe('portions'), 4);
    const web=edit(seed, 'web-device', d => { d.recipesById['recipe-1'].title = 'Herbed toast'; });
    const webChanges=A.getChanges(seed, web);
    for (const c of webChanges) await call('apply', id, b64(c));
    const native=A.load(await nativeSave(id));
    assert.equal(rawText(native.recipesById['recipe-1'].title), 'Herbed toast');
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
    assert.equal(rawText(loaded.recipesById['recipe-1'].title),'Step one');
    assert.equal(loaded.recipesById['recipe-1'].portions,9);
  });

  await scenario(7, 'real JS <-> JNI/Rust SyncState after divergent offline edits', async () => {
    const native=await open(seed);
    await call('putString',native,recipe('title'),txt('Android title'));
    const web=edit(seed,'web-offline',d=>{d.pantryById['item-1'].preference=1;});
    const state=await newSession();
    const {web:converged,messages,rounds}=await sync(web,native,state);
    assert.ok(messages>0 && rounds>0);
    assert.equal(rawText(converged.recipesById['recipe-1'].title),'Android title');
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
    assert.equal(rawText(web.pantryById['item-1'].name),'red tomatoes');
  });

    await scenario(9, 'three replicas converge without cross-handle contamination', async () => {
    const first=await open(seed,102,'android-a');
    const second=await open(seed,103,'android-b');
    // Scenario 8 wrote red tomatoes to a different handle. New handles must
    // start from the seed, independent of previously disposed native state.
    assert.equal(await nativeGet(first,pantry('name')),'tomatoes');
    assert.equal(await nativeGet(second,pantry('name')),'tomatoes');
    assert.deepEqual(JSON.parse(await call('heads',first)),seedHeads);
    assert.deepEqual(JSON.parse(await call('heads',second)),seedHeads);
    await call('putInt',first,recipe('portions'),7);
    await call('putString',second,recipe('title'),txt('Shared toast'));
    const web=edit(seed,'web-third',d=>{d.pantryById['item-1'].name='cherry tomatoes';});
    // Real SyncState is scoped per web/native peer pair. All new sessions
    // start with an independent native State::new.
    const a=await sync(web,first,await newSession());
    assert.equal(rawText(a.web.pantryById['item-1'].name),'cherry tomatoes');
    const b=await sync(a.web,second,await newSession());
    assert.equal(rawText(b.web.pantryById['item-1'].name),'cherry tomatoes');
    const c=await sync(b.web,first,await newSession());
    const d=await sync(c.web,second,await newSession());
    const firstFinal=A.load(await nativeSave(first));
    const secondFinal=A.load(await nativeSave(second));
    for (const doc of [web,a.web,b.web,c.web,d.web,firstFinal,secondFinal]) {
      assert.equal(rawText(doc.pantryById['item-1'].name),'cherry tomatoes');
    }
    for (const doc of [d.web,firstFinal,secondFinal]) {
      assert.equal(doc.recipesById['recipe-1'].portions,7);
      assert.equal(rawText(doc.recipesById['recipe-1'].title),'Shared toast');
    }
    assert.deepEqual(logical(firstFinal),logical(secondFinal));
    assert.deepEqual(A.getHeads(firstFinal).sort(),A.getHeads(secondFinal).sort());
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


  await scenario(11, 'concurrent edits to different properties of one stable-ID ingredient', async () => {
    const id=await open(seed);
    await call('putString',id,recipe('ingredientsById','ingredient-tomato','amount'),txt('5'));
    const web=edit(seed,'web-ingredient',d=>{d.recipesById['recipe-1'].ingredientsById['ingredient-tomato'].name='garden tomatoes';});
    const result=await sync(web,id,await newSession());
    const ingredient=result.web.recipesById['recipe-1'].ingredientsById['ingredient-tomato'];
    assert.equal(rawText(ingredient.amount),'5');
    assert.equal(rawText(ingredient.name),'garden tomatoes');
  });

  await scenario(12, 'concurrent map-as-set allergen additions are preserved', async () => {
    const id=await open(seed);
    await call('putBool',id,'allergiesByValue/peanuts','true');
    const web=edit(seed,'web-allergy',d=>{d.allergiesByValue.sesame=true;});
    const result=await sync(web,id,await newSession());
    assert.equal(result.web.allergiesByValue.peanuts,true);
    assert.equal(result.web.allergiesByValue.sesame,true);
  });

  await scenario(13, 'same recipe title disagreement exposes both Text and scalar alternatives', async () => {
    const id=await open(seed);
    await call('putString',id,recipe('title'),txt('Native basil toast'));
    const web=edit(seed,'web-title',d=>{d.recipesById['recipe-1'].title='Web basil toast';});
    const result=await sync(web,id,await newSession());
    const actual=await nativeConflicts(id,recipe('title'));
    assert.deepEqual(actual.map(x=>x.value).sort(),['Native basil toast','Web basil toast']);
    assert.deepEqual(Object.values(A.getConflicts(result.web.recipesById['recipe-1'],'title')??{}).map(String).sort(),
      ['Native basil toast','Web basil toast']);
    assert.ok(actual.every(x=>x.opId.includes('@')));
  });

  await scenario(14, 'tombstone delete-versus-edit survives with a stable recipe ID', async () => {
    const id=await open(seed);
    await call('putBool',id,recipe('lifecycle','deleted'),'true');
    const web=edit(seed,'web-edit-during-delete',d=>{d.recipesById['recipe-1'].title='Edited while deleted';});
    const result=await sync(web,id,await newSession());
    assert.equal(result.web.recipesById['recipe-1'].lifecycle.deleted,true);
    assert.equal(rawText(result.web.recipesById['recipe-1'].title),'Edited while deleted');
  });

  await scenario(15, 'stable-ID concurrent chat appends preserve both message maps', async () => {
    const id=await open(seed);
    await call('putString',id,'conversationsById/conversation-1/messagesById/native-message/content',
      txt('Native suggests tomato soup'));
    const web=edit(seed,'web-chat',d=>{
      d.conversationsById['conversation-1'].messagesById['web-message']={
        id:'web-message',role:'user',content:'Any other ideas?'};
    });
    const result=await sync(web,id,await newSession());
    const messages=result.web.conversationsById['conversation-1'].messagesById;
    assert.equal(rawText(messages['native-message'].content),'Native suggests tomato soup');
    assert.equal(rawText(messages['web-message'].content),'Any other ideas?');
  });

  await scenario(16, 'logical duplicate pantry items retain distinct stable IDs', async () => {
    const id=await open(seed);
    await call('putString',id,'pantryById/native-carrots/name',txt('carrots'));
    await call('putInt',id,'pantryById/native-carrots/preference',1);
    const web=edit(seed,'web-pantry',d=>{
      d.pantryById['web-carrots']={id:'web-carrots',name:'carrots',preference:5};
    });
    const result=await sync(web,id,await newSession());
    assert.equal(rawText(result.web.pantryById['native-carrots'].name),'carrots');
    assert.equal(rawText(result.web.pantryById['web-carrots'].name),'carrots');
    assert.notEqual(result.web.pantryById['native-carrots'].preference,
      result.web.pantryById['web-carrots'].preference);
  });

  await scenario(17, 'multi-edit offline divergence and new sessions converge', async () => {
    const id=await open(seed);
    await call('putInt',id,recipe('portions'),8);
    await call('putString',id,recipe('title'),txt('Native herbed toast'));
    await call('putBool',id,'allergiesByValue/peanuts','true');
    const web=edit(seed,'web-multi-offline',d=>{
      d.pantryById['item-1'].preference=2;
      d.recipesById['recipe-1'].ingredientsById['ingredient-tomato'].amount='6';
      d.allergiesByValue.sesame=true;
    });
    const result=await sync(web,id,await newSession());
    assert.equal(result.web.recipesById['recipe-1'].portions,8);
    assert.equal(rawText(result.web.recipesById['recipe-1'].title),'Native herbed toast');
    assert.equal(result.web.allergiesByValue.peanuts,true);
    assert.equal(result.web.allergiesByValue.sesame,true);
    assert.equal(result.web.pantryById['item-1'].preference,2);
    assert.equal(rawText(result.web.recipesById['recipe-1'].ingredientsById['ingredient-tomato'].amount),'6');
  });

  // The mapping to the authoritative 18 scenario contract is explicit.
  // A map+scalar bridge cannot claim same-character text/list API coverage.
  const contract = [
    ['different recipe fields','PASS',3],
    ['same nested entity different properties','PASS',11],
    ['concurrent additions to ordered lists','PARTIAL',16],
    ['concurrent text editing','NOT_IMPLEMENTED'],
    ['chat appends (map entries; ordered chat list excluded)','PARTIAL',15],
    ['set-like additions','PASS',12],
    ['same scalar disagreement','PASS',4,5],
    ['same atomic title','PASS',13],
    ['delete-vs-edit with tombstone (no physical delete)','PARTIAL',14],
    ['duplicate pantry item (no explicit order)','PARTIAL',16],
    ['reorder + edit','NOT_IMPLEMENTED'],
    ['restart','PASS',8],
    ['out-of-order changes','PASS',6],
    ['duplicate delivery','PASS',6],
    ['long offline divergence','PASS',17],
    ['merge direction (bidirectional change apply)','PARTIAL',3],
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
