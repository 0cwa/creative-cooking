import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as Automerge from './automerge.mjs';
import * as Loro from './loro.mjs';
import { makeEvent, ReviewLedger, writeCheckpoint, readCheckpoint } from './ledger.mjs';

const OUT = path.resolve('artifacts');
mkdirSync(OUT, { recursive: true });
const results = [];
const sampleEvents = [];
const idOf = (x) => x.map((a) => JSON.stringify(a)).sort();

function conflictEvent(E, doc, field, index) {
  const observed = E.scalar(doc, field, index);
  assert.equal(observed.concurrent, true, 'must prove live concurrent alternatives for ' + field);
  assert.equal(observed.alternatives.length, 2, 'must retain both source operations');
  assert.ok(observed.alternatives.every((a) => a.operationId && a.authorId),
    'no unattributed concurrent alternatives');
  return makeEvent({
    engine: E.ENGINE, kind: 'scalar-disagreement',
    entity: { type: 'recipe', id: 'recipe-1' }, path: [field],
    alternatives: observed.alternatives, concurrency: 'concurrent',
    frontier: observed.frontier, completeness: observed.completeness,
    missingCapabilities: observed.missingCapabilities,
    actions: ['choose-value', 'edit-new-value', 'dismiss-for-now'],
    reason: 'Concurrent writes to one atomic scalar'
  });
}
function conflictPair(E, field, first, second) {
  const seed = E.base();
  const phone = E.write(E.fork(seed, 'iphone'), 'iphone', field, first);
  const mac = E.write(E.fork(seed, 'macbook'), 'macbook', field, second);
  return { seed, phone, mac, doc: E.merge(phone, mac) };
}
function observedMeta(E, doc, operation, value, index) {
  if (E.ENGINE === 'automerge') {
    const change = E.metadata(doc).find((m) => {
      try { return JSON.parse(m.message)?.operation === operation; } catch { return false; }
    });
    return { value, changeId: change?.hash ?? null, operationId: null,
      authorId: change?.author ?? change?.actor ?? null, dependencies: change?.deps ?? null };
  }
  const fields = {
    deleted: ['recipe:recipe-1', 'deleted'],
    title: ['recipe:recipe-1', 'title'],
    carrotsPhone: ['pantry:carrot-phone', 'preference'],
    carrotsMac: ['pantry:carrot-mac', 'preference']
  };
  const [map, key] = fields[operation];
  index.update(doc);
  const item = index.writes(map, key).find((x) => JSON.stringify(x.value) === JSON.stringify(value));
  return { value, changeId: item?.changeId ?? null,
    operationId: item?.operationId ?? null, authorId: item?.authorId ?? null, dependencies: null };
}
function semanticEvent(E, kind, entity, field, alternatives, tokens, actions, reason) {
  return makeEvent({
    engine: E.ENGINE, kind, entity, path: field, alternatives,
    identityTokens: tokens, concurrency: kind === 'semantic-suspicion' ? 'not-applicable' : 'concurrent',
    completeness: alternatives.every((a) => a.changeId) ? 'partial' : 'partial',
    missingCapabilities: ['application-policy-not-inferred-by-crdt'],
    actions, reason
  });
}
function run(engine, id, name, fn) {
  const before = performance.now();
  try {
    const evidence = fn();
    const result = { engine: engine.ENGINE, id, name, status: 'PASS',
      ms: +(performance.now() - before).toFixed(3), evidence };
    results.push(result);
    console.log(engine.ENGINE + ' ' + id + '/12 PASS ' + name);
  } catch (err) {
    const result = { engine: engine.ENGINE, id, name, status: 'FAIL',
      ms: +(performance.now() - before).toFixed(3),
      error: err?.stack ?? String(err) };
    results.push(result);
    console.error(engine.ENGINE + ' ' + id + '/12 FAIL ' + name + ': ' + result.error);
  }
}

for (const E of [Automerge, Loro]) {
  const index = () => E.ENGINE === 'loro' ? new E.IncrementalIndex() : undefined;

  run(E, 1, 'Different recipe fields are quiet', () => {
    const seed = E.base();
    const a = E.write(E.fork(seed, 'iphone'), 'iphone', 'title', 'Roasted tomato toast');
    const b = E.write(E.fork(seed, 'macbook'), 'macbook', 'portions', 4);
    const m = E.merge(a, b);
    assert.equal(E.read(m, 'title'), 'Roasted tomato toast');
    assert.equal(E.read(m, 'portions'), 4);
    assert.equal(E.scalar(m, 'title', index()).concurrent, false);
    assert.equal(E.scalar(m, 'portions', index()).concurrent, false);
    return { lowPriorityActivityPossible: true, interruptingEvents: 0, fields: ['title', 'portions'] };
  });

  run(E, 2, 'Different properties of one ingredient', () => {
    const seed = E.base();
    const a = E.write(E.fork(seed, 'iphone'), 'iphone', 'ingredientAmount', '3');
    const b = E.write(E.fork(seed, 'macbook'), 'macbook', 'ingredientName', 'tomatoes (ripe)');
    const m = E.merge(a, b);
    assert.equal(E.read(m, 'ingredientAmount'), '3');
    assert.equal(E.read(m, 'ingredientName'), 'tomatoes (ripe)');
    return { ingredientId: 'ingredient-1', amount: '3', name: 'tomatoes (ripe)' };
  });

  run(E, 3, 'Concurrent portions preserve 4/6 and provenance', () => {
    const { doc } = conflictPair(E, 'portions', 4, 6);
    const event = conflictEvent(E, doc, 'portions', index());
    assert.deepEqual(idOf(event.alternatives.map((a) => a.value)), idOf([4, 6]));
    const events = new ReviewLedger();
    events.upsert(event); events.upsert(event);
    assert.equal(events.list().length, 1);
    const saved = E.load(E.save(doc));
    const repeated = conflictEvent(E, saved, 'portions', index());
    assert.equal(event.id, repeated.id, 'deterministic identity across full restart');
    assert.deepEqual(idOf(repeated.alternatives.map((a) => a.value)), idOf([4, 6]));
    assert.ok(event.alternatives.every((a) => a.changeId), 'web change identity must be attributable');
    sampleEvents.push(event);
    return { eventId: event.id, alternatives: event.alternatives,
      renderedValueNotApproved: E.read(doc, 'portions'), snapshotBytes: E.save(doc).byteLength,
      restartStable: true };
  });

  run(E, 4, 'Later causally ordered resolution to 5', () => {
    const { doc } = conflictPair(E, 'portions', 4, 6);
    const idx = index();
    const event = conflictEvent(E, doc, 'portions', idx);
    const ledger = new ReviewLedger([event]);
    const next = E.write(E.fork(doc, 'ipad'), 'ipad', 'portions', 5);
    const proof = E.causalResolution(next, event, 'portions', idx);
    assert.ok(proof?.causalProof, 'never auto-close on rendered LWW alone');
    ledger.resolve(event.id, proof);
    assert.equal(E.scalar(next, 'portions', idx).concurrent, false);
    assert.equal(ledger.get(event.id).status, 'resolved');
    assert.deepEqual(idOf(ledger.get(event.id).alternatives.map((a) => a.value)), idOf([4, 6]));
    const persisted = ReviewLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
    assert.equal(persisted.get(event.id).resolution.value, 5);
    persisted.upsert(event);
    assert.equal(persisted.get(event.id).status, 'resolved');
    sampleEvents.push(persisted.get(event.id));
    return { eventId: event.id, closureChangeId: proof.changeId, auditRetained: [4, 6],
      resolvedValue: 5 };
  });

  run(E, 5, 'Concurrent atomic titles', () => {
    const { doc } = conflictPair(E, 'title', 'Basil tomato toast', 'Garlicky tomato toast');
    const e = conflictEvent(E, doc, 'title', index());
    assert.deepEqual(idOf(e.alternatives.map((a) => a.value)),
      idOf(['Basil tomato toast', 'Garlicky tomato toast']));
    sampleEvents.push(e);
    return { eventId: e.id, alternatives: e.alternatives.map((a) => a.value) };
  });

  run(E, 6, 'Non-overlapping method text edits', () => {
    const seed = E.base();
    const a = E.write(E.fork(seed, 'iphone'), 'iphone', 'textPrefix');
    const b = E.write(E.fork(seed, 'macbook'), 'macbook', 'textSuffix');
    const m = E.merge(a, b);
    const text = E.read(m, 'stepText');
    assert.ok(text.startsWith('Gently '));
    assert.ok(text.endsWith(' Simmer for 10 minutes.'));
    return { exactText: text, unnecessaryScalarConflict: false };
  });

  run(E, 7, 'Reorder stable step IDs concurrent with content edit', () => {
    const seed = E.base();
    const a = E.write(E.fork(seed, 'iphone'), 'iphone', 'reorder');
    const b = E.write(E.fork(seed, 'macbook'), 'macbook', 'stepEdit', 'Stir for 5 minutes');
    const m = E.merge(a, b);
    assert.deepEqual(E.read(m, 'stepOrder'), ['step-2', 'step-1']);
    assert.equal(E.read(m, 'stepEdit'), 'Stir for 5 minutes');
    return { stepIds: E.read(m, 'stepOrder'), editedStableId: 'step-1' };
  });

  run(E, 8, 'Delete versus edit retains tombstone and both intentions', () => {
    const seed = E.base();
    const a = E.write(E.fork(seed, 'iphone'), 'iphone', 'deleted', true);
    const b = E.write(E.fork(seed, 'macbook'), 'macbook', 'title', 'Edited while offline');
    const doc = E.merge(a, b);
    assert.equal(E.read(doc, 'deleted'), true);
    assert.equal(E.read(doc, 'title'), 'Edited while offline');
    const idx = index();
    const evidence = [
      observedMeta(E, doc, 'deleted', true, idx),
      observedMeta(E, doc, 'title', 'Edited while offline', idx)
    ];
    assert.ok(evidence.every((e) => e.changeId && e.authorId), 'must retain both authored intentions');
    if (E.ENGINE === 'loro') {
      const d = idx.writes('recipe:recipe-1', 'deleted').find((x) => x.value === true);
      const t = idx.writes('recipe:recipe-1', 'title').find((x) => x.value === 'Edited while offline');
      assert.equal(E.compare(doc, d, t), undefined);
    } else {
      assert.equal(E.heads(doc).length, 2);
    }
    const event = semanticEvent(E, 'semantic-delete-edit',
      { type: 'recipe', id: 'recipe-1' }, ['lifecycle'],
      evidence, ['recipe-1', 'deleted:true', 'edited:title'], ['keep-edited-recipe', 'keep-deleted'],
      'Do not physically remove the entity until review/retention is safe');
    sampleEvents.push(event);
    return { eventId: event.id, deletionPreserved: true, editPreserved: true,
      sourceChangeIds: evidence.map((x) => x.changeId) };
  });

  run(E, 9, 'Equivalent carrots with different IDs/preferences', () => {
    const seed = E.base();
    const a = E.write(E.fork(seed, 'iphone'), 'iphone', 'carrotsPhone');
    const b = E.write(E.fork(seed, 'macbook'), 'macbook', 'carrotsMac');
    const doc = E.merge(a, b), items = E.read(doc, 'pantry');
    assert.equal(items.length, 2);
    assert.deepEqual(new Set(items.map((x) => x.name.trim().toLowerCase())), new Set(['carrots']));
    assert.deepEqual(new Set(items.map((x) => x.preference)), new Set([2, 5]));
    const idx = index();
    const alternatives = [
      observedMeta(E, doc, 'carrotsPhone', 5, idx),
      observedMeta(E, doc, 'carrotsMac', 2, idx)
    ];
    assert.ok(alternatives.every((a) => a.changeId));
    const event = semanticEvent(E, 'semantic-duplicate-pantry',
      { type: 'pantry', id: 'carrots' }, ['normalized-name'],
      alternatives, items.map((x) => x.id), ['keep-both', 'choose-preferences', 'merge-with-confirmation'],
      'Name normalization is only a candidate; preference and identity may differ');
    sampleEvents.push(event);
    return { eventId: event.id, ids: items.map((x) => x.id), preferences: [2, 5],
      silentlyCollapsed: false };
  });

  run(E, 10, 'Structurally valid but suspicious recipe is application policy', () => {
    const seed = E.base();
    const a = E.write(E.fork(seed, 'iphone'), 'iphone', 'portions', 8);
    const b = E.write(E.fork(seed, 'macbook'), 'macbook', 'ingredientAmount', '1');
    const doc = E.merge(a, b);
    assert.equal(E.read(doc, 'portions'), 8);
    assert.equal(E.read(doc, 'ingredientAmount'), '1');
    assert.equal(E.scalar(doc, 'portions', index()).concurrent, false);
    const event = semanticEvent(E, 'semantic-suspicion',
      { type: 'recipe', id: 'recipe-1' }, ['nutrition-and-yield-heuristic'],
      [], ['recipe-1', 'rule:yield-versus-quantity-v1'],
      ['inspect-recipe', 'dismiss-for-now'],
      'Example heuristic: 8 portions with just 1 tomato; not a CRDT conflict or cooking verdict');
    sampleEvents.push(event);
    return { eventId: event.id, possibleAnomaly: true, crdtConflict: false,
      heuristicIsNotAuthoritative: true };
  });

  run(E, 11, 'Three replicas converge regardless of merge/delivery order', () => {
    const seed = E.base();
    const a = E.write(E.fork(seed, 'iphone'), 'iphone', 'portions', 4);
    const b = E.write(E.fork(seed, 'macbook'), 'macbook', 'portions', 6);
    const c = E.write(E.fork(seed, 'ipad'), 'ipad', 'ingredientAmount', '3');
    const left = E.merge(E.merge(a, b), c);
    const right = E.merge(E.merge(c, b), a);
    assert.equal(E.read(left, 'ingredientAmount'), '3');
    assert.equal(E.read(right, 'ingredientAmount'), '3');
    const x = conflictEvent(E, left, 'portions', index());
    const y = conflictEvent(E, right, 'portions', index());
    assert.equal(x.id, y.id);
    assert.deepEqual(idOf(x.alternatives.map((z) => z.value)), idOf([4, 6]));
    assert.deepEqual(idOf(y.alternatives.map((z) => z.value)), idOf([4, 6]));
    return { orderIndependentEventId: x.id, alternatives: [4, 6] };
  });

  run(E, 12, 'Duplicate/out-of-order, full restart and repeated extraction', () => {
    const seed = E.base();
    const t = E.transportProbe(seed);
    assert.equal(t.outOfOrderBuffered, true);
    assert.equal(t.duplicateIdempotent, true);
    assert.equal(t.restoredValue, 'first causal edit');
    const { doc } = conflictPair(E, 'portions', 4, 6);
    const idx = index();
    const event = conflictEvent(E, doc, 'portions', idx);
    const ledger = new ReviewLedger([event]);
    const bytes = E.save(doc);
    const fresh = E.load(bytes);
    let restoredIndex = index();
    let firstDecode = null, secondDecode = null;
    if (restoredIndex) {
      restoredIndex = new E.IncrementalIndex(idx.serialize());
      firstDecode = restoredIndex.update(fresh).decodedOps;
      secondDecode = restoredIndex.update(fresh).decodedOps;
      assert.equal(firstDecode, 0, 'incremental index reprocessing should decode no operations');
      assert.equal(secondDecode, 0);
    }
    const eventAgain = conflictEvent(E, fresh, 'portions', restoredIndex);
    assert.equal(event.id, eventAgain.id);
    ledger.upsert(eventAgain);
    ledger.dismiss(event.id);
    ledger.upsert(event);
    assert.equal(ledger.get(event.id).status, 'dismissed');
    assert.equal(ReviewLedger.fromJSON(ledger.toJSON()).get(event.id).status, 'dismissed');
    return { eventId: event.id, transport: t, eventCount: ledger.list().length,
      duplicateExtractionIsIdempotent: true, persistedDismissalLocalOnly: true,
      decodedOperationsOnRepeatedIndexUpdate: secondDecode };
  });
}

// Retention: explicit destructive-history probe plus tested durable materialization
// and a safe default to retain full engine history while review is unresolved.
for (const E of [Automerge, Loro]) {
  run(E, 'retention', 'Full snapshot and unresolved review checkpoint', () => {
    const { doc } = conflictPair(E, 'portions', 4, 6);
    const idx = E.ENGINE === 'loro' ? new E.IncrementalIndex() : undefined;
    const event = conflictEvent(E, doc, 'portions', idx);
    const ledger = new ReviewLedger([event]);
    const checkpointFile = path.join(OUT, E.ENGINE + '-review-checkpoint.json');
    const stored = writeCheckpoint(checkpointFile, {
      ledger, index: idx ? idx.serialize() : null, frontier: E.heads(doc)
    });
    const afterRestart = E.load(E.save(doc));
    assert.equal(conflictEvent(E, afterRestart, 'portions',
      idx ? new E.IncrementalIndex() : undefined).id, event.id);
    const durable = readCheckpoint(checkpointFile);
    assert.deepEqual(durable.frontier, E.heads(doc));
    assert.equal(durable.ledger.get(event.id).status, 'unresolved');
    assert.deepEqual(idOf(durable.ledger.get(event.id).alternatives.map((x) => x.value)), idOf([4, 6]));
    if (E.ENGINE === 'automerge') {
      // Ordinary Automerge save() is NOT destructive history pruning.
      assert.ok(E.scalar(afterRestart, 'portions').concurrent);
      return { policy: 'retain-regular-Automerge-save-and-unresolved-ledger',
        fullSnapshotRetainsConflict: true, destructivePruneAttempted: false,
        checkpointBytes: JSON.stringify(stored).length };
    }
    const advanced = E.write(E.fork(doc, 'ipad'), 'ipad', 'stepEdit', 'unrelated later edit');
    const shallow = E.load(advanced.export({ mode: 'shallow-snapshot', frontiers: advanced.frontiers() }));
    const now = E.scalar(shallow, 'portions', new E.IncrementalIndex());
    assert.equal(now.concurrent, false, 'shallow history trims reconstructable losing write evidence');
    const survived = readCheckpoint(checkpointFile);
    assert.equal(survived.ledger.get(event.id).status, 'unresolved',
      'lost native history is NEVER interpreted as user-approved resolution');
    assert.equal(E.causalResolution(shallow, event, 'portions', new E.IncrementalIndex()), null);
    // The chosen safe default is full-history retention while unresolved; checkpoint
    // demonstrates that if future compaction is demanded, evidence survives independently.
    return { policy: 'retain-full-history-until-review-then-checkpoint-before-shallow-prune',
      shallowErasesOperationEvidence: true, durableReviewSurvives: true,
      automaticClosureAfterHistoryLoss: false, checkpointBytes: JSON.stringify(stored).length };
  });
}

const summaries = Object.fromEntries([Automerge, Loro].map((E) => {
  const subset = results.filter((r) => r.engine === E.ENGINE);
  return [E.ENGINE, { pass: subset.filter((r) => r.status === 'PASS').length,
    fail: subset.filter((r) => r.status === 'FAIL').length }];
}));
const output = {
  schemaVersion: 1, engines: { automerge: Automerge.VERSION, loro: Loro.VERSION },
  scenarioCountPerEngine: 12, retainedHistoryTestPerEngine: 1,
  summaries, results,
  note: 'Synthetic test devices; engine-specific operation IDs are opaque; nothing is production state.'
};
writeFileSync(path.join(OUT, 'scenario-results.json'), JSON.stringify(output, null, 2) + '\n');
writeFileSync(path.join(OUT, 'merge-event-ledger.json'),
  JSON.stringify({ schemaVersion: 1, examples: sampleEvents }, null, 2) + '\n');
console.log(JSON.stringify(summaries));
if (Object.values(summaries).some((x) => x.fail)) process.exitCode = 1;
