import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scaleIngredientAmount,
  scaleRecipeIngredients,
  shoppingIngredients
} from './recipeEditing.ts';

test('scales whole, decimal, simple fraction, and mixed-fraction quantities', () => {
  assert.equal(scaleIngredientAmount('2 tbsp', 4, 6), '3 tbsp');
  assert.equal(scaleIngredientAmount('0.5 tsp', 4, 8), '1 tsp');
  assert.equal(scaleIngredientAmount('1/2 cup', 4, 6), '3/4 cup');
  assert.equal(scaleIngredientAmount('1 1/2 cups', 4, 2), '3/4 cups');
});

test('keeps ambiguous or non-numeric amounts unchanged', () => {
  assert.equal(scaleIngredientAmount('2-3 tbsp', 4, 8), '2-3 tbsp');
  assert.equal(scaleIngredientAmount('1 to 2 cups', 4, 8), '1 to 2 cups');
  assert.equal(scaleIngredientAmount('2-inch piece', 4, 8), '2-inch piece');
  assert.equal(scaleIngredientAmount('to taste', 4, 8), 'to taste');
  assert.equal(scaleIngredientAmount(undefined, 4, 8), undefined);
});

test('scales recipe ingredient amounts without changing ingredient metadata', () => {
  const ingredients = [
    { name: 'carrots', amount: '200 g', needsShopping: true },
    { name: 'salt', amount: 'to taste' }
  ];
  assert.deepEqual(scaleRecipeIngredients(ingredients, 2, 4), [
    { name: 'carrots', amount: '400 g', needsShopping: true },
    { name: 'salt', amount: 'to taste' }
  ]);
});

test('returns explicitly marked shopping ingredients when pantry context is not supplied', () => {
  assert.deepEqual(
    shoppingIngredients([
      { name: 'carrots', needsShopping: true },
      { name: 'salt' },
      { name: 'lemon', needsShopping: false }
    ]),
    [{ name: 'carrots', needsShopping: true }]
  );
});

test('shopping list also includes recipe ingredients missing from Pantry', () => {
  assert.deepEqual(
    shoppingIngredients(
      [
        { name: 'Carrots', needsShopping: false },
        { name: 'sea salt' },
        { name: 'Lemon', needsShopping: true }
      ],
      ['carrots', 'SEA   SALT']
    ),
    [{ name: 'Lemon', needsShopping: true }]
  );

  assert.deepEqual(
    shoppingIngredients(
      [
        { name: 'carrots' },
        { name: 'lemon' }
      ],
      ['carrots']
    ),
    [{ name: 'lemon' }]
  );
});
