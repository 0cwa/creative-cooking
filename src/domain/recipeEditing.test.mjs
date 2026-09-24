import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatRecipeIngredientLine,
  formatRecipeIngredientsText,
  formatRecipeTextList,
  parseRecipeIngredientLine,
  parseRecipeIngredientsText,
  parseRecipeTextList,
  scaleIngredientAmount,
  scaleRecipeIngredients,
  shoppingIngredients
} from './recipeEditing.ts';

test('formats structured ingredients as natural recipe lines', () => {
  assert.equal(formatRecipeIngredientLine({ name: 'lentils', amount: '1 cup' }), '1 cup lentils');
  assert.equal(formatRecipeIngredientLine({ name: 'salt' }), 'salt');
  assert.equal(formatRecipeIngredientLine({ name: 'salt', amount: 'to taste' }), 'salt to taste');
  assert.equal(
    formatRecipeIngredientsText([
      { name: 'lentils', amount: '1 cup' },
      { name: 'lemon', amount: '1/2' }
    ]),
    '1 cup lentils\n1/2 lemon'
  );
});

test('parses common natural ingredient lines into amount and name', () => {
  assert.deepEqual(parseRecipeIngredientLine('1 cup lentils'), { amount: '1 cup', name: 'lentils' });
  assert.deepEqual(parseRecipeIngredientLine('200 g carrots'), { amount: '200 g', name: 'carrots' });
  assert.deepEqual(parseRecipeIngredientLine('3/4 lemon'), { amount: '3/4', name: 'lemon' });
  assert.deepEqual(parseRecipeIngredientLine('2 large onions'), { amount: '2', name: 'large onions' });
  assert.deepEqual(parseRecipeIngredientLine('salt to taste'), { name: 'salt', amount: 'to taste' });
  assert.deepEqual(parseRecipeIngredientLine('chili flakes as needed'), { name: 'chili flakes', amount: 'as needed' });
});

test('natural ingredient editing preserves exact existing metadata and parses new lines', () => {
  const previous = [
    { name: 'lentils', amount: '1 cup' },
    { name: 'lemon', amount: '1/2', needsShopping: true }
  ];

  assert.deepEqual(
    parseRecipeIngredientsText('• 1/2 lemon\n1 cup lentils\n1 tbsp olive oil', previous),
    [
      { name: 'lemon', amount: '1/2', needsShopping: true },
      { name: 'lentils', amount: '1 cup' },
      { name: 'olive oil', amount: '1 tbsp' }
    ]
  );
});

test('recipe text lists hide numbering structure while accepting pasted bullets and numbers', () => {
  assert.equal(formatRecipeTextList(['Warm the lentils.', 'Finish with lemon.']), 'Warm the lentils.\nFinish with lemon.');
  assert.deepEqual(
    parseRecipeTextList('1. Warm the lentils.\n2) Finish with lemon.\n• Taste before serving.'),
    ['Warm the lentils.', 'Finish with lemon.', 'Taste before serving.']
  );
});

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
