import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { LoroDoc } from 'loro-crdt';

const OUT = path.resolve('artifacts/loro');
fs.mkdirSync(OUT, { recursive: true });

const PEERS = { seed: '900', iphone: '101', macbook: '202', ipad: '303' };
const ACTOR = Object.fromEntries(Object.entries(PEERS).map(([name, peer]) => [peer, name]));

function doc(actor = 'seed') {
  const d = new LoroDoc();
  d.setPeerId(PEERS[actor] ?? actor);
  return d;
}
function save(d, actor, message) {
  d.commit({ message: `device:${actor}; ${message}` });
}
function clone(base, actor) {
  const d = base.fork();
  d.setPeerId(PEERS[actor] ?? actor);
  return d;
}
function sync(a, b) {
  const au = a.export({ mode: 'update', from: b.oplogVersion() });
  const bu = b.export({ mode: 'update', from: a.oplogVersion() });
  a.import(bu);
  b.import(au);
  return { aBytes: au.byteLength, bBytes: bu.byteLength };
}
function seed() {
  const d = doc();
  d.getMap('recipes-registry').set('recipe-1', true);
  const recipe = d.getMap('recipe:recipe-1');
  recipe.set('id', 'recipe-1');
  recipe.set('title', 'Tomato toast');
  recipe.set('portions', 2);

  const ingredient = d.getMap('ingredient:ingredient-1');
  ingredient.set('id', 'ingredient-1');
  ingredient.set('recipeId', 'recipe-1');
  ingredient.set('name', 'tomatoes');
  ingredient.set('amount', '2');
  d.getMovableList('recipe:recipe-1:ingredients').push('ingredient-1');

  d.getMap('step:step-1').set('id', 'step-1');
  d.getMap('step:step-1').set('recipeId', 'recipe-1');
  d.getText('step:step-1:text').insert(0, 'Heat oil, then add tomatoes.');
  d.getMap('step:step-2').set('id', 'step-2');
  d.getMap('step:step-2').set('recipeId', 'recipe-1');
  d.getText('step:step-2:text').insert(0, 'Serve on toast.');
  d.getMovableList('recipe:recipe-1:steps').push('step-1');
  d.getMovableList('recipe:recipe-1:steps').push('step-2');

  d.getList('conversation:chat-1:messages').push({
    id: 'message-base',
    role: 'user',
    content: 'What can I cook?',
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  d.getMap('set:allergies');
  d.getMap('pantry-registry');
  save(d, 'seed', 'common fixture');
  return d;
}

function peerOf(changeId) {
  return String(changeId).slice(String(changeId).lastIndexOf('@') + 1);
}
function actorOf(change, peer) {
  if (ACTOR[peer]) return ACTOR[peer];
  const m = typeof change.msg === 'string' ? /device:([^;]+)/u.exec(change.msg) : null;
  return m?.[1] ?? peer;
}
function writes(d, mapName, key) {
  const result = [];
  const container = `cid:root-${mapName}:Map`;
  const history = d.exportJsonUpdates(undefined, undefined, false);
  for (const change of history.changes ?? []) {
    const peer = peerOf(change.id);
    for (const op of change.ops ?? []) {
      if (
        op.container === container &&
        op.content?.type === 'insert' &&
        op.content?.key === key
      ) {
        result.push({
          value: op.content.value,
          actor: actorOf(change, peer),
          peer,
          counter: op.counter,
          changeId: String(change.id),
          message: change.msg ?? null
        });
      }
    }
  }
  return result;
}
function relation(d, a, b) {
  return d.cmpFrontiers(
    [{ peer: a.peer, counter: a.counter }],
    [{ peer: b.peer, counter: b.counter }]
  );
}
function maximal(d, ops) {
  return ops.filter((candidate) => !ops.some((other) =>
    other !== candidate && relation(d, candidate, other) === -1
  ));
}
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function disagreement(d, mapName, key, logicalPath) {
  const candidates = maximal(d, writes(d, mapName, key));
  const values = [];
  for (const item of candidates) {
    if (!values.some((v) => sameValue(v, item.value))) values.push(item.value);
  }
  const pairs = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (relation(d, candidates[i], candidates[j]) === undefined) {
        pairs.push([candidates[i].changeId, candidates[j].changeId]);
      }
    }
  }
  if (values.length < 2 || pairs.length === 0) return null;
  return {
    entityType: logicalPath[0],
    entityId: logicalPath[1],
    path: logicalPath.slice(2),
    alternatives: candidates.map(({ value, actor, changeId }) => ({ value, actor, changeId })),
    concurrentPairs: pairs
  };
}
function latestWrite(d, mapName, key, actor) {
  return writes(d, mapName, key).filter((w) => !actor || w.actor === actor).at(-1) ?? null;
}

async function run(id, name, fn) {
  try {
    return { id, name, status: 'PASS', ...(await fn()) };
  } catch (error) {
    return {
      id,
      name,
      status: 'FAIL',
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    };
  }
}

const tests = [];

tests.push(await run(1, 'Different recipe fields', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('recipe:recipe-1').set('title', 'Roasted tomato toast');
  save(iphone, 'iphone', 'title');
  macbook.getMap('recipe:recipe-1').set('portions', 4);
  save(macbook, 'macbook', 'portions');
  sync(iphone, macbook);
  assert.equal(iphone.getMap('recipe:recipe-1').get('title'), 'Roasted tomato toast');
  assert.equal(iphone.getMap('recipe:recipe-1').get('portions'), 4);
  assert.deepEqual(iphone.toJSON(), macbook.toJSON());
  assert.equal(disagreement(iphone, 'recipe:recipe-1', 'title', ['recipe', 'recipe-1', 'title']), null);
  assert.equal(disagreement(iphone, 'recipe:recipe-1', 'portions', ['recipe', 'recipe-1', 'portions']), null);
  return { observed: iphone.getMap('recipe:recipe-1').toJSON() };
}));

tests.push(await run(2, 'Same nested entity, different properties', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('ingredient:ingredient-1').set('amount', '3');
  save(iphone, 'iphone', 'ingredient amount');
  macbook.getMap('ingredient:ingredient-1').set('name', 'tomatoes (ripe)');
  save(macbook, 'macbook', 'ingredient qualifier');
  sync(iphone, macbook);
  const value = iphone.getMap('ingredient:ingredient-1').toJSON();
  assert.equal(value.amount, '3');
  assert.equal(value.name, 'tomatoes (ripe)');
  assert.deepEqual(iphone.toJSON(), macbook.toJSON());
  return { observed: value };
}));

tests.push(await run(3, 'Concurrent additions', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('ingredient:ingredient-iphone').set('name', 'basil');
  iphone.getMovableList('recipe:recipe-1:ingredients').insert(1, 'ingredient-iphone');
  save(iphone, 'iphone', 'add basil');
  macbook.getMap('ingredient:ingredient-macbook').set('name', 'garlic');
  macbook.getMovableList('recipe:recipe-1:ingredients').insert(1, 'ingredient-macbook');
  save(macbook, 'macbook', 'add garlic');
  sync(iphone, macbook);
  const order = iphone.getMovableList('recipe:recipe-1:ingredients').toArray();
  assert.deepEqual(order, macbook.getMovableList('recipe:recipe-1:ingredients').toArray());
  assert.equal(new Set(order).size, 3);
  assert.ok(order.includes('ingredient-iphone') && order.includes('ingredient-macbook'));
  return { deterministicOrder: order };
}));

tests.push(await run(4, 'Concurrent text editing', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getText('step:step-1:text').insert(0, 'Gently ');
  save(iphone, 'iphone', 'prefix method');
  macbook.getText('step:step-1:text').push(' Simmer for 10 minutes.');
  save(macbook, 'macbook', 'suffix method');
  sync(iphone, macbook);
  const text = iphone.getText('step:step-1:text').toString();
  assert.equal(text, macbook.getText('step:step-1:text').toString());
  assert.ok(text.startsWith('Gently ') && text.endsWith(' Simmer for 10 minutes.'));
  return { exactResult: text };
}));

tests.push(await run(5, 'Chat appends', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getList('conversation:chat-1:messages').push({ id: 'iphone-message', role: 'user', content: 'Use basil', createdAt: '2026-01-01T00:01:00Z' });
  save(iphone, 'iphone', 'chat append');
  macbook.getList('conversation:chat-1:messages').push({ id: 'mac-message', role: 'assistant', content: 'Try toast', createdAt: '2026-01-01T00:01:01Z' });
  save(macbook, 'macbook', 'chat append');
  sync(iphone, macbook);
  const messages = iphone.getList('conversation:chat-1:messages').toArray();
  assert.equal(messages.length, 3);
  assert.ok(messages.some((m) => m.id === 'iphone-message'));
  assert.ok(messages.some((m) => m.id === 'mac-message'));
  assert.deepEqual(messages, macbook.getList('conversation:chat-1:messages').toArray());
  return { messageIds: messages.map((m) => m.id) };
}));

tests.push(await run(6, 'Set-like additions', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('set:allergies').set('sesame', true);
  save(iphone, 'iphone', 'set add sesame');
  macbook.getMap('set:allergies').set('peanut', true);
  save(macbook, 'macbook', 'set add peanut');
  sync(iphone, macbook);
  const value = iphone.getMap('set:allergies').toJSON();
  assert.equal(value.sesame, true);
  assert.equal(value.peanut, true);
  assert.deepEqual(iphone.toJSON(), macbook.toJSON());
  return { observed: value };
}));

tests.push(await run(7, 'Same scalar disagreement', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('recipe:recipe-1').set('portions', 4);
  save(iphone, 'iphone', 'portions=4');
  macbook.getMap('recipe:recipe-1').set('portions', 6);
  save(macbook, 'macbook', 'portions=6');
  sync(iphone, macbook);

  const evidence = disagreement(iphone, 'recipe:recipe-1', 'portions', ['recipe', 'recipe-1', 'portions']);
  assert.ok(evidence);
  assert.deepEqual(new Set(evidence.alternatives.map((a) => a.value)), new Set([4, 6]));
  assert.deepEqual(new Set(evidence.alternatives.map((a) => a.actor)), new Set(['iphone', 'macbook']));

  const snapshot = iphone.export({ mode: 'snapshot' });
  const restarted = new LoroDoc();
  restarted.import(snapshot);
  const afterRestart = disagreement(restarted, 'recipe:recipe-1', 'portions', ['recipe', 'recipe-1', 'portions']);
  assert.ok(afterRestart);
  assert.deepEqual(new Set(afterRestart.alternatives.map((a) => a.value)), new Set([4, 6]));

  restarted.setPeerId(PEERS.ipad);
  restarted.getMap('recipe:recipe-1').set('portions', 4);
  save(restarted, 'ipad', 'resolution after review');
  assert.equal(disagreement(restarted, 'recipe:recipe-1', 'portions', ['recipe', 'recipe-1', 'portions']), null);

  let shallowSnapshotEvidence;
  try {
    const shallowBytes = iphone.export({ mode: 'shallow-snapshot', frontiers: iphone.frontiers() });
    const shallow = new LoroDoc();
    shallow.import(shallowBytes);
    shallowSnapshotEvidence = disagreement(shallow, 'recipe:recipe-1', 'portions', ['recipe', 'recipe-1', 'portions']);
  } catch (error) {
    shallowSnapshotEvidence = { error: error instanceof Error ? error.message : String(error) };
  }

  let shallowAfterUnrelatedEditEvidence;
  try {
    const advanced = iphone.fork();
    advanced.setPeerId(PEERS.ipad);
    advanced.getMap('set:allergies').set('mustard', true);
    save(advanced, 'ipad', 'unrelated edit after unresolved portions conflict');
    const shallowBytes = advanced.export({ mode: 'shallow-snapshot', frontiers: advanced.frontiers() });
    const shallow = new LoroDoc();
    shallow.import(shallowBytes);
    shallowAfterUnrelatedEditEvidence = disagreement(shallow, 'recipe:recipe-1', 'portions', ['recipe', 'recipe-1', 'portions']);
  } catch (error) {
    shallowAfterUnrelatedEditEvidence = { error: error instanceof Error ? error.message : String(error) };
  }

  return {
    visibleWinner: iphone.getMap('recipe:recipe-1').get('portions'),
    evidence,
    afterRestart,
    laterResolutionCausallySupersedes: true,
    shallowSnapshotEvidence,
    shallowAfterUnrelatedEditEvidence
  };
}));

tests.push(await run(8, 'Different atomic titles', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('recipe:recipe-1').set('title', 'Tomato bruschetta');
  save(iphone, 'iphone', 'title A');
  macbook.getMap('recipe:recipe-1').set('title', 'Garlicky tomato toast');
  save(macbook, 'macbook', 'title B');
  sync(iphone, macbook);
  const evidence = disagreement(iphone, 'recipe:recipe-1', 'title', ['recipe', 'recipe-1', 'title']);
  assert.ok(evidence);
  assert.deepEqual(new Set(evidence.alternatives.map((a) => a.value)), new Set(['Tomato bruschetta', 'Garlicky tomato toast']));
  return { visibleWinner: iphone.getMap('recipe:recipe-1').get('title'), evidence };
}));

tests.push(await run(9, 'Delete versus edit', () => {
  const base = seed(), deleted = clone(base, 'iphone'), edited = clone(base, 'macbook');
  deleted.getMap('recipes-registry').delete('recipe-1');
  save(deleted, 'iphone', 'physical registry delete');
  edited.getMap('recipe:recipe-1').set('title', 'Edited while offline');
  save(edited, 'macbook', 'concurrent edit');
  sync(deleted, edited);
  const raw = {
    visibleMembership: deleted.getMap('recipes-registry').get('recipe-1') ?? null,
    editedEntityStillStored: deleted.getMap('recipe:recipe-1').get('title')
  };

  const base2 = seed(), tombstone = clone(base2, 'iphone'), edit2 = clone(base2, 'macbook');
  tombstone.getMap('recipe:recipe-1').set('deleted', true);
  save(tombstone, 'iphone', 'semantic tombstone');
  edit2.getMap('recipe:recipe-1').set('title', 'Edited while offline');
  save(edit2, 'macbook', 'concurrent edit');
  sync(tombstone, edit2);
  const dw = latestWrite(tombstone, 'recipe:recipe-1', 'deleted', 'iphone');
  const ew = latestWrite(tombstone, 'recipe:recipe-1', 'title', 'macbook');
  assert.ok(dw && ew);
  assert.equal(relation(tombstone, dw, ew), undefined);
  assert.equal(tombstone.getMap('recipe:recipe-1').get('deleted'), true);
  assert.equal(tombstone.getMap('recipe:recipe-1').get('title'), 'Edited while offline');
  return {
    rawPhysicalDelete: raw,
    recommendedLifecycle: tombstone.getMap('recipe:recipe-1').toJSON(),
    semanticReview: { concurrent: true, actions: ['Keep edited recipe', 'Keep deleted'] }
  };
}));

tests.push(await run(10, 'Duplicate pantry creation', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('pantry-registry').set('pantry-iphone', true);
  iphone.getMap('pantry:pantry-iphone').set('id', 'pantry-iphone');
  iphone.getMap('pantry:pantry-iphone').set('name', 'Carrots');
  iphone.getMap('pantry:pantry-iphone').set('preference', 5);
  save(iphone, 'iphone', 'create carrots');
  macbook.getMap('pantry-registry').set('pantry-macbook', true);
  macbook.getMap('pantry:pantry-macbook').set('id', 'pantry-macbook');
  macbook.getMap('pantry:pantry-macbook').set('name', ' carrots ');
  macbook.getMap('pantry:pantry-macbook').set('preference', 2);
  save(macbook, 'macbook', 'create equivalent carrots');
  sync(iphone, macbook);
  const ids = Object.keys(iphone.getMap('pantry-registry').toJSON()).sort();
  assert.deepEqual(ids, ['pantry-iphone', 'pantry-macbook']);
  const a = iphone.getMap('pantry:pantry-iphone').toJSON();
  const b = iphone.getMap('pantry:pantry-macbook').toJSON();
  const normalize = (name) => name.trim().toLocaleLowerCase();
  assert.equal(normalize(a.name), normalize(b.name));
  return {
    rawIds: ids,
    semanticDedupeRequired: true,
    review: { normalizedName: normalize(a.name), preferenceAlternatives: [a.preference, b.preference] }
  };
}));

tests.push(await run(11, 'Reorder + edit', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMovableList('recipe:recipe-1:steps').move(1, 0);
  save(iphone, 'iphone', 'reorder steps');
  macbook.getMap('step:step-1').set('timerHint', '5 min');
  save(macbook, 'macbook', 'edit step');
  sync(iphone, macbook);
  const order = iphone.getMovableList('recipe:recipe-1:steps').toArray();
  assert.deepEqual(order, ['step-2', 'step-1']);
  assert.equal(iphone.getMap('step:step-1').get('timerHint'), '5 min');
  assert.deepEqual(iphone.toJSON(), macbook.toJSON());
  return { order, editedStep: iphone.getMap('step:step-1').toJSON() };
}));

tests.push(await run(12, 'Restart', () => {
  const original = seed();
  original.setPeerId(PEERS.iphone);
  original.getMap('recipe:recipe-1').set('title', 'Before restart');
  save(original, 'iphone', 'before restart');
  const snapshot = original.export({ mode: 'snapshot' });
  const restored = new LoroDoc();
  restored.import(snapshot);
  restored.setPeerId(PEERS.macbook);
  restored.getMap('recipe:recipe-1').set('portions', 5);
  save(restored, 'macbook', 'after restart');
  assert.equal(restored.getMap('recipe:recipe-1').get('title'), 'Before restart');
  assert.equal(restored.getMap('recipe:recipe-1').get('portions'), 5);
  return { snapshotBytes: snapshot.byteLength, observed: restored.getMap('recipe:recipe-1').toJSON() };
}));

tests.push(await run(13, 'Out-of-order import', () => {
  const source = doc('iphone');
  source.getMap('out-of-order').set('first', 1);
  save(source, 'iphone', 'first');
  const firstUpdate = source.export({ mode: 'update' });
  const firstVersion = source.oplogVersion();
  source.getMap('out-of-order').set('second', 2);
  save(source, 'iphone', 'second');
  const secondUpdate = source.export({ mode: 'update', from: firstVersion });
  const target = doc('macbook');
  const pending = target.import(secondUpdate);
  assert.equal(target.getMap('out-of-order').get('second'), undefined);
  target.import(firstUpdate);
  assert.equal(target.getMap('out-of-order').get('first'), 1);
  assert.equal(target.getMap('out-of-order').get('second'), 2);
  return {
    pendingBeforeDependency: pending.pending ? Object.fromEntries(pending.pending) : null,
    convergedAfterDependency: true
  };
}));

tests.push(await run(14, 'Duplicate update', () => {
  const source = seed(), target = doc('iphone');
  const update = source.export({ mode: 'update' });
  target.import(update);
  const once = target.toJSON();
  target.import(update);
  assert.deepEqual(target.toJSON(), once);
  return { idempotent: true, updateBytes: update.byteLength };
}));

tests.push(await run(15, 'Long offline divergence', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('recipe:recipe-1').set('portions', 4);
  iphone.getMap('recipe:recipe-1').set('description', 'Bright and fresh');
  iphone.getMovableList('recipe:recipe-1:ingredients').push('ingredient-iphone-long');
  iphone.getMap('ingredient:ingredient-iphone-long').set('name', 'basil');
  save(iphone, 'iphone', 'offline batch one');
  iphone.getText('step:step-1:text').insert(0, 'Carefully ');
  save(iphone, 'iphone', 'offline batch two');

  macbook.getMap('recipe:recipe-1').set('portions', 6);
  macbook.getMap('recipe:recipe-1').set('notes', 'Use good bread');
  macbook.getMovableList('recipe:recipe-1:ingredients').push('ingredient-mac-long');
  macbook.getMap('ingredient:ingredient-mac-long').set('name', 'garlic');
  save(macbook, 'macbook', 'offline batch one');
  macbook.getText('step:step-2:text').push(' Warm plates first.');
  save(macbook, 'macbook', 'offline batch two');

  sync(iphone, macbook);
  assert.deepEqual(iphone.toJSON(), macbook.toJSON());
  const evidence = disagreement(iphone, 'recipe:recipe-1', 'portions', ['recipe', 'recipe-1', 'portions']);
  assert.ok(evidence);
  return { converged: true, disagreement: evidence, ingredients: iphone.getMovableList('recipe:recipe-1:ingredients').toArray() };
}));

tests.push(await run(16, 'Merge direction', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook');
  iphone.getMap('recipe:recipe-1').set('title', 'Phone title');
  save(iphone, 'iphone', 'direction edit');
  macbook.getMap('recipe:recipe-1').set('portions', 7);
  save(macbook, 'macbook', 'direction edit');
  const v = base.oplogVersion();
  const iu = iphone.export({ mode: 'update', from: v });
  const mu = macbook.export({ mode: 'update', from: v });
  const ab = base.fork(), ba = base.fork();
  ab.setPeerId(PEERS.ipad);
  ba.setPeerId('404');
  ab.import(iu); ab.import(mu);
  ba.import(mu); ba.import(iu);
  assert.deepEqual(ab.toJSON(), ba.toJSON());
  return { equivalent: true, observed: ab.getMap('recipe:recipe-1').toJSON() };
}));

tests.push(await run(17, 'Incremental sync/updates', () => {
  const source = seed(), target = doc('macbook');
  target.import(source.export({ mode: 'update' }));
  const from = target.oplogVersion();
  source.setPeerId(PEERS.iphone);
  source.getMap('recipe:recipe-1').set('description', 'Incremental change');
  save(source, 'iphone', 'tiny incremental edit');
  const update = source.export({ mode: 'update', from });
  const snapshot = source.export({ mode: 'snapshot' });
  target.import(update);
  assert.equal(target.getMap('recipe:recipe-1').get('description'), 'Incremental change');
  return { incrementalBytes: update.byteLength, snapshotBytes: snapshot.byteLength, ratio: update.byteLength / snapshot.byteLength };
}));

tests.push(await run(18, 'Three replicas', () => {
  const base = seed(), iphone = clone(base, 'iphone'), macbook = clone(base, 'macbook'), ipad = clone(base, 'ipad');
  iphone.getMap('recipe:recipe-1').set('title', 'Three-way title');
  save(iphone, 'iphone', 'three-way title');
  macbook.getMap('recipe:recipe-1').set('portions', 8);
  save(macbook, 'macbook', 'three-way portions');
  ipad.getMap('set:allergies').set('shellfish', true);
  save(ipad, 'ipad', 'three-way set');
  const updates = [iphone.export({ mode: 'update' }), macbook.export({ mode: 'update' }), ipad.export({ mode: 'update' })];
  for (const replica of [iphone, macbook, ipad]) {
    for (const update of updates) replica.import(update);
  }
  assert.deepEqual(iphone.toJSON(), macbook.toJSON());
  assert.deepEqual(macbook.toJSON(), ipad.toJSON());
  return { converged: true, recipe: iphone.getMap('recipe:recipe-1').toJSON(), allergies: iphone.getMap('set:allergies').toJSON() };
}));

let mergeableContainers;
try {
  const iphone = doc('iphone'), macbook = doc('macbook');
  iphone.getMap('dynamic').ensureMergeableMap('entity').set('iphoneField', 'A');
  save(iphone, 'iphone', 'mergeable create');
  macbook.getMap('dynamic').ensureMergeableMap('entity').set('macbookField', 'B');
  save(macbook, 'macbook', 'mergeable create');
  sync(iphone, macbook);
  assert.deepEqual(iphone.toJSON(), macbook.toJSON());
  mergeableContainers = { status: 'PASS', observed: iphone.toJSON().dynamic.entity };
} catch (error) {
  mergeableContainers = { status: 'FAIL', error: error instanceof Error ? error.message : String(error) };
}

function performanceFixture() {
  const d = doc();

  const pantry = d.getMap('pantry-registry');
  for (let i = 0; i < 200; i += 1) {
    const id = `pantry-${String(i).padStart(4, '0')}`;
    pantry.set(id, true);
    const item = d.getMap(`pantry:${id}`);
    item.set('id', id);
    item.set('name', `ingredient ${i}`);
    item.set('preference', (i % 5) + 1);
    item.set('createdAt', '2026-01-01T00:00:00Z');
    item.set('updatedAt', '2026-01-01T00:00:00Z');
  }

  const recipes = d.getMap('recipes-registry');
  const recipeOrder = d.getMovableList('recipe-order');
  for (let i = 0; i < 500; i += 1) {
    const id = `recipe-${String(i).padStart(4, '0')}`;
    recipes.set(id, true);
    recipeOrder.push(id);
    const recipe = d.getMap(`recipe:${id}`);
    recipe.set('id', id);
    recipe.set('title', `Recipe ${i}`);
    recipe.set('description', `Representative local-first recipe ${i}.`);
    recipe.set('portions', 2 + (i % 5));
    recipe.set('deleted', false);
    recipe.set('deletedAt', null);
    recipe.set('deletedBy', null);

    const ingredients = d.getMovableList(`recipe:${id}:ingredients`);
    for (let j = 0; j < 5; j += 1) {
      const ingredientId = `${id}-ingredient-${j}`;
      ingredients.push(ingredientId);
      const ing = d.getMap(`ingredient:${ingredientId}`);
      ing.set('id', ingredientId);
      ing.set('recipeId', id);
      ing.set('name', `ingredient ${(i * 5 + j) % 200}`);
      ing.set('amount', `${j + 1} tbsp`);
    }

    const steps = d.getMovableList(`recipe:${id}:steps`);
    for (let j = 0; j < 4; j += 1) {
      const stepId = `${id}-step-${j}`;
      steps.push(stepId);
      d.getMap(`step:${stepId}`).set('id', stepId);
      d.getText(`step:${stepId}:text`).insert(0, `Cook step ${j} for recipe ${i}.`);
    }
  }

  const conversations = d.getMap('conversations-registry');
  const conversationOrder = d.getMovableList('conversation-order');
  for (let i = 0; i < 100; i += 1) {
    const id = `conversation-${String(i).padStart(3, '0')}`;
    conversations.set(id, true);
    conversationOrder.push(id);
    d.getMap(`conversation:${id}`).set('id', id);
    const messageRegistry = d.getMap(`conversation:${id}:messages-registry`);
    const messageOrder = d.getMovableList(`conversation:${id}:message-order`);
    for (let j = 0; j < 20; j += 1) {
      const messageId = `${id}-message-${String(j).padStart(2, '0')}`;
      messageRegistry.set(messageId, true);
      messageOrder.push(messageId);
      const message = d.getMap(`message:${messageId}`);
      message.set('id', messageId);
      message.set('role', j % 2 === 0 ? 'user' : 'assistant');
      message.set('content', `Representative message ${j} in conversation ${i} about dinner ideas.`);
    }
  }

  save(d, 'seed', 'performance fixture');
  return d;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

if (global.gc) global.gc();
const mem0 = process.memoryUsage().heapUsed;
const tBuild = performance.now();
const perfDoc = performanceFixture();
const buildMs = performance.now() - tBuild;
if (global.gc) global.gc();
const mem1 = process.memoryUsage().heapUsed;

const tSnap = performance.now();
const perfSnapshot = perfDoc.export({ mode: 'snapshot' });
const snapshotExportMs = performance.now() - tSnap;

const coldLoadSamples = [];
for (let i = 0; i < 5; i += 1) {
  const loaded = new LoroDoc();
  const tLoad = performance.now();
  loaded.import(perfSnapshot);
  loaded.toJSON();
  coldLoadSamples.push(performance.now() - tLoad);
  loaded.free?.();
}

const beforeTiny = perfDoc.oplogVersion();
perfDoc.setPeerId(PEERS.iphone);
perfDoc.getMap('recipe:recipe-0000').set('description', 'A tiny edited description.');
save(perfDoc, 'iphone', 'benchmark tiny edit');
const tiny = perfDoc.export({ mode: 'update', from: beforeTiny });

const left = new LoroDoc(), right = new LoroDoc();
left.import(perfSnapshot);
right.import(perfSnapshot);
left.setPeerId(PEERS.iphone);
right.setPeerId(PEERS.macbook);
left.getMap('recipe:recipe-0001').set('title', 'Phone recipe title');
save(left, 'iphone', 'benchmark merge title');
right.getMap('pantry:pantry-0001').set('preference', 5);
save(right, 'macbook', 'benchmark merge pantry preference');
const tMerge = performance.now();
const mergeBytes = sync(left, right);
const twoReplicaMergeMs = performance.now() - tMerge;
assert.deepEqual(left.toJSON(), right.toJSON());

if (global.gc) global.gc();
const memAfterAll = process.memoryUsage().heapUsed;
const benchmark = {
  fixture: {
    pantryItems: 200,
    recipes: 500,
    conversations: 100,
    messagesPerConversation: 20,
    recipeIngredients: 5,
    recipeSteps: 4,
    comparisonShape: 'Matches the Automerge spike logical fixture: stable-ID maps plus explicit order lists and lifecycle metadata.'
  },
  snapshotBytes: perfSnapshot.byteLength,
  tinyIncrementalUpdateBytes: tiny.byteLength,
  buildMs,
  snapshotExportMs,
  coldLoadMs: {
    samples: coldLoadSamples,
    median: median(coldLoadSamples)
  },
  twoReplicaMergeMs,
  mergeUpdateBytes: mergeBytes,
  memory: {
    heapBeforeBytes: mem0,
    heapAfterBuildBytes: mem1,
    grossBuildDeltaBytes: mem1 - mem0,
    heapAfterAllBytes: memAfterAll
  }
};

const interop = (() => {
  const base = seed();
  const snapshot = base.export({ mode: 'snapshot' });
  const web = clone(base, 'iphone');
  web.getMap('recipe:recipe-1').set('portions', 4);
  save(web, 'iphone', 'interop web portions=4');
  const update = web.export({ mode: 'update', from: base.oplogVersion() });
  return {
    format: 1,
    webPackage: 'loro-crdt@1.16.4',
    scenario: 'base portions=2; web iphone=4; native ipad=6',
    snapshotBase64: Buffer.from(snapshot).toString('base64'),
    webUpdateBase64: Buffer.from(update).toString('base64'),
    baseJson: base.toJSON(),
    webForkJson: web.toJSON()
  };
})();

const output = {
  generatedAt: new Date().toISOString(),
  packages: { web: 'loro-crdt@1.16.4' },
  schema: {
    approach: 'Stable root containers keyed by logical entity ID; scalar fields in maps; ordered collections are movable lists of entity IDs; method text uses LoroText.',
    fairness: 'The common schema does not require Loro-only mergeable child containers; MergeableContainer is probed separately.'
  },
  tests,
  summary: {
    pass: tests.filter((t) => t.status === 'PASS').length,
    partial: tests.filter((t) => t.status === 'PARTIAL').length,
    fail: tests.filter((t) => t.status === 'FAIL').length
  },
  mergeableContainers,
  benchmark,
  disagreementReconstruction: {
    publicMethodsUsed: ['exportJsonUpdates', 'cmpFrontiers'],
    lowLevelFormatDependency: true,
    customVectorClock: false,
    prototypeScansFullRetainedHistory: true,
    productionWouldNeedDerivedIndexOrLedger: true
  }
};

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(output, null, 2));
fs.writeFileSync(path.join(OUT, 'benchmark.json'), JSON.stringify(benchmark, null, 2));
fs.writeFileSync(path.join(OUT, 'web-native-input.json'), JSON.stringify(interop, null, 2));
console.log(JSON.stringify(output, null, 2));
