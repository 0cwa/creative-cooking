import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_STATE } from '../domain/defaults.ts';
import { buildContentMutationOperations, buildGuestAdoptionMutationOperations, withOperationIds } from './mutations.ts';
import { remapGuestStateForWorkspace } from './adoptionMapping.ts';
import { contentStorageId, decodeContentRows, encodeContentRows } from './recordCodec.ts';

const at = '2026-10-01T12:00:00.000Z';
const spaceA = '7B3bde80-1f15-455e-a7ab-7f51e0965f32';
const spaceB = '40c24cef-8fd3-4b46-8ff6-91e7ac46031c';

function recipe(id, title, childId = 'shared-child') {
  return {
    id,
    title,
    description: 'Preserve the recipe description.',
    portions: 2,
    ingredients: [{ id: childId, name: 'beans', amount: '1 cup', needsShopping: true, note: 'keep metadata' }],
    steps: ['Simmer.'],
    stepIds: ['step-stable'],
    notes: ['Family note'],
    createdAt: at,
    updatedAt: at
  };
}

function stateWith(patch = {}) {
  return structuredClone({ ...DEFAULT_STATE, ...patch });
}

test('cc1 keys encode workspace, parent, and nested domain ID independently', () => {
  assert.equal(
    contentStorageId('recipe_ingredients', spaceA.toUpperCase(), 'recipe/one', 'child id'),
    'cc1:recipe_ingredients:7b3bde80-1f15-455e-a7ab-7f51e0965f32:srecipe%2Fone:schild%20id'
  );

  const state = stateWith({ recipes: [recipe('recipe/one', 'One'), recipe('recipe two', 'Two')] });
  const rows = encodeContentRows(state, spaceA);
  assert.equal(rows.recipe_ingredients.length, 2);
  assert.deepEqual(rows.recipe_ingredients.map((row) => row.entity_id), ['shared-child', 'shared-child']);
  assert.notEqual(rows.recipe_ingredients[0].id, rows.recipe_ingredients[1].id);
  assert.ok(rows.recipe_ingredients.every((row) => row.id.startsWith('cc1:recipe_ingredients:')));

  const decoded = decodeContentRows(rows, DEFAULT_STATE);
  assert.equal(decoded.recipes[0].ingredients[0].id, 'shared-child');
  assert.equal(decoded.recipes[0].ingredients[0].note, 'keep metadata');
  assert.deepEqual(decoded.recipes[0].notes, ['Family note']);
});

test('guest adoption IDs are stable per destination space and retain recipe-scoped child IDs', () => {
  const guest = stateWith({ recipes: [recipe('legacy-root', 'Legacy', 'nested-id')] });
  const first = remapGuestStateForWorkspace(guest, 'migration-a', spaceA);
  const replay = remapGuestStateForWorkspace(guest, 'migration-a', spaceA);
  const secondSpace = remapGuestStateForWorkspace(guest, 'migration-a', spaceB);

  assert.equal(first.state.recipes[0].id, replay.state.recipes[0].id);
  assert.notEqual(first.state.recipes[0].id, secondSpace.state.recipes[0].id);
  assert.equal(first.state.recipes[0].ingredients[0].id, 'nested-id');
  assert.equal(first.rows.recipe_ingredients[0].entity_id, 'nested-id');
  assert.equal(first.rows.recipe_ingredients[0].recipe_id, first.state.recipes[0].id);
  assert.notEqual(first.rows.recipes[0].id, secondSpace.rows.recipes[0].id);
});

test('purchase pantry additions travel only inside the atomic purchase command', () => {
  const before = stateWith({
    shopping: {
      lists: [{ id: 'list-1', name: 'Weekly', currentCycleId: 'cycle-1', createdAt: at, updatedAt: at }],
      cycles: [{ id: 'cycle-1', listId: 'list-1', startedAt: at }],
      items: [{ id: 'item-1', listId: 'list-1', name: 'Beans', purchaseCycleId: 'cycle-1', checked: true, createdAt: at, updatedAt: at }],
      purchases: []
    }
  });
  const pantryAddition = {
    id: 'shopping-purchase:purchase-1:item-1', name: 'Beans', preference: 3, createdAt: at, updatedAt: at
  };
  const after = structuredClone(before);
  after.pantry = [pantryAddition];
  after.shopping.items[0].purchasedCycleId = 'cycle-1';
  after.shopping.items[0].updatedAt = '2026-10-01T12:01:00.000Z';
  after.shopping.purchases.push({
    id: 'purchase-1', listId: 'list-1', purchaseCycleId: 'cycle-1',
    itemIds: ['item-1'], pantryItemIds: [pantryAddition.id], purchasedAt: '2026-10-01T12:01:00.000Z'
  });

  const operations = buildContentMutationOperations(before, after);
  assert.equal(operations.filter((operation) => operation.type === 'shopping.purchase').length, 1);
  assert.equal(operations.filter((operation) => operation.type === 'pantry.upsert').length, 0);
  const purchase = operations.find((operation) => operation.type === 'shopping.purchase');
  assert.deepEqual(purchase.pantryAdds, [{ id: pantryAddition.id, name: 'Beans', preference: 3 }]);
  assert.deepEqual(purchase.purchase.itemIds, ['item-1']);
});

test('recipe edits emit no shopping commands and preserve explicit shopping records', () => {
  const before = stateWith({
    recipes: [recipe('recipe-1', 'Original')],
    shopping: {
      lists: [{ id: 'list-1', name: 'Weekly', currentCycleId: 'cycle-1', createdAt: at, updatedAt: at }],
      cycles: [{ id: 'cycle-1', listId: 'list-1', startedAt: at }],
      items: [{ id: 'item-1', listId: 'list-1', name: 'Beans', recipeId: 'recipe-1', ingredientId: 'shared-child', purchaseCycleId: 'cycle-1', checked: false, createdAt: at, updatedAt: at }],
      purchases: []
    }
  });
  const after = structuredClone(before);
  after.recipes[0].title = 'Edited';
  after.recipes[0].updatedAt = '2026-10-01T12:01:00.000Z';

  const operations = buildContentMutationOperations(before, after);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'recipe.save');
  assert.equal(operations[0].recipe.id, 'recipe-1');
  assert.equal(operations[0].recipe.ingredients[0].id, 'shared-child');
});

test('shopping tombstones cannot be edited or resurrected by later state differences', () => {
  const before = stateWith({
    shopping: {
      lists: [{ id: 'list-1', name: 'Weekly', currentCycleId: 'cycle-1', createdAt: at, updatedAt: at }],
      cycles: [{ id: 'cycle-1', listId: 'list-1', startedAt: at }],
      items: [{ id: 'removed-item', listId: 'list-1', name: 'Beans', purchaseCycleId: 'cycle-1', checked: false,
        createdAt: at, updatedAt: at, removedAt: '2026-10-01T12:01:00.000Z' }],
      purchases: []
    }
  });
  const after = structuredClone(before);
  after.shopping.items[0].name = 'Beans restored by stale aggregate';
  after.shopping.items[0].updatedAt = '2026-10-01T12:02:00.000Z';

  assert.deepEqual(buildContentMutationOperations(before, after), []);
});

test('guest adoption imports ordered history without replaying pantry or completion effects', () => {
  const before = stateWith();
  const after = stateWith({
    pantry: [{ id: 'pantry-added', name: 'beans', preference: 3, createdAt: at, updatedAt: at }],
    shopping: {
      lists: [{ id: 'list-new', name: 'Weekly', currentCycleId: 'cycle-current', createdAt: at, updatedAt: at }],
      cycles: [
        { id: 'cycle-old', listId: 'list-new', startedAt: '2026-09-01T10:00:00.000Z' },
        { id: 'cycle-current', listId: 'list-new', startedAt: at }
      ],
      items: [{ id: 'item-live', listId: 'list-new', name: 'beans', purchaseCycleId: 'cycle-current', checked: true, purchasedCycleId: 'cycle-current', createdAt: at, updatedAt: at }],
      purchases: [
        { id: 'purchase-old', listId: 'list-new', purchaseCycleId: 'cycle-old', itemIds: ['item-removed'], pantryItemIds: ['pantry-removed'], purchasedAt: '2026-09-02T10:00:00.000Z' },
        { id: 'purchase-current', listId: 'list-new', purchaseCycleId: 'cycle-current', itemIds: ['item-live'], pantryItemIds: ['pantry-added'], purchasedAt: at }
      ]
    }
  });

  const operations = buildGuestAdoptionMutationOperations(before, after);
  const history = operations.filter((operation) => operation.type === 'shopping.history.import');
  assert.deepEqual(Object.keys(history[0]).sort(), ['currentCycleId', 'cycles', 'listId', 'opId', 'purchases', 'type']);
  assert.equal(operations.some((operation) => operation.type === 'shopping.purchase'), false);
  assert.equal(operations.some((operation) => operation.type === 'pantry.upsert' && operation.id === 'pantry-added'), true);
  const importedItem = operations.find((operation) => operation.type === 'shopping.item.upsert' && operation.item.id === 'item-live');
  assert.equal(importedItem.item.checked, true);
  assert.equal(importedItem.item.purchasedCycleId, null);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0].cycles, [{ id: 'cycle-old', startedAt: '2026-09-01T10:00:00.000Z' }]);
  assert.equal(history[0].currentCycleId, 'cycle-current');
  assert.deepEqual(history[1].purchases.map((purchase) => purchase.id), ['purchase-old', 'purchase-current']);
  assert.deepEqual(history[1].purchases[0].itemIds, ['item-removed']);
  assert.deepEqual(history[1].purchases[0].pantryItemIds, ['pantry-removed']);
  assert.deepEqual(buildGuestAdoptionMutationOperations(before, after), operations);
});

test('adoption and downloaded history preserve ordered snapshots without live item or pantry rows', () => {
  const sourceItemIds = ['removed-z', 'never-present-a', 'removed-z'];
  const sourcePantryIds = ['deleted-pantry-z', 'never-present-b', 'deleted-pantry-z'];
  const guest = stateWith({
    shopping: {
      lists: [{ id: 'guest-list', name: 'Old list', currentCycleId: 'guest-current', createdAt: at, updatedAt: at }],
      cycles: [{ id: 'guest-current', listId: 'guest-list', startedAt: at }],
      items: [],
      purchases: [{
        id: 'guest-purchase', listId: 'guest-list', purchaseCycleId: 'guest-current',
        itemIds: sourceItemIds, pantryItemIds: sourcePantryIds, purchasedAt: at
      }]
    }
  });

  const adopted = remapGuestStateForWorkspace(guest, 'migration-history-snapshots', spaceA);
  const adoptedPurchase = adopted.state.shopping.purchases[0];
  const priorSnapshot = remapGuestStateForWorkspace(guest, 'migration-history-snapshots', spaceA)
    .state.shopping.purchases[0];
  assert.deepEqual(adoptedPurchase.itemIds, priorSnapshot.itemIds);
  assert.deepEqual(adoptedPurchase.pantryItemIds, priorSnapshot.pantryItemIds);
  assert.equal(adoptedPurchase.itemIds.length, sourceItemIds.length);
  assert.equal(adoptedPurchase.pantryItemIds.length, sourcePantryIds.length);
  assert.equal(adoptedPurchase.itemIds[0], adoptedPurchase.itemIds[2]);
  assert.notEqual(adoptedPurchase.itemIds[0], adoptedPurchase.itemIds[1]);
  assert.equal(adoptedPurchase.pantryItemIds[0], adoptedPurchase.pantryItemIds[2]);
  assert.notEqual(adoptedPurchase.pantryItemIds[0], adoptedPurchase.pantryItemIds[1]);
  assert.equal(adopted.rows.shopping_items.length, 0);
  assert.equal(adopted.rows.pantry_items.length, 0);
  assert.deepEqual(JSON.parse(adopted.rows.shopping_purchases[0].item_ids), adoptedPurchase.itemIds);
  assert.deepEqual(JSON.parse(adopted.rows.shopping_purchases[0].pantry_item_ids), adoptedPurchase.pantryItemIds);

  const operations = buildGuestAdoptionMutationOperations(stateWith(), adopted.state);
  const history = operations.find((operation) => operation.type === 'shopping.history.import' && operation.purchases.length);
  assert.equal(operations.some((operation) => operation.type === 'pantry.upsert'), false);
  assert.deepEqual(history.cycles, []);
  assert.equal(history.currentCycleId, adopted.state.shopping.lists[0].currentCycleId);
  assert.deepEqual(history.purchases[0].itemIds, adoptedPurchase.itemIds);
  assert.deepEqual(history.purchases[0].pantryItemIds, adoptedPurchase.pantryItemIds);
  const retryOperations = buildGuestAdoptionMutationOperations(stateWith(), adopted.state);
  assert.deepEqual(retryOperations, operations);
  const mutationId = 'guest-adoption-v2-history-retry';
  const firstRequest = { mutationId, operations: withOperationIds(mutationId, operations) };
  const retriedRequest = { mutationId, operations: withOperationIds(mutationId, retryOperations) };
  assert.equal(JSON.stringify(retriedRequest), JSON.stringify(firstRequest));

  const decoded = decodeContentRows(adopted.rows, DEFAULT_STATE);
  assert.deepEqual(decoded.shopping.purchases[0].itemIds, adoptedPurchase.itemIds);
  assert.deepEqual(decoded.shopping.purchases[0].pantryItemIds, adoptedPurchase.pantryItemIds);
});

test('history payload and download validation reject malformed or over-limit snapshot IDs without truncating', () => {
  const state = stateWith({
    shopping: {
      lists: [{ id: 'list-1', name: 'Weekly', currentCycleId: 'cycle-1', createdAt: at, updatedAt: at }],
      cycles: [{ id: 'cycle-1', listId: 'list-1', startedAt: at }],
      items: [],
      purchases: [{
        id: 'purchase-1', listId: 'list-1', purchaseCycleId: 'cycle-1',
        itemIds: Array.from({ length: 201 }, (_, index) => `item-${index}`), pantryItemIds: [], purchasedAt: at
      }]
    }
  });
  assert.throws(() => buildContentMutationOperations(stateWith(), state), /at most 200 snapshot IDs/);
  assert.throws(() => decodeContentRows({
    shopping_purchases: [{
      id: 'purchase-storage-id', entity_id: 'purchase-1', space_id: spaceA,
      list_id: 'list-1', purchase_cycle_id: 'cycle-1', item_ids: JSON.stringify(Array.from({ length: 201 }, (_, index) => `item-${index}`)),
      pantry_item_ids: '[]', purchased_at: at
    }]
  }, DEFAULT_STATE), /at most 200 snapshot IDs/);
});

test('adoption imports a removed list history before applying its tombstone', () => {
  const after = stateWith({
    shopping: {
      lists: [{ id: 'list-old', name: 'Old', currentCycleId: 'cycle-current', createdAt: at, updatedAt: at, removedAt: '2026-10-02T10:00:00.000Z' }],
      cycles: [
        { id: 'cycle-past', listId: 'list-old', startedAt: '2026-09-01T10:00:00.000Z' },
        { id: 'cycle-current', listId: 'list-old', startedAt: at }
      ],
      items: [],
      purchases: [{ id: 'purchase-past', listId: 'list-old', purchaseCycleId: 'cycle-past', itemIds: ['deleted-item'], pantryItemIds: ['deleted-pantry'], purchasedAt: '2026-09-02T10:00:00.000Z' }]
    }
  });
  const operations = buildGuestAdoptionMutationOperations(stateWith(), after);
  const createIndex = operations.findIndex((operation) => operation.type === 'shopping.list.create');
  const historyIndex = operations.findIndex((operation) => operation.type === 'shopping.history.import' && operation.purchases.length > 0);
  const removeIndex = operations.findIndex((operation) => operation.type === 'shopping.list.remove');

  assert.ok(createIndex >= 0 && historyIndex > createIndex && removeIndex > historyIndex);
  assert.deepEqual(operations[historyIndex].purchases[0].itemIds, ['deleted-item']);
  assert.deepEqual(operations[historyIndex].purchases[0].pantryItemIds, ['deleted-pantry']);
});

test('downloaded purchase ledger derives completion and accepts absent historical item/pantry rows', () => {
  const state = stateWith({
    shopping: {
      lists: [{ id: 'list-1', name: 'Weekly', currentCycleId: 'cycle-current', createdAt: at, updatedAt: at }],
      cycles: [
        { id: 'cycle-old', listId: 'list-1', startedAt: at },
        { id: 'cycle-current', listId: 'list-1', startedAt: '2026-10-02T12:00:00.000Z' }
      ],
      items: [{ id: 'item-live', listId: 'list-1', name: 'beans', purchaseCycleId: 'cycle-current', checked: true, createdAt: at, updatedAt: at }],
      purchases: [
        { id: 'purchase-old', listId: 'list-1', purchaseCycleId: 'cycle-old', itemIds: ['item-removed'], pantryItemIds: ['pantry-removed'], purchasedAt: at },
        { id: 'purchase-current', listId: 'list-1', purchaseCycleId: 'cycle-current', itemIds: ['item-live'], pantryItemIds: ['pantry-removed'], purchasedAt: at }
      ]
    }
  });
  const rows = encodeContentRows(state, spaceA);
  const decoded = decodeContentRows(rows, DEFAULT_STATE);
  assert.equal(decoded.shopping.items[0].purchasedCycleId, 'cycle-current');
  assert.deepEqual(decoded.shopping.purchases[0].itemIds, ['item-removed']);
  assert.deepEqual(decoded.shopping.purchases[0].pantryItemIds, ['pantry-removed']);
});
