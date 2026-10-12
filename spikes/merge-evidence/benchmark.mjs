import * as A from '@automerge/automerge';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import * as Automerge from './automerge.mjs';
import * as Loro from './loro.mjs';
import { makeEvent, ReviewLedger } from './ledger.mjs';

mkdirSync('artifacts', { recursive: true });
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function timed(fn) { const started = performance.now(); const value = fn(); return { ms: performance.now() - started, value }; }
const fixture = { pantry: 200, additionalRecipes: 500, ingredientsPerRecipe: 5,
  stepsPerRecipe: 4, conversations: 100, messagesPerConversation: 20, retainedEditChanges: 800 };
const results = [];
function fillAutomerge() {
  let d = Automerge.base();
  d = A.change(d, { message: 'bench bulk fixture', time: 1700000000 }, (draft) => {
    for (let i = 0; i < fixture.pantry; i++) {
      draft.pantry['pantry-' + i] = { id: 'pantry-' + i, name: 'ingredient ' + i,
        preference: i % 5 + 1 };
    }
    for (let i = 0; i < fixture.additionalRecipes; i++) {
      const ingredients = {}, steps = {}, order = [];
      for (let j = 0; j < fixture.ingredientsPerRecipe; j++) {
        const id = 'ingredient-' + i + '-' + j;
        ingredients[id] = { id, name: 'ingredient ' + j, amount: (j + 1) + ' tbsp' };
      }
      for (let j = 0; j < fixture.stepsPerRecipe; j++) {
        const id = 'step-' + i + '-' + j;
        steps[id] = { id, text: 'Cook ' + j + ' until fragrant.' };
        order.push(id);
      }
      draft.recipes['bench-recipe-' + i] = { id: 'bench-recipe-' + i,
        title: 'Recipe ' + i, description: 'Weeknight recipe', portions: 2,
        ingredients, steps, stepOrder: order };
    }
    for (let i = 0; i < fixture.conversations; i++) {
      const messages = [];
      for (let j = 0; j < fixture.messagesPerConversation; j++) {
        messages.push({ id: 'msg-' + i + '-' + j, content: 'Cooking chat note ' + j });
      }
      draft.conversations['chat-' + i] = { id: 'chat-' + i, messages };
    }
  });
  for (let n = 0; n < fixture.retainedEditChanges; n++) {
    const i = n % fixture.additionalRecipes;
    d = A.change(d, { message: 'bench history edit ' + n, time: 1700000001 + n },
      (draft) => { draft.recipes['bench-recipe-' + i].description = 'Edit ' + n; });
  }
  return d;
}
function fillLoro() {
  const d = Loro.base();
  for (let i = 0; i < fixture.pantry; i++) {
    const map = d.getMap('bench:pantry:' + i);
    map.set('id', 'pantry-' + i);
    map.set('name', 'ingredient ' + i);
    map.set('preference', i % 5 + 1);
  }
  for (let i = 0; i < fixture.additionalRecipes; i++) {
    const recipe = d.getMap('bench:recipe:' + i);
    recipe.set('id', 'bench-recipe-' + i);
    recipe.set('title', 'Recipe ' + i);
    recipe.set('description', 'Weeknight recipe');
    recipe.set('portions', 2);
    const order = d.getMovableList('bench:recipe:' + i + ':steps');
    for (let j = 0; j < fixture.ingredientsPerRecipe; j++) {
      const ing = d.getMap('bench:ingredient:' + i + ':' + j);
      ing.set('id', 'ingredient-' + i + '-' + j);
      ing.set('name', 'ingredient ' + j);
      ing.set('amount', (j + 1) + ' tbsp');
    }
    for (let j = 0; j < fixture.stepsPerRecipe; j++) {
      const id = 'step-' + i + '-' + j;
      order.push(id);
      d.getText('bench:step:' + i + ':' + j).insert(0, 'Cook ' + j + ' until fragrant.');
    }
  }
  for (let i = 0; i < fixture.conversations; i++) {
    const messages = d.getList('bench:chat:' + i);
    for (let j = 0; j < fixture.messagesPerConversation; j++) {
      messages.push({ id: 'msg-' + i + '-' + j, content: 'Cooking chat note ' + j });
    }
  }
  d.commit({ message: 'bench bulk fixture' });
  for (let n = 0; n < fixture.retainedEditChanges; n++) {
    const i = n % fixture.additionalRecipes;
    d.getMap('bench:recipe:' + i).set('description', 'Edit ' + n);
    d.commit({ message: 'bench history edit ' + n });
  }
  return d;
}
for (const E of [Automerge, Loro]) {
  const built = timed(() => E.ENGINE === 'automerge' ? fillAutomerge() : fillLoro());
  const d = built.value;
  const saved = timed(() => E.save(d));
  const phone = E.write(E.fork(d, 'iphone'), 'iphone', 'portions', 4);
  const mac = E.write(E.fork(d, 'macbook'), 'macbook', 'portions', 6);
  const merged = E.merge(phone, mac);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const cold = timed(() => {
      const loaded = E.load(E.save(merged));
      return E.scalar(loaded, 'portions',
        E.ENGINE === 'loro' ? new E.IncrementalIndex() : undefined);
    });
    if (!cold.value.concurrent) throw new Error('Lost conflict in cold benchmark');
    samples.push(cold.ms);
  }
  let index = E.ENGINE === 'loro' ? new E.IncrementalIndex() : null;
  const indexed = index ? timed(() => index.update(merged)) : null;
  const warmSamples = [];
  for (let i = 0; i < 20; i++) {
    const t = timed(() => E.scalar(merged, 'portions', index ?? undefined));
    if (!t.value.concurrent) throw new Error('Lost conflict in warm benchmark');
    warmSamples.push(t.ms);
  }
  let reviewOnly = null;
  if (E.ENGINE === 'loro') {
    const narrowIndex = new E.IncrementalIndex(null, 'review-only');
    const builtNarrow = timed(() => narrowIndex.update(merged));
    const narrowSamples = [];
    for (let i = 0; i < 20; i++) {
      const query = timed(() => E.scalar(merged, 'portions', narrowIndex));
      if (!query.value.concurrent) throw new Error('Review-only index lost scalar disagreement');
      narrowSamples.push(query.ms);
    }
    reviewOnly = {
      indexBuildMs: +builtNarrow.ms.toFixed(3),
      bytes: Buffer.byteLength(JSON.stringify(narrowIndex.serialize())),
      indexedWrites: narrowIndex.items.length,
      warmQueryMedianMs: +median(narrowSamples).toFixed(3)
    };
  }
  const scalar = E.scalar(merged, 'portions', index ?? undefined);
  const event = makeEvent({ engine: E.ENGINE, kind: 'scalar-disagreement',
    entity: { type: 'recipe', id: 'recipe-1' }, path: ['portions'],
    alternatives: scalar.alternatives, frontier: scalar.frontier,
    concurrency: 'concurrent', completeness: scalar.completeness,
    missingCapabilities: scalar.missingCapabilities,
    actions: ['choose-value', 'edit-new-value'], reason: 'benchmark review' });
  const eventBytes = Buffer.byteLength(JSON.stringify(new ReviewLedger([event]).toJSON()));
  let incremental = null;
  let indexBytes = null;
  if (index) {
    indexBytes = Buffer.byteLength(JSON.stringify(index.serialize()));
    const next = E.write(E.fork(merged, 'ipad'), 'ipad', 'stepEdit', 'unrelated update');
    const beforeDecoded = index.opsDecoded;
    const measured = timed(() => index.update(next));
    incremental = { updateMs: +measured.ms.toFixed(3), newlyDecodedOps: index.opsDecoded - beforeDecoded,
      metadataHeadersVisited: index.changeHeadersVisited, indexedWrites: index.items.length };
  }
  const nativeConflictOnly = E.ENGINE === 'automerge' ? timed(() => {
    for (let i = 0; i < 100; i++) A.getConflicts(merged.recipes['recipe-1'], 'portions');
  }).ms / 100 : null;
  const loc = (name) => readFileSync(name, 'utf8').split('\n').length;
  results.push({
    engine: E.ENGINE, version: E.VERSION, fixture, platform: { node: process.version,
      os: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model ?? null,
      githubActions: process.env.GITHUB_ACTIONS === 'true' },
    fixtureBuildMs: +built.ms.toFixed(3),
    fullSnapshotBytes: saved.value.byteLength,
    fullSnapshotSaveMs: +saved.ms.toFixed(3),
    coldLoadAndExtractionMedianMs: +median(samples).toFixed(3),
    coldSamplesMs: samples.map((n) => +n.toFixed(3)),
    warmEventQueryMedianMs: +median(warmSamples).toFixed(3),
    warmSamplesMs: warmSamples.map((n) => +n.toFixed(3)),
    firstClassConflictReadOnlyAverageMs: nativeConflictOnly == null ? null : +nativeConflictOnly.toFixed(4),
    incrementalIndexBuildMs: indexed ? +indexed.ms.toFixed(3) : null,
    incrementalIndexInitialOpsDecoded: index?.opsDecoded ?? null,
    incrementalIndexBytes: indexBytes,
    reviewOnlyIndex: reviewOnly,
    incrementalUpdate: incremental,
    serializedReviewLedgerBytes: eventBytes,
    adapterSourceLines: loc(E.ENGINE === 'loro' ? 'loro.mjs' : 'automerge.mjs'),
    notes: ['Node/V8 on hosted runner is directional, not native Expo timing',
      'Retained 800 causally ordered real changes, plus conflicting forks',
      'Fixture logical counts match; native container layouts differ, not byte-for-byte parity',
      'Ledger bytes are additional local storage; not automatically replicated',
      'Warm queries use frontier-cached Loro index, not a full operation-history scan',
      'Loro activity index retains all observed map writes; review-only index is filtered for recipe, pantry, ingredient review fields',
      'Automerge first-class getConflicts read excludes separately measured provenance/history scans']
  });
  console.log(E.ENGINE + ' median cold=' + median(samples).toFixed(2) +
    'ms warm=' + median(warmSamples).toFixed(2) + 'ms');
}
writeFileSync('artifacts/benchmark-results.json',
  JSON.stringify({ schemaVersion: 1, results }, null, 2) + '\n');
