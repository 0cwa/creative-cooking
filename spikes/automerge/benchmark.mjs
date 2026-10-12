import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import * as A from '@automerge/automerge';

const ACTOR = {
  seed: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  iphone: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  macbook: 'cccccccccccccccccccccccccccccccc'
};

function fixture() {
  let doc = A.init({ actor: ACTOR.seed });
  doc = A.change(doc, { message: 'seed representative performance fixture', time: 1700000000 }, (d) => {
    d.pantryById = {};
    for (let i = 0; i < 200; i += 1) {
      const id = 'pantry-' + String(i).padStart(4, '0');
      d.pantryById[id] = {
        id,
        name: 'ingredient ' + i,
        preference: (i % 5) + 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      };
    }

    d.recipesById = {};
    d.recipeOrder = [];
    for (let i = 0; i < 500; i += 1) {
      const id = 'recipe-' + String(i).padStart(4, '0');
      const ingredientsById = {};
      const ingredientOrder = [];
      for (let j = 0; j < 5; j += 1) {
        const ingredientId = id + '-ingredient-' + j;
        ingredientsById[ingredientId] = {
          id: ingredientId,
          name: 'ingredient ' + ((i * 5 + j) % 200),
          amount: (j + 1) + ' tbsp'
        };
        ingredientOrder.push(ingredientId);
      }
      const methodStepsById = {};
      const methodOrder = [];
      for (let j = 0; j < 4; j += 1) {
        const stepId = id + '-step-' + j;
        methodStepsById[stepId] = { id: stepId, text: 'Cook step ' + j + ' for recipe ' + i + '.' };
        methodOrder.push(stepId);
      }
      d.recipesById[id] = {
        id,
        title: 'Recipe ' + i,
        description: 'Representative local-first recipe ' + i + '.',
        portions: 2 + (i % 5),
        ingredientsById,
        ingredientOrder,
        methodStepsById,
        methodOrder,
        lifecycle: { deleted: false, deletedAt: null, deletedBy: null }
      };
      d.recipeOrder.push(id);
    }

    d.conversationsById = {};
    d.conversationOrder = [];
    for (let i = 0; i < 100; i += 1) {
      const id = 'conversation-' + String(i).padStart(3, '0');
      const messagesById = {};
      const messageOrder = [];
      for (let j = 0; j < 20; j += 1) {
        const messageId = id + '-message-' + String(j).padStart(2, '0');
        messagesById[messageId] = {
          id: messageId,
          role: j % 2 === 0 ? 'user' : 'assistant',
          content: 'Representative message ' + j + ' in conversation ' + i + ' about dinner ideas.'
        };
        messageOrder.push(messageId);
      }
      d.conversationsById[id] = { id, messagesById, messageOrder };
      d.conversationOrder.push(id);
    }
  });
  return doc;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function syncPair(inputA, inputB, maxRounds = 100) {
  let docA = inputA;
  let docB = inputB;
  let stateA = A.initSyncState();
  let stateB = A.initSyncState();
  let bytes = 0;
  let messages = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    let msgA;
    [stateA, msgA] = A.generateSyncMessage(docA, stateA);
    if (msgA) {
      bytes += msgA.byteLength;
      messages += 1;
      [docB, stateB] = A.receiveSyncMessage(docB, stateB, msgA);
    }
    let msgB;
    [stateB, msgB] = A.generateSyncMessage(docB, stateB);
    if (msgB) {
      bytes += msgB.byteLength;
      messages += 1;
      [docA, stateA] = A.receiveSyncMessage(docA, stateA, msgB);
    }
    if (!msgA && !msgB) return { docA, docB, messages, wireBytes: bytes, rounds: round + 1 };
  }
  throw new Error('sync benchmark did not converge');
}

const seedStart = performance.now();
const doc = fixture();
const seedMs = performance.now() - seedStart;

const saveStart = performance.now();
const saved = A.save(doc);
const saveMs = performance.now() - saveStart;

let tiny = A.clone(doc, { actor: ACTOR.iphone });
tiny = A.change(tiny, { message: 'tiny recipe edit', time: 1700000100 }, (d) => {
  d.recipesById['recipe-0000'].description = 'A tiny edited description.';
});
const incremental = A.getLastLocalChange(tiny);

if (global.gc) global.gc();
const heapBeforeLoad = process.memoryUsage().heapUsed;
const loadTimes = [];
let lastLoaded;
for (let i = 0; i < 5; i += 1) {
  const started = performance.now();
  const loaded = A.load(saved, { actor: 'dddddddddddddddddddddddddddddddd' });
  loadTimes.push(performance.now() - started);
  if (lastLoaded) A.free(lastLoaded);
  lastLoaded = loaded;
}
if (global.gc) global.gc();
const heapAfterLoad = process.memoryUsage().heapUsed;
if (lastLoaded) A.free(lastLoaded);

let replicaA = A.clone(doc, { actor: ACTOR.iphone });
let replicaB = A.clone(doc, { actor: ACTOR.macbook });
replicaA = A.change(replicaA, { message: 'phone tiny edit', time: 1700000100 }, (d) => {
  d.recipesById['recipe-0001'].title = 'Phone recipe title';
});
replicaB = A.change(replicaB, { message: 'laptop tiny edit', time: 1700000200 }, (d) => {
  d.pantryById['pantry-0001'].preference = 5;
});

const syncStart = performance.now();
const synced = syncPair(replicaA, replicaB);
const syncMs = performance.now() - syncStart;

const output = {
  engine: '@automerge/automerge',
  version: '3.5.0',
  generatedAt: new Date().toISOString(),
  fixture: {
    pantryItems: 200,
    recipes: 500,
    conversations: 100,
    messagesPerConversation: 20,
    recipeIngredients: 5,
    recipeSteps: 4
  },
  runner: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null
  },
  metrics: {
    fixtureConstructionMs: +seedMs.toFixed(3),
    serializedDocumentBytes: saved.byteLength,
    saveMs: +saveMs.toFixed(3),
    incrementalTinyEditBytes: incremental?.byteLength ?? null,
    coldLoadMs: {
      samples: loadTimes.map((x) => +x.toFixed(3)),
      median: +median(loadTimes).toFixed(3)
    },
    twoReplicaSyncMs: +syncMs.toFixed(3),
    twoReplicaSyncWireBytes: synced.wireBytes,
    twoReplicaSyncMessages: synced.messages,
    twoReplicaSyncRounds: synced.rounds,
    grossHeapDeltaForLoadedDocumentBytes: heapAfterLoad - heapBeforeLoad
  },
  caveats: [
    'GitHub-hosted runner timing is directional, not a device microbenchmark.',
    'Heap delta is a gross Node/V8 observation after GC, not native RSS or Hermes memory.',
    'The fixture uses a stable-ID map plus order-list schema intended for the feasibility comparison.'
  ]
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/benchmark-results.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));

A.free(doc);
A.free(tiny);
A.free(synced.docA);
A.free(synced.docB);
