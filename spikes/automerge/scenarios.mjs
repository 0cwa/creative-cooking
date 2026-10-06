import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as A from '@automerge/automerge';

const ACTORS = {
  seed: '00000000000000000000000000000000',
  iphone: '11111111111111111111111111111111',
  macbook: '22222222222222222222222222222222',
  ipad: '33333333333333333333333333333333'
};

const AUTHORS = {
  iphone: Buffer.from('iphone').toString('hex'),
  macbook: Buffer.from('macbook').toString('hex'),
  ipad: Buffer.from('ipad').toString('hex')
};

const DEVICE_TIMES = { iphone: 1700000100, macbook: 1700000200, ipad: 1700000300 };

function seedDoc() {
  let doc = A.init({ actor: ACTORS.seed });
  doc = A.change(doc, { message: 'seed common Creative Cooking fixture', time: 1700000000 }, (d) => {
    d.recipesById = {
      'recipe-1': {
        id: 'recipe-1',
        title: 'Tomato toast',
        description: 'A quick supper.',
        portions: 2,
        ingredientsById: {
          'ingredient-tomatoes': { id: 'ingredient-tomatoes', name: 'tomatoes', amount: '2' },
          'ingredient-bread': { id: 'ingredient-bread', name: 'bread', amount: '2 slices' }
        },
        ingredientOrder: ['ingredient-tomatoes', 'ingredient-bread'],
        methodStepsById: {
          'step-1': { id: 'step-1', text: 'Chop onions and cook gently.' },
          'step-2': { id: 'step-2', text: 'Toast the bread.' }
        },
        methodOrder: ['step-1', 'step-2'],
        lifecycle: { deleted: false, deletedAt: null, deletedBy: null }
      }
    };
    d.recipeOrder = ['recipe-1'];
    d.conversationsById = {
      'conversation-1': {
        id: 'conversation-1',
        messagesById: {
          'message-0': { id: 'message-0', role: 'user', content: 'What can I cook?' }
        },
        messageOrder: ['message-0']
      }
    };
    d.allergiesByValue = {};
    d.pantryById = {};
  });
  return doc;
}

function fork(doc, device) {
  return A.clone(doc, { actor: ACTORS[device] });
}

function authoredFork(doc, device) {
  return A.clone(doc, { author: AUTHORS[device] });
}

function change(doc, device, action, mutate) {
  return A.change(doc, {
    message: JSON.stringify({ device, action }),
    time: DEVICE_TIMES[device]
  }, mutate);
}

function mergeDocs(a, b) {
  return A.merge(A.clone(a), A.clone(b));
}

function logical(doc) {
  return JSON.parse(JSON.stringify(doc));
}

function conflictValues(obj, key) {
  const conflicts = A.getConflicts(obj, key);
  return conflicts ? Object.values(conflicts) : [];
}

function sorted(values) {
  return [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function assertLogicalEqual(a, b) {
  assert.deepEqual(logical(a), logical(b));
}

function decodeAuthor(author) {
  if (!author) return null;
  try {
    return Buffer.from(author, 'hex').toString('utf8');
  } catch {
    return author;
  }
}

function changeMetadataSince(doc, heads) {
  return A.getChangesMetaSince(doc, heads).map((meta) => {
    const decoded = A.inspectChange(doc, meta.hash);
    const author = decoded?.author ?? A.getAuthorForActor(doc, meta.actor) ?? null;
    return {
      hash: meta.hash,
      actor: meta.actor,
      author,
      device: decodeAuthor(author),
      deps: [...meta.deps],
      seq: meta.seq,
      message: meta.message,
      time: meta.time
    };
  });
}

function mergeEventForScalar(doc, object, key, path, baseHeads) {
  const conflicts = A.getConflicts(object, key) ?? {};
  const alternatives = Object.entries(conflicts).map(([opId, value]) => {
    const actor = opId.split('@')[1] ?? null;
    const author = actor ? A.getAuthorForActor(doc, actor) : null;
    return { opId, actor, author, device: decodeAuthor(author), value };
  });
  return {
    kind: alternatives.length > 1 ? 'disagreement' : 'clean',
    path,
    alternatives,
    heads: A.getHeads(doc),
    changes: changeMetadataSince(doc, baseHeads)
  };
}

function syncPair(inputA, inputB, maxRounds = 50) {
  let docA = inputA;
  let docB = inputB;
  let stateA = A.initSyncState();
  let stateB = A.initSyncState();
  let messages = 0;
  let rounds = 0;
  for (; rounds < maxRounds; rounds += 1) {
    let messageA;
    [stateA, messageA] = A.generateSyncMessage(docA, stateA);
    stateA = A.decodeSyncState(A.encodeSyncState(stateA));
    if (messageA) {
      [docB, stateB] = A.receiveSyncMessage(docB, stateB, messageA);
      stateB = A.decodeSyncState(A.encodeSyncState(stateB));
      messages += 1;
    }

    let messageB;
    [stateB, messageB] = A.generateSyncMessage(docB, stateB);
    stateB = A.decodeSyncState(A.encodeSyncState(stateB));
    if (messageB) {
      [docA, stateA] = A.receiveSyncMessage(docA, stateA, messageB);
      stateA = A.decodeSyncState(A.encodeSyncState(stateA));
      messages += 1;
    }

    if (!messageA && !messageB) break;
  }
  assert.ok(rounds < maxRounds, 'sync protocol did not quiesce');
  return { docA, docB, messages, rounds: rounds + 1 };
}

const results = [];
const mergeEvents = [];

async function run(number, name, fn) {
  const started = performance.now();
  try {
    const detail = await fn();
    const status = detail?.status ?? 'PASS';
    results.push({ number, name, status, durationMs: +(performance.now() - started).toFixed(3), ...detail });
    console.log('TEST ' + number + ' ' + status + ' — ' + name);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    results.push({ number, name, status: 'FAIL', durationMs: +(performance.now() - started).toFixed(3), error: message });
    console.error('TEST ' + number + ' FAIL — ' + name + '\n' + message);
  }
}

await run(1, 'different recipe fields', () => {
  const base = seedDoc();
  const baseHeads = A.getHeads(base);
  const iphone = change(fork(base, 'iphone'), 'iphone', 'edit title', (d) => {
    d.recipesById['recipe-1'].title = 'Tomato toast with basil';
  });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'edit portions', (d) => {
    d.recipesById['recipe-1'].portions = 4;
  });
  const merged = mergeDocs(iphone, macbook);
  assert.equal(merged.recipesById['recipe-1'].title, 'Tomato toast with basil');
  assert.equal(merged.recipesById['recipe-1'].portions, 4);
  assert.ok(conflictValues(merged.recipesById['recipe-1'], 'title').length < 2);
  assert.ok(conflictValues(merged.recipesById['recipe-1'], 'portions').length < 2);
  mergeEvents.push({
    kind: 'clean-concurrent-merge',
    paths: ['recipesById.recipe-1.title', 'recipesById.recipe-1.portions'],
    patches: A.diff(merged, baseHeads, A.getHeads(merged)),
    changes: changeMetadataSince(merged, baseHeads)
  });
  return { rendered: { title: merged.recipesById['recipe-1'].title, portions: merged.recipesById['recipe-1'].portions } };
});

await run(2, 'same nested entity, different properties', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'edit tomato amount', (d) => {
    d.recipesById['recipe-1'].ingredientsById['ingredient-tomatoes'].amount = '3';
  });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'qualify tomato name', (d) => {
    d.recipesById['recipe-1'].ingredientsById['ingredient-tomatoes'].name = 'tomatoes (ripe)';
  });
  const merged = mergeDocs(iphone, macbook);
  const ingredient = merged.recipesById['recipe-1'].ingredientsById['ingredient-tomatoes'];
  assert.equal(ingredient.amount, '3');
  assert.equal(ingredient.name, 'tomatoes (ripe)');
  return { rendered: logical(ingredient) };
});

await run(3, 'concurrent additions', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'add basil', (d) => {
    d.recipesById['recipe-1'].ingredientsById['ingredient-basil'] = { id: 'ingredient-basil', name: 'basil', amount: '1 handful' };
    d.recipesById['recipe-1'].ingredientOrder.push('ingredient-basil');
  });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'add garlic', (d) => {
    d.recipesById['recipe-1'].ingredientsById['ingredient-garlic'] = { id: 'ingredient-garlic', name: 'garlic', amount: '1 clove' };
    d.recipesById['recipe-1'].ingredientOrder.push('ingredient-garlic');
  });
  const ab = mergeDocs(iphone, macbook);
  const ba = mergeDocs(macbook, iphone);
  assert.ok(ab.recipesById['recipe-1'].ingredientsById['ingredient-basil']);
  assert.ok(ab.recipesById['recipe-1'].ingredientsById['ingredient-garlic']);
  assert.deepEqual([...ab.recipesById['recipe-1'].ingredientOrder], [...ba.recipesById['recipe-1'].ingredientOrder]);
  return { deterministicOrder: [...ab.recipesById['recipe-1'].ingredientOrder] };
});

await run(4, 'concurrent text editing', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'insert finely', (d) => {
    A.updateText(d, ['recipesById', 'recipe-1', 'methodStepsById', 'step-1', 'text'], 'Chop onions finely and cook gently.');
  });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'append until golden', (d) => {
    A.updateText(d, ['recipesById', 'recipe-1', 'methodStepsById', 'step-1', 'text'], 'Chop onions and cook gently until golden.');
  });
  const merged = mergeDocs(iphone, macbook);
  const text = merged.recipesById['recipe-1'].methodStepsById['step-1'].text;
  assert.ok(text.includes('finely'), 'phone insertion should survive');
  assert.ok(text.includes('until golden'), 'macbook append should survive');
  return { exactMergedText: text };
});

await run(5, 'chat appends', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'append chat', (d) => {
    d.conversationsById['conversation-1'].messagesById['message-iphone'] = { id: 'message-iphone', role: 'user', content: 'Use the tomatoes.' };
    d.conversationsById['conversation-1'].messageOrder.push('message-iphone');
  });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'append chat', (d) => {
    d.conversationsById['conversation-1'].messagesById['message-macbook'] = { id: 'message-macbook', role: 'assistant', content: 'Try tomato toast.' };
    d.conversationsById['conversation-1'].messageOrder.push('message-macbook');
  });
  const merged = mergeDocs(iphone, macbook);
  assert.ok(merged.conversationsById['conversation-1'].messagesById['message-iphone']);
  assert.ok(merged.conversationsById['conversation-1'].messagesById['message-macbook']);
  return { messageOrder: [...merged.conversationsById['conversation-1'].messageOrder] };
});

await run(6, 'set-like additions', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'add peanut allergy', (d) => {
    d.allergiesByValue.peanuts = true;
  });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'add sesame allergy', (d) => {
    d.allergiesByValue.sesame = true;
  });
  const merged = mergeDocs(iphone, macbook);
  assert.equal(merged.allergiesByValue.peanuts, true);
  assert.equal(merged.allergiesByValue.sesame, true);
  return { setValues: Object.keys(merged.allergiesByValue).sort() };
});

await run(7, 'same scalar disagreement', () => {
  const base = seedDoc();
  const baseHeads = A.getHeads(base);
  const iphone = change(authoredFork(base, 'iphone'), 'iphone', 'set portions to four', (d) => {
    d.recipesById['recipe-1'].portions = 4;
  });
  const macbook = change(authoredFork(base, 'macbook'), 'macbook', 'set portions to six', (d) => {
    d.recipesById['recipe-1'].portions = 6;
  });
  const merged = mergeDocs(iphone, macbook);
  const values = sorted(conflictValues(merged.recipesById['recipe-1'], 'portions'));
  assert.deepEqual(values, [4, 6]);

  const event = mergeEventForScalar(
    merged,
    merged.recipesById['recipe-1'],
    'portions',
    'recipesById.recipe-1.portions',
    baseHeads
  );
  assert.deepEqual(event.alternatives.map((x) => x.device).sort(), ['iphone', 'macbook']);
  assert.equal(event.changes.length, 2);
  assert.ok(event.changes.every((c) => c.deps.length >= 1));
  const hashes = new Set(event.changes.map((c) => c.hash));
  assert.ok(event.changes.every((c) => c.deps.every((dep) => !hashes.has(dep))), 'concurrent changes must not depend on each other');

  const beforeResolutionHeads = A.getHeads(merged);
  const resolved = change(authoredFork(merged, 'ipad'), 'ipad', 'resolve portions disagreement', (d) => {
    d.recipesById['recipe-1'].portions = 5;
  });
  assert.equal(A.getConflicts(resolved.recipesById['recipe-1'], 'portions'), undefined);
  const resolution = changeMetadataSince(resolved, beforeResolutionHeads);
  assert.equal(resolution.length, 1);
  assert.ok(beforeResolutionHeads.every((head) => resolution[0].deps.includes(head)), 'resolution should depend on both conflicting heads');

  event.resolution = {
    value: resolved.recipesById['recipe-1'].portions,
    change: resolution[0],
    conflictsAfterResolution: A.getConflicts(resolved.recipesById['recipe-1'], 'portions') ?? null
  };
  mergeEvents.push(event);
  return { alternatives: event.alternatives, deterministicRenderedValue: merged.recipesById['recipe-1'].portions, resolution: event.resolution };
});

await run(8, 'same atomic title', () => {
  const base = seedDoc();
  const baseHeads = A.getHeads(base);
  const iphone = change(authoredFork(base, 'iphone'), 'iphone', 'rename recipe', (d) => {
    d.recipesById['recipe-1'].title = 'Basil tomato toast';
  });
  const macbook = change(authoredFork(base, 'macbook'), 'macbook', 'rename recipe', (d) => {
    d.recipesById['recipe-1'].title = 'Garlicky tomato toast';
  });
  const merged = mergeDocs(iphone, macbook);
  const event = mergeEventForScalar(merged, merged.recipesById['recipe-1'], 'title', 'recipesById.recipe-1.title', baseHeads);
  assert.deepEqual(sorted(event.alternatives.map((x) => x.value)), ['Basil tomato toast', 'Garlicky tomato toast']);
  assert.deepEqual(event.alternatives.map((x) => x.device).sort(), ['iphone', 'macbook']);
  mergeEvents.push(event);
  return { reviewItem: event };
});

await run(9, 'delete versus edit', () => {
  const base = seedDoc();

  const physicalDelete = change(fork(base, 'iphone'), 'iphone', 'physically delete recipe', (d) => {
    delete d.recipesById['recipe-1'];
  });
  const physicalEdit = change(fork(base, 'macbook'), 'macbook', 'edit deleted recipe title', (d) => {
    d.recipesById['recipe-1'].title = 'Edited while offline';
  });
  const physicalMerged = mergeDocs(physicalDelete, physicalEdit);

  const tombstoneDelete = change(fork(base, 'iphone'), 'iphone', 'tombstone recipe', (d) => {
    const recipe = d.recipesById['recipe-1'];
    recipe.lifecycle.deleted = true;
    recipe.lifecycle.deletedAt = '2026-10-03T12:00:00Z';
    recipe.lifecycle.deletedBy = 'iphone';
  });
  const tombstoneEdit = change(fork(base, 'macbook'), 'macbook', 'edit recipe during concurrent delete', (d) => {
    d.recipesById['recipe-1'].title = 'Edited while offline';
  });
  const merged = mergeDocs(tombstoneDelete, tombstoneEdit);
  assert.equal(merged.recipesById['recipe-1'].lifecycle.deleted, true);
  assert.equal(merged.recipesById['recipe-1'].title, 'Edited while offline');
  assert.equal(A.getHeads(merged).length, 2);
  const reviewItem = {
    kind: 'semantic-review',
    reason: 'delete-vs-edit',
    recipeId: 'recipe-1',
    deletedBy: merged.recipesById['recipe-1'].lifecycle.deletedBy,
    editedTitle: merged.recipesById['recipe-1'].title,
    actions: ['keep-edited-recipe', 'keep-deleted']
  };
  mergeEvents.push(reviewItem);
  return {
    physicalDeleteRenderedRecipePresent: Boolean(physicalMerged.recipesById['recipe-1']),
    recommendedRepresentation: 'tombstone lifecycle on stable-ID entity; do not physically delete until review/retention policy allows it',
    reviewItem
  };
});

await run(10, 'duplicate pantry item', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'add carrots', (d) => {
    d.pantryById['pantry-carrots-iphone'] = { id: 'pantry-carrots-iphone', name: 'carrots', normalizedName: 'carrots', preference: 5 };
  });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'add carrots', (d) => {
    d.pantryById['pantry-carrots-macbook'] = { id: 'pantry-carrots-macbook', name: 'Carrots', normalizedName: 'carrots', preference: 2 };
  });
  const merged = mergeDocs(iphone, macbook);
  const duplicates = Object.values(merged.pantryById).filter((item) => item.normalizedName === 'carrots');
  assert.equal(duplicates.length, 2);
  assert.deepEqual(sorted(duplicates.map((item) => item.preference)), [2, 5]);
  const reviewItem = {
    kind: 'semantic-review',
    reason: 'logical-duplicate-pantry-item',
    normalizedName: 'carrots',
    ids: duplicates.map((item) => item.id).sort(),
    differingPreferences: duplicates.map((item) => ({ id: item.id, preference: item.preference }))
  };
  mergeEvents.push(reviewItem);
  return { structuralResultCount: duplicates.length, reviewItem };
});

await run(11, 'reorder plus edit', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'reorder method steps', (d) => {
    const order = d.recipesById['recipe-1'].methodOrder;
    const moved = order.splice(1, 1)[0];
    order.splice(0, 0, moved);
  });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'edit stable step', (d) => {
    d.recipesById['recipe-1'].methodStepsById['step-2'].text = 'Toast the bread until deeply golden.';
  });
  const merged = mergeDocs(iphone, macbook);
  assert.equal(merged.recipesById['recipe-1'].methodOrder[0], 'step-2');
  assert.equal(merged.recipesById['recipe-1'].methodStepsById['step-2'].text, 'Toast the bread until deeply golden.');
  return {
    order: [...merged.recipesById['recipe-1'].methodOrder],
    editedStep: merged.recipesById['recipe-1'].methodStepsById['step-2'].text
  };
});

await run(12, 'restart', () => {
  const base = seedDoc();
  const changed = change(fork(base, 'iphone'), 'iphone', 'edit before restart', (d) => {
    d.recipesById['recipe-1'].description = 'Edited before restart.';
  });
  const bytes = A.save(changed);
  let restarted = A.load(bytes, { actor: ACTORS.ipad });
  restarted = change(restarted, 'ipad', 'edit after restart', (d) => {
    d.recipesById['recipe-1'].title = 'Restart-safe toast';
  });
  assert.equal(restarted.recipesById['recipe-1'].description, 'Edited before restart.');
  assert.equal(restarted.recipesById['recipe-1'].title, 'Restart-safe toast');
  return { savedBytes: bytes.byteLength, headsAfterRestart: A.getHeads(restarted) };
});

await run(13, 'out-of-order delivery', () => {
  const base = seedDoc();
  let iphone = fork(base, 'iphone');
  iphone = change(iphone, 'iphone', 'first causal edit', (d) => {
    d.recipesById['recipe-1'].description = 'First causal edit.';
  });
  iphone = change(iphone, 'iphone', 'second causal edit', (d) => {
    d.recipesById['recipe-1'].title = 'Second causal edit';
  });
  const changes = A.getChanges(base, iphone);
  assert.equal(changes.length, 2);
  let receiver = A.clone(base, { actor: ACTORS.ipad });
  [receiver] = A.applyChanges(receiver, [changes[1]]);
  const missingAfterLate = A.getMissingDeps(receiver);
  assert.ok(missingAfterLate.length >= 1, 'later change should wait for missing dependency');
  [receiver] = A.applyChanges(receiver, [changes[0]]);
  assert.equal(receiver.recipesById['recipe-1'].description, 'First causal edit.');
  assert.equal(receiver.recipesById['recipe-1'].title, 'Second causal edit');
  return {
    transport: 'raw encoded Automerge changes',
    missingDependenciesBuffered: missingAfterLate,
    note: 'Automerge SyncState itself documents a reliable in-order transport requirement; reconnects should reset/recreate sync state.'
  };
});

await run(14, 'duplicate delivery', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'single edit', (d) => {
    d.recipesById['recipe-1'].title = 'Idempotent toast';
  });
  const encoded = A.getLastLocalChange(iphone);
  assert.ok(encoded);
  let receiver = A.clone(base, { actor: ACTORS.ipad });
  [receiver] = A.applyChanges(receiver, [encoded]);
  const once = logical(receiver);
  [receiver] = A.applyChanges(receiver, [encoded]);
  assert.deepEqual(logical(receiver), once);

  let senderState = A.initSyncState();
  let receiverState = A.initSyncState();
  let message;
  [senderState, message] = A.generateSyncMessage(iphone, senderState);
  assert.ok(message);
  let syncReceiver = A.clone(base, { actor: ACTORS.macbook });
  [syncReceiver, receiverState] = A.receiveSyncMessage(syncReceiver, receiverState, message);
  const afterOnce = logical(syncReceiver);
  [syncReceiver, receiverState] = A.receiveSyncMessage(syncReceiver, receiverState, message);
  assert.deepEqual(logical(syncReceiver), afterOnce);
  return { rawChangeIdempotent: true, duplicateSyncMessageIdempotentInSession: true };
});

await run(15, 'long offline divergence', () => {
  const base = seedDoc();
  let iphone = authoredFork(base, 'iphone');
  iphone = change(iphone, 'iphone', 'offline title', (d) => { d.recipesById['recipe-1'].title = 'Phone toast'; });
  iphone = change(iphone, 'iphone', 'offline ingredient', (d) => {
    d.recipesById['recipe-1'].ingredientsById['ingredient-basil'] = { id: 'ingredient-basil', name: 'basil', amount: '1 handful' };
  });
  iphone = change(iphone, 'iphone', 'offline portions', (d) => { d.recipesById['recipe-1'].portions = 4; });

  let macbook = authoredFork(base, 'macbook');
  macbook = change(macbook, 'macbook', 'offline description', (d) => { d.recipesById['recipe-1'].description = 'Laptop description'; });
  macbook = change(macbook, 'macbook', 'offline ingredient', (d) => {
    d.recipesById['recipe-1'].ingredientsById['ingredient-garlic'] = { id: 'ingredient-garlic', name: 'garlic', amount: '1 clove' };
  });
  macbook = change(macbook, 'macbook', 'offline portions', (d) => { d.recipesById['recipe-1'].portions = 6; });

  const ab = mergeDocs(iphone, macbook);
  const ba = mergeDocs(macbook, iphone);
  assertLogicalEqual(ab, ba);
  assert.ok(ab.recipesById['recipe-1'].ingredientsById['ingredient-basil']);
  assert.ok(ab.recipesById['recipe-1'].ingredientsById['ingredient-garlic']);
  assert.deepEqual(sorted(conflictValues(ab.recipesById['recipe-1'], 'portions')), [4, 6]);
  return { heads: A.getHeads(ab), disagreementValues: sorted(conflictValues(ab.recipesById['recipe-1'], 'portions')) };
});

await run(16, 'merge direction', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'title A', (d) => { d.recipesById['recipe-1'].title = 'A title'; });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'title B', (d) => { d.recipesById['recipe-1'].title = 'B title'; });
  const ab = mergeDocs(iphone, macbook);
  const ba = mergeDocs(macbook, iphone);
  assertLogicalEqual(ab, ba);
  assert.deepEqual(
    sorted(conflictValues(ab.recipesById['recipe-1'], 'title')),
    sorted(conflictValues(ba.recipesById['recipe-1'], 'title'))
  );
  return { logicalEquivalent: true, values: sorted(conflictValues(ab.recipesById['recipe-1'], 'title')) };
});

await run(17, 'sync protocol', () => {
  const base = seedDoc();
  const iphone = change(fork(base, 'iphone'), 'iphone', 'sync title', (d) => { d.recipesById['recipe-1'].title = 'Synced phone title'; });
  const macbook = change(fork(base, 'macbook'), 'macbook', 'sync description', (d) => { d.recipesById['recipe-1'].description = 'Synced laptop description'; });
  const synced = syncPair(iphone, macbook);
  assertLogicalEqual(synced.docA, synced.docB);
  assert.equal(synced.docA.recipesById['recipe-1'].title, 'Synced phone title');
  assert.equal(synced.docA.recipesById['recipe-1'].description, 'Synced laptop description');
  return { actualSyncApi: true, persistedSyncStateRoundTrips: true, messages: synced.messages, rounds: synced.rounds };
});

await run(18, 'three replicas', () => {
  const base = seedDoc();
  let iphone = change(fork(base, 'iphone'), 'iphone', 'three-way title', (d) => { d.recipesById['recipe-1'].title = 'Three-way toast'; });
  let macbook = change(fork(base, 'macbook'), 'macbook', 'three-way description', (d) => { d.recipesById['recipe-1'].description = 'Three replicas'; });
  let ipad = change(fork(base, 'ipad'), 'ipad', 'three-way allergy', (d) => { d.allergiesByValue.sesame = true; });

  ({ docA: iphone, docB: macbook } = syncPair(iphone, macbook));
  ({ docA: macbook, docB: ipad } = syncPair(macbook, ipad));
  ({ docA: ipad, docB: iphone } = syncPair(ipad, iphone));
  ({ docA: iphone, docB: macbook } = syncPair(iphone, macbook));
  assertLogicalEqual(iphone, macbook);
  assertLogicalEqual(macbook, ipad);
  return { converged: true, heads: A.getHeads(iphone) };
});

mkdirSync('artifacts', { recursive: true });
const output = {
  engine: '@automerge/automerge',
  version: '3.5.0',
  generatedAt: new Date().toISOString(),
  deviceIdentities: { authors: AUTHORS, deterministicActorsForNonAuthorTests: ACTORS },
  summary: {
    pass: results.filter((x) => x.status === 'PASS').length,
    partial: results.filter((x) => x.status === 'PARTIAL').length,
    fail: results.filter((x) => x.status === 'FAIL').length
  },
  results,
  candidateMergeEvents: mergeEvents,
  ledgerNotes: {
    causalOrder: 'Change metadata exposes dependency hashes; concurrent changes do not depend on each other.',
    sourceIdentity: 'Automerge 3.5 author metadata maps stable opaque author IDs to rotating actor IDs; change messages also carry device/action context in this harness.',
    cleanMergeEvidence: 'diff(baseHeads, mergedHeads) plus change metadata records what arrived without surfacing an interruption.',
    disagreementEvidence: 'getConflicts preserves all concurrent scalar alternatives keyed by operation ID until a later assignment causally supersedes them.',
    compaction: 'save() compacts binary representation but keeps change history. No application-level policy for pruning old history while retaining unresolved review evidence is proven here.'
  }
};
writeFileSync('artifacts/scenario-results.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output.summary));

if (output.summary.fail > 0) process.exitCode = 1;
