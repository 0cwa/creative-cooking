import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendShoppingItems,
  applyShoppingPurchase,
  createShoppingList,
  emptyShoppingState,
  migrateLegacyShopping,
  removeShoppingList,
  setShoppingItemChecked,
  startNewPurchaseCycle,
  validateShoppingState
} from './shopping.ts';

const at = '2026-10-01T12:00:00.000Z';

function newList() {
  return createShoppingList(emptyShoppingState(), {
    id: 'list-main',
    cycleId: 'cycle-first',
    name: 'Weekly shop',
    at
  });
}

test('legacy recipe flags migrate deterministically and keep duplicate ingredient lines distinct', () => {
  const recipes = [{
    id: 'recipe-soup',
    title: 'Soup',
    description: 'Keep this metadata.',
    portions: 2,
    ingredients: [
      { name: 'carrot', amount: '2 medium', needsShopping: true, note: 'first line' },
      { name: 'carrot', amount: '1 grated', needsShopping: true, note: 'second line' },
      { name: 'salt', needsShopping: false }
    ],
    steps: ['Cook.'],
    notes: ['Taste first.'],
    createdAt: at,
    updatedAt: at
  }];
  const original = structuredClone(recipes);
  const first = migrateLegacyShopping(recipes);
  const second = migrateLegacyShopping(recipes);

  assert.deepEqual(second, first);
  assert.equal(first.lists.length, 1);
  assert.equal(first.items.length, 2);
  assert.notEqual(first.items[0].id, first.items[1].id);
  assert.notEqual(first.items[0].ingredientId, first.items[1].ingredientId);
  assert.deepEqual(first.items.map((item) => item.displayQuantity), ['2 medium', '1 grated']);
  assert.deepEqual(recipes, original);
});

test('purchases are recorded once and pantry effects do not repeat', () => {
  let shopping = appendShoppingItems(newList(), 'list-main', [
    { id: 'item-carrots-a', name: 'carrots', at },
    { id: 'item-carrots-b', name: ' Carrots ', at },
    { id: 'item-lemon', name: 'lemon', at }
  ]);
  for (const item of shopping.items) {
    shopping = setShoppingItemChecked(shopping, item.id, 'cycle-first', true, at);
  }

  const command = {
    id: 'purchase-trip-001',
    listId: 'list-main',
    purchaseCycleId: 'cycle-first',
    purchasedAt: at
  };
  const first = applyShoppingPurchase(shopping, [], command);
  assert.equal(first.applied, true);
  assert.equal(first.pantryAdded, 2);
  assert.deepEqual(first.pantry.map((item) => item.name), ['carrots', 'lemon']);
  assert.equal(first.shopping.purchases.length, 1);
  assert.equal(first.shopping.purchases[0].itemIds.length, 3);
  assert.equal(first.shopping.purchases[0].pantryItemIds.length, 2);

  const replay = applyShoppingPurchase(first.shopping, first.pantry, command);
  assert.equal(replay.applied, false);
  assert.equal(replay.pantryAdded, 0);
  assert.equal(replay.pantry, first.pantry);
  assert.equal(replay.shopping, first.shopping);

  const duplicateTrip = applyShoppingPurchase(first.shopping, first.pantry, {
    ...command,
    id: 'purchase-trip-002'
  });
  assert.equal(duplicateTrip.applied, false);
  assert.equal(duplicateTrip.pantry.length, 2);
  assert.equal(duplicateTrip.shopping.purchases.length, 1);
});

test('old cycle checks and purchases cannot complete or purchase a new cycle', () => {
  let shopping = appendShoppingItems(newList(), 'list-main', [{ id: 'item-oats', name: 'oats', at }]);
  shopping = setShoppingItemChecked(shopping, 'item-oats', 'cycle-first', true, at);
  const firstPurchase = applyShoppingPurchase(shopping, [], {
    id: 'purchase-cycle-first',
    listId: 'list-main',
    purchaseCycleId: 'cycle-first',
    purchasedAt: at
  });
  const next = startNewPurchaseCycle(firstPurchase.shopping, 'list-main', 'cycle-second', at);
  const staleCheck = setShoppingItemChecked(next, 'item-oats', 'cycle-first', true, at);
  assert.equal(staleCheck, next);
  assert.equal(next.items[0].checked, false);
  assert.equal(next.items[0].purchaseCycleId, 'cycle-second');
  assert.equal(next.items[0].purchasedCycleId, undefined);

  const stalePurchase = applyShoppingPurchase(next, firstPurchase.pantry, {
    id: 'purchase-stale-replay',
    listId: 'list-main',
    purchaseCycleId: 'cycle-first',
    purchasedAt: at
  });
  assert.equal(stalePurchase.applied, false);
  assert.equal(stalePurchase.pantry.length, 1);
  assert.equal(stalePurchase.shopping, next);

  const checkedAgain = setShoppingItemChecked(next, 'item-oats', 'cycle-second', true, at);
  const secondPurchase = applyShoppingPurchase(checkedAgain, firstPurchase.pantry, {
    id: 'purchase-cycle-second',
    listId: 'list-main',
    purchaseCycleId: 'cycle-second',
    purchasedAt: at
  });
  assert.equal(secondPurchase.applied, true);
  assert.equal(secondPurchase.pantry.length, 1);
  assert.equal(secondPurchase.shopping.purchases.length, 2);
});

test('removed lists retain tombstones and items while disappearing from active records', () => {
  const withItem = appendShoppingItems(newList(), 'list-main', [{ id: 'item-beans', name: 'beans', at }]);
  const removed = removeShoppingList(withItem, 'list-main', at);
  assert.ok(removed.lists[0].removedAt);
  assert.ok(removed.items[0].removedAt);
  assert.equal(removed.items.length, 1);
  assert.deepEqual(validateShoppingState(removed), removed);
});

test('purchase IDs remain valid historical snapshots after item and pantry rows are absent', () => {
  const state = {
    lists: [{ id: 'list-main', name: 'Weekly shop', currentCycleId: 'cycle-first', createdAt: at, updatedAt: at }],
    cycles: [{ id: 'cycle-first', listId: 'list-main', startedAt: at }],
    items: [],
    purchases: [{
      id: 'purchase-archived', listId: 'list-main', purchaseCycleId: 'cycle-first',
      itemIds: ['removed-shopping-item'], pantryItemIds: ['deleted-pantry-item'], purchasedAt: at
    }]
  };
  assert.deepEqual(validateShoppingState(state), state);
});
