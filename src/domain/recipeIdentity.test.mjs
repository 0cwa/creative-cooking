import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRecipeIdentity } from './recipeIdentity.ts';
import { parseRecipeIngredientsText, preserveRecipeStepIds, scaleRecipeIngredients } from './recipeEditing.ts';

test('legacy recipes receive restart-safe identities while retaining metadata', () => {
  const legacy = {
    id: 'recipe-1', title: 'Soup', portions: 2,
    ingredients: [{ name: 'salt', needsShopping: true }, { name: 'salt', amount: 'pinch', note: 'fine' }],
    steps: ['Stir.'], notes: ['Family note'], createdAt: 'a', updatedAt: 'b'
  };
  const once = normalizeRecipeIdentity(legacy);
  assert.deepEqual(normalizeRecipeIdentity(once), once);
  assert.notEqual(once.ingredients[0].id, once.ingredients[1].id);
  assert.equal(once.ingredients[0].needsShopping, true);
  assert.equal(once.ingredients[1].note, 'fine');
  assert.deepEqual(once.notes, ['Family note']);
});

test('natural editing retains identity across reorder and amount-only edits, including duplicates', () => {
  const old = [
    { id: 'a', name: 'salt', amount: '1 tsp', needsShopping: true },
    { id: 'b', name: 'salt', amount: '2 tsp' },
    { id: 'c', name: 'oil', amount: '1 tbsp' }
  ];
  const edited = parseRecipeIngredientsText('2 tsp salt\n3 tsp salt\n1 tbsp oil', old);
  assert.deepEqual(edited.map((item) => item.id), ['b', 'a', 'c']);
  assert.equal(edited[1].needsShopping, true);
  assert.deepEqual(parseRecipeIngredientsText('3 tsp salt\n1 tbsp oil', edited).map((item) => item.id), ['a', 'c']);
  assert.deepEqual(scaleRecipeIngredients(edited, 2, 4).map((item) => item.id), ['b', 'a', 'c']);
  assert.deepEqual(preserveRecipeStepIds(['Bake.', 'Mix.'], ['Mix.', 'Bake.'], ['m', 'b'], 'r'), ['b', 'm']);
});
