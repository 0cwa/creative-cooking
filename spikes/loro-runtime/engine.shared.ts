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
  differentOrdersConverged: boolean;
  portableRoundTrip: boolean;
  startupMs: number;
  updateBytes: number;
  snapshotBytes: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function json(document: LoroDocPort): string {
  return JSON.stringify(document.toJSON());
}

function makeDocument(LoroDoc: LoroConstructor, peerId: string, snapshot?: Uint8Array): LoroDocPort {
  const document = new LoroDoc();
  if (snapshot) document.import(snapshot);
  document.setPeerId(peerId);
  return document;
}

function seed(LoroDoc: LoroConstructor): Uint8Array {
  const document = makeDocument(LoroDoc, '1');
  const recipe = document.getMap('recipe');
  recipe.set('title', 'Weeknight lentil soup');
  const ingredientOrder = document.getList('ingredient-order');
  ingredientOrder.insert(0, 'lentils');
  ingredientOrder.insert(1, 'stock');
  document.getMap('ingredient:lentils').set('name', 'red lentils');
  document.getMap('ingredient:lentils').set('amount', '200 g');
  document.getMap('ingredient:lentils').set('removed', false);
  document.getMap('ingredient:stock').set('name', 'vegetable stock');
  document.getMap('ingredient:stock').set('amount', '1 L');
  document.getMap('ingredient:stock').set('removed', false);
  const steps = document.getList('steps');
  steps.insert(0, 'Rinse the lentils.');
  steps.insert(1, 'Simmer until tender.');
  return document.export({ mode: 'snapshot' });
}

function applyScenario(LoroDoc: LoroConstructor, base: Uint8Array) {
  const baseDocument = makeDocument(LoroDoc, '3', base);
  const baseVersion = baseDocument.version();
  const left = makeDocument(LoroDoc, '101', base);
  const right = makeDocument(LoroDoc, '202', base);

  // Simulate two offline devices editing separate fields and one shared field.
  left.getMap('ingredient:lentils').set('amount', '250 g');
  left.getMap('ingredient:stock').set('removed', true);
  left.getMap('recipe').set('title', 'Lentil soup (A)');
  right.getList('steps').delete(1, 1);
  right.getList('steps').insert(1, 'Simmer for 25 minutes.');
  right.getMap('ingredient:stock').set('amount', '900 ml');
  right.getMap('recipe').set('title', 'Lentil soup (B)');

  const leftUpdate = left.export({ mode: 'update', from: baseVersion });
  const rightUpdate = right.export({ mode: 'update', from: baseVersion });

  const firstOrder = makeDocument(LoroDoc, '301', base);
  firstOrder.importUpdateBatch([leftUpdate, rightUpdate, leftUpdate]);
  const secondOrder = makeDocument(LoroDoc, '302', base);
  secondOrder.importUpdateBatch([rightUpdate, leftUpdate, rightUpdate]);

  assert(json(firstOrder) === json(secondOrder), 'different and duplicate update orders did not converge');
  const state = firstOrder.toJSON() as {
    recipe?: { title?: string };
    'ingredient-order'?: string[];
    'ingredient:stock'?: { amount?: string; removed?: boolean };
    'ingredient:lentils'?: { amount?: string };
    steps?: string[];
    [key: string]: unknown;
  };
  const winner = state.recipe?.title;
  assert(winner === 'Lentil soup (A)' || winner === 'Lentil soup (B)', 'same-field conflict has no winner');
  assert(state['ingredient:stock']?.removed === true, 'remove marker was lost');
  assert(state['ingredient:stock']?.amount === '900 ml', 'concurrent edit was lost when removal won');
  assert(state['ingredient:lentils']?.amount === '250 g', 'ingredient edit was lost');
  assert(state.steps?.[1] === 'Simmer for 25 minutes.', 'step edit was lost');

  const projectedRecipe: Recipe = {
    id: 'fixture-weeknight-lentil-soup',
    title: winner,
    portions: 4,
    ingredients: (state['ingredient-order'] ?? []).flatMap((id): RecipeIngredient[] => {
      const item = state[`ingredient:${id}`] as { name?: string; amount?: string; removed?: boolean } | undefined;
      if (!item || item.removed) return [];
      return [{ name: item.name ?? id, ...(item.amount === undefined ? {} : { amount: item.amount }) }];
    }),
    steps: state.steps ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  assert(projectedRecipe.title === winner, 'Loro state did not project to the app Recipe shape');
  assert(projectedRecipe.ingredients[0]?.amount === '250 g', 'recipe projection lost the ingredient edit');
  assert(projectedRecipe.steps[1] === 'Simmer for 25 minutes.', 'recipe projection lost the step edit');

  const finalSnapshot = firstOrder.export({ mode: 'snapshot' });
  const imported = makeDocument(LoroDoc, '401', finalSnapshot);
  assert(json(firstOrder) === json(imported), 'portable snapshot import changed the document');
  assert(leftUpdate.length > 0 && rightUpdate.length > 0, 'offline update export was empty');
  assert(base.length > 0 && finalSnapshot.length > 0, 'snapshot export was empty');

  return {
    finalSnapshot,
    winner,
    updateBytes: leftUpdate.length + rightUpdate.length,
    snapshotBytes: finalSnapshot.length,
    baseVersion,
    state: json(firstOrder),
  };
}

export function runLoroScenario(LoroDoc: LoroConstructor, adapter: SpikeReport['adapter'], priorSnapshot?: Uint8Array): SpikeReport & { snapshot: Uint8Array; json: string } {
  const startupStart = globalThis.performance?.now?.() ?? Date.now();
  let reopenedPreviousSnapshot = false;
  if (priorSnapshot) {
    const reopened = makeDocument(LoroDoc, '501', priorSnapshot);
    reopenedPreviousSnapshot = Object.keys(reopened.toJSON()).length > 0;
    assert(reopenedPreviousSnapshot, 'stored snapshot reopened empty');
  }
  const base = seed(LoroDoc);
  const result = applyScenario(LoroDoc, base);
  const startupMs = (globalThis.performance?.now?.() ?? Date.now()) - startupStart;
  return {
    adapter,
    reopenedPreviousSnapshot,
    sameFieldWinner: result.winner,
    removedIngredientRetainedEdit: true,
    differentOrdersConverged: true,
    portableRoundTrip: true,
    startupMs: Number(startupMs.toFixed(2)),
    updateBytes: result.updateBytes,
    snapshotBytes: result.snapshotBytes,
    snapshot: result.finalSnapshot,
    json: result.state,
  };
}
