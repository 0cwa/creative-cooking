import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addHouseholdRecipe, copyRecipeForHousehold, createHousehold, effectiveHouseholdAllergies,
  normalizeHouseholds, normalizeHouseholdSelection, normalizeHouseholdState,
  removeHouseholdRecipe, updateHouseholdRequirements
} from './households.ts';

const now = '2026-10-12T10:00:00.000Z';
const later = '2026-10-12T11:00:00.000Z';
function recipe(id = 'recipe-1') {
  return {
    id, title: 'Soup', description: '', portions: 2,
    ingredients: [{ name: 'Carrot', amount: '', needsShopping: false, token: 'ingredient-secret' }],
    steps: ['Cook'], notes: ['private note'], createdAt: now, updatedAt: now,
    providerKey: 'recipe-secret', chatMessages: [{ content: 'private chat' }]
  };
}

test('v1 scope migration selects personal and leaves original personal state untouched', () => {
  const personal = { shoppingList: [{ checked: false }], settings: { allergies: ['nuts'], sendLocalTime: false } };
  const before = structuredClone(personal);
  assert.deepEqual(normalizeHouseholdState(personal), { households: [], activeHouseholdId: null });
  assert.deepEqual(personal, before);
  const household = createHousehold('home', 'Home', now);
  assert.equal(normalizeHouseholdSelection([household], 'home'), 'home');
  assert.equal(normalizeHouseholdSelection([household], 'removed-home'), null);
  assert.deepEqual(normalizeHouseholdState({ households: [household], activeHouseholdId: 'missing' }), {
    households: [household], activeHouseholdId: null
  });
});

test('same household names do not merge and lists remain isolated by ID', () => {
  const a = createHousehold('a', 'Family', now);
  const b = createHousehold('b', 'Family', now);
  a.shoppingList.push({ id: 'item-1', name: 'Carrot', amount: '', checked: false, createdAt: now, updatedAt: now });
  const normalized = normalizeHouseholds([a, b]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].shoppingList[0].checked, false);
  assert.equal(normalized[0].shoppingList[0].amount, '');
  assert.deepEqual(normalized[1].shoppingList, []);
  normalized[0].shoppingList[0].checked = true;
  assert.equal(a.shoppingList[0].checked, false);
});

test('explicit recipe snapshots are independent, safe, and idempotent per household source ID', () => {
  const source = recipe();
  const a = createHousehold('a', 'Home', now);
  const b = createHousehold('b', 'Other home', now);
  const sharedA = addHouseholdRecipe(a, source, 'a-copy', later);
  const sharedB = addHouseholdRecipe(b, source, 'b-copy', later);
  source.title = 'Changed original';
  source.ingredients[0].name = 'Potato';
  source.steps.push('New step');
  assert.equal(sharedA.recipes[0].recipe.title, 'Soup');
  assert.equal(sharedB.recipes[0].recipe.ingredients[0].name, 'Carrot');
  assert.deepEqual(sharedA.recipes[0].recipe.steps, ['Cook']);
  assert.equal(sharedA.recipes[0].sourceRecipeId, 'recipe-1');
  assert.equal(sharedA.recipes[0].id, 'a-copy');
  assert.equal(sharedB.recipes[0].id, 'b-copy');
  assert.equal(sharedA.recipes[0].recipe.description, '');
  assert.deepEqual(sharedA.recipes[0].recipe.ingredients, [{ name: 'Carrot', amount: '' }]);
  assert.equal(sharedA.recipes[0].recipe.notes, undefined);
  assert.equal(sharedA.recipes[0].recipe.providerKey, undefined);
  assert.equal(sharedA.recipes[0].recipe.chatMessages, undefined);
  assert.equal(addHouseholdRecipe(sharedA, source, 'unused-id', later).recipes.length, 1);
  assert.equal(a.recipes.length, 0);
  const removed = removeHouseholdRecipe(sharedA, 'a-copy', later);
  assert.equal(removed.recipes.length, 0);
  assert.equal(sharedB.recipes.length, 1);
});

test('import projection removes private and unknown data at all nested levels', () => {
  const household = addHouseholdRecipe(createHousehold('a', 'Home', now), recipe(), 'copy', now);
  household.credentials = { key: 'secret' };
  household.settings = { city: 'private' };
  household.requirements.apiKey = 'secret';
  household.shoppingList.push({
    id: 'item', name: 'Carrot', checked: false, createdAt: now, updatedAt: now, deviceId: 'private', notes: ['secret']
  });
  household.recipes[0].deviceKey = 'secret';
  household.recipes[0].recipe.notes = ['secret'];
  household.recipes[0].recipe.ingredients[0].needsShopping = true;
  const serialized = JSON.stringify(normalizeHouseholds([household]));
  for (const privateField of ['credentials', 'settings', 'apiKey', 'deviceId', 'deviceKey', 'notes', 'needsShopping', 'secret']) {
    assert.ok(!serialized.includes(privateField), `unexpected ${privateField}`);
  }
});

test('malformed imports fail rather than silently losing selected household data', () => {
  const household = createHousehold('a', 'Home', now);
  for (const malformed of [null, {}, 'households', [null], [{ ...household, shoppingList: {} }],
    [{ ...household, requirements: { allergies: [], diet: 'anything' } }],
    [{ ...household, createdAt: 'not a date' }], [household, household]]) {
    assert.throws(() => normalizeHouseholds(malformed));
  }
  assert.throws(() => normalizeHouseholdState({ households: null }));
  assert.throws(() => copyRecipeForHousehold({ ...recipe(), portions: NaN }));
  assert.throws(() => copyRecipeForHousehold({ ...recipe(), steps: [3] }));
  const withCopy = addHouseholdRecipe(household, recipe(), 'copy', now);
  assert.throws(() => addHouseholdRecipe(withCopy, recipe('recipe-2'), 'copy', now));
  assert.throws(() => normalizeHouseholds([{ ...withCopy, recipes: [...withCopy.recipes, { ...withCopy.recipes[0], id: 'second-copy' }] }]));
  const item = { id: 'item', name: 'Carrot', checked: false, createdAt: now, updatedAt: now };
  assert.throws(() => normalizeHouseholds([{ ...household, shoppingList: [item, item] }]));
  assert.throws(() => normalizeHouseholds([{ ...household, shoppingList: [{ ...item, checked: 0 }] }]));
});

test('requirements change independently and effective allergies stay local', () => {
  const a = createHousehold('a', 'Home', now);
  const b = createHousehold('b', 'Other home', now);
  const updated = updateHouseholdRequirements(a, { allergies: [' Nuts ', 'soy'], diet: 'vegan' }, later);
  const personal = ['nuts', '  shellfish  ', ''];
  assert.deepEqual(effectiveHouseholdAllergies(personal, updated), ['nuts', 'shellfish', 'soy']);
  assert.deepEqual(effectiveHouseholdAllergies(personal, null), ['nuts', 'shellfish']);
  assert.deepEqual(updated.requirements, { allergies: [' Nuts ', 'soy'], diet: 'vegan' });
  assert.deepEqual(a.requirements, { allergies: [], diet: 'none' });
  assert.deepEqual(b.requirements, { allergies: [], diet: 'none' });
  assert.deepEqual(personal, ['nuts', '  shellfish  ', '']);
  assert.equal(updated.updatedAt, later);
});
