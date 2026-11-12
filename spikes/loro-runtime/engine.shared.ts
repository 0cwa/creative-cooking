import type { Recipe, RecipeIngredient } from '../../src/domain/types';

export type LoroMapPort = {
  set(key: string, value: unknown): void;
};

export type LoroListPort = {
  insert(index: number, value: unknown): void;
  delete(index: number, count: number): void;
};

export type LoroDocPort = {
  setPeerId(peerId: string): void;
  getMap(name: string): LoroMapPort;
  getList(name: string): LoroListPort;
  version(): unknown;
  export(options: { mode: 'snapshot' | 'update'; from?: unknown }): Uint8Array;
  import(bytes: Uint8Array): unknown;
  importUpdateBatch(updates: Uint8Array[]): unknown;
  toJSON(): Record<string, unknown>;
};

export type LoroConstructor = new () => LoroDocPort;

export type SpikeReport = {
  adapter: 'loro-crdt' | 'loro-react-native';
  reopenedPreviousSnapshot: boolean;
  sameFieldWinner: string;
  removedIngredientRetainedEdit: boolean;
  stableRowIdsPreserved: boolean;
  webUpdateImported: boolean;
  differentOrdersConverged: boolean;
  portableRoundTrip: boolean;
  startupMs: number;
  updateBytes: number;
  snapshotBytes: number;
  localUpdateBytes: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function json(document: LoroDocPort): string {
  return JSON.stringify(canonical(document.toJSON()));
}

function makeDocument(LoroDoc: LoroConstructor, peerId: string, snapshot?: Uint8Array): LoroDocPort {
  const document = new LoroDoc();
  if (snapshot) document.import(snapshot);
  document.setPeerId(peerId);
  return document;
}

export function seed(LoroDoc: LoroConstructor): Uint8Array {
  const document = makeDocument(LoroDoc, '1');
  const recipe = document.getMap('recipe');
  recipe.set('id', 'recipe-weeknight-lentil-soup');
  recipe.set('title', 'Weeknight lentil soup');
  const ingredientOrder = document.getList('ingredient-order');
  ingredientOrder.insert(0, 'ing-lentils-7');
  ingredientOrder.insert(1, 'ing-stock-8');
  document.getMap('ingredient:ing-lentils-7').set('id', 'ing-lentils-7');
  document.getMap('ingredient:ing-lentils-7').set('name', 'red lentils');
  document.getMap('ingredient:ing-lentils-7').set('amount', '200 g');
  document.getMap('ingredient:ing-lentils-7').set('deleted', false);
  document.getMap('ingredient:ing-stock-8').set('id', 'ing-stock-8');
  document.getMap('ingredient:ing-stock-8').set('name', 'vegetable stock');
  document.getMap('ingredient:ing-stock-8').set('amount', '1 L');
  document.getMap('ingredient:ing-stock-8').set('deleted', false);
  const stepOrder = document.getList('step-order');
  stepOrder.insert(0, 'step-rinse-1');
  stepOrder.insert(1, 'step-simmer-2');
  document.getMap('step:step-rinse-1').set('id', 'step-rinse-1');
  document.getMap('step:step-rinse-1').set('text', 'Rinse the lentils.');
  document.getMap('step:step-simmer-2').set('id', 'step-simmer-2');
  document.getMap('step:step-simmer-2').set('text', 'Simmer until tender.');
  return document.export({ mode: 'snapshot' });
}

function applyScenario(LoroDoc: LoroConstructor, base: Uint8Array, externalWebUpdate?: Uint8Array) {
  const baseDocument = makeDocument(LoroDoc, '3', base);
  const baseVersion = baseDocument.version();
  const left = makeDocument(LoroDoc, '101', base);

  // Simulate two offline devices editing separate fields and one shared field.
  left.getMap('ingredient:ing-lentils-7').set('amount', '250 g');
  left.getMap('ingredient:ing-stock-8').set('deleted', true);
  left.getMap('recipe').set('title', 'Lentil soup (A) 🧪');

  const leftUpdate = left.export({ mode: 'update', from: baseVersion });
  let rightUpdate = externalWebUpdate;
  if (!rightUpdate) {
    const right = makeDocument(LoroDoc, '202', base);
    right.getList('step-order').delete(1, 1);
    right.getList('step-order').insert(1, 'step-simmer-25m-3');
    right.getMap('step:step-simmer-25m-3').set('id', 'step-simmer-25m-3');
    right.getMap('step:step-simmer-25m-3').set('text', 'Simmer for 25 minutes — 🍲');
    right.getMap('ingredient:ing-stock-8').set('amount', '900 ml');
    right.getMap('recipe').set('title', 'Lentil soup (B) 🍲');
    rightUpdate = right.export({ mode: 'update', from: baseVersion });
  }

  const firstOrder = makeDocument(LoroDoc, '301', base);
  firstOrder.importUpdateBatch([leftUpdate, rightUpdate, leftUpdate]);
  const secondOrder = makeDocument(LoroDoc, '302', base);
  secondOrder.importUpdateBatch([rightUpdate, leftUpdate, rightUpdate]);

  assert(json(firstOrder) === json(secondOrder), 'different and duplicate update orders did not converge');
  const state = firstOrder.toJSON() as {
    recipe?: { title?: string };
    'ingredient-order'?: string[];
    'ingredient:ing-lentils-7'?: { id?: string; amount?: string };
    'ingredient:ing-stock-8'?: { id?: string; amount?: string; deleted?: boolean };
    'step-order'?: string[];
    'step:step-simmer-25m-3'?: { id?: string; text?: string };
    [key: string]: unknown;
  };
  const winner = state.recipe?.title;
  assert(winner === 'Lentil soup (A) 🧪' || winner === 'Lentil soup (B) 🍲', 'same-field conflict has no winner');
  assert(state['ingredient:ing-stock-8']?.deleted === true, 'logical delete marker was lost');
  assert(state['ingredient:ing-stock-8']?.amount === '900 ml', 'concurrent edit was lost when deletion won');
  assert(state['ingredient:ing-stock-8']?.id === 'ing-stock-8', 'stock stable ID was lost');
  assert(state['ingredient:ing-lentils-7']?.id === 'ing-lentils-7', 'lentil stable ID was lost');
  assert(state['ingredient:ing-lentils-7']?.amount === '250 g', 'ingredient edit was lost');
  assert(state['step-order']?.join(',') === 'step-rinse-1,step-simmer-25m-3', 'step IDs/order were lost');
  assert(state['step:step-simmer-25m-3']?.id === 'step-simmer-25m-3', 'step stable ID was lost');
  assert(state['step:step-simmer-25m-3']?.text === 'Simmer for 25 minutes — 🍲', 'step edit was lost');

  const projectedIngredients = (state['ingredient-order'] ?? []).flatMap((id) => {
    const item = state[`ingredient:${id}`] as { id?: string; name?: string; amount?: string; deleted?: boolean } | undefined;
    if (!item || item.deleted) return [];
    return [{ id: item.id, name: item.name ?? id, ...(item.amount === undefined ? {} : { amount: item.amount }) }];
  });
  assert(projectedIngredients[0]?.id === 'ing-lentils-7', 'recipe projection lost the stable row ID');

  const projectedRecipe: Recipe = {
    id: 'fixture-weeknight-lentil-soup',
    title: winner,
    portions: 4,
    ingredients: projectedIngredients,
    steps: (state['step-order'] ?? []).flatMap((id) => {
      const step = state[`step:${id}`] as { text?: string } | undefined;
      return step?.text ? [step.text] : [];
    }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  assert(projectedRecipe.title === winner, 'Loro state did not project to the app Recipe shape');
  assert(projectedRecipe.ingredients[0]?.amount === '250 g', 'recipe projection lost the ingredient edit');
  assert(projectedRecipe.steps[1] === 'Simmer for 25 minutes — 🍲', 'recipe projection lost the step edit');

  const finalSnapshot = firstOrder.export({ mode: 'snapshot' });
  const imported = makeDocument(LoroDoc, '401', finalSnapshot);
  assert(json(firstOrder) === json(imported), 'portable snapshot import changed the document');
  assert(leftUpdate.length > 0 && rightUpdate.length > 0, 'offline update export was empty');
  assert(base.length > 0 && finalSnapshot.length > 0, 'snapshot export was empty');

  return {
    finalSnapshot,
    winner,
    localUpdate: leftUpdate,
    webUpdateImported: Boolean(externalWebUpdate),
    updateBytes: leftUpdate.length + rightUpdate.length,
    snapshotBytes: finalSnapshot.length,
    baseVersion,
    state: json(firstOrder),
  };
}

export type ExternalWebFixture = { baseSnapshot: Uint8Array; update: Uint8Array };

export function runLoroScenario(
  LoroDoc: LoroConstructor,
  adapter: SpikeReport['adapter'],
  priorSnapshot?: Uint8Array,
  externalWebFixture?: ExternalWebFixture,
): SpikeReport & { snapshot: Uint8Array; json: string; localUpdate: Uint8Array } {
  const startupStart = globalThis.performance?.now?.() ?? Date.now();
  let reopenedPreviousSnapshot = false;
  if (priorSnapshot) {
    const reopened = makeDocument(LoroDoc, '501', priorSnapshot);
    reopenedPreviousSnapshot = Object.keys(reopened.toJSON()).length > 0;
    assert(reopenedPreviousSnapshot, 'stored snapshot reopened empty');
  }
  const base = seed(LoroDoc);
  if (externalWebFixture) {
    const importedWebBase = makeDocument(LoroDoc, '9', externalWebFixture.baseSnapshot);
    const localBase = makeDocument(LoroDoc, '9', base);
    assert(json(importedWebBase) === json(localBase), 'native import of the web snapshot differs from the native seed');
  }
  const result = applyScenario(LoroDoc, base, externalWebFixture?.update);
  const startupMs = (globalThis.performance?.now?.() ?? Date.now()) - startupStart;
  return {
    adapter,
    reopenedPreviousSnapshot,
    sameFieldWinner: result.winner,
    removedIngredientRetainedEdit: true,
    stableRowIdsPreserved: true,
    webUpdateImported: result.webUpdateImported,
    differentOrdersConverged: true,
    portableRoundTrip: true,
    startupMs: Number(startupMs.toFixed(2)),
    updateBytes: result.updateBytes,
    snapshotBytes: result.snapshotBytes,
    localUpdateBytes: result.localUpdate.length,
    snapshot: result.finalSnapshot,
    json: result.state,
    localUpdate: result.localUpdate,
  };
}
