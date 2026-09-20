import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pantryNamesFromToolArgs,
  parseToolArguments,
  preferenceFromToolValue,
  questionFromToolArgs,
  recipeFromToolArgs
} from './toolPayload.ts';

test('invalid tool JSON degrades to an empty argument object', () => {
  assert.deepEqual(parseToolArguments('{bad json'), {});
  assert.deepEqual(parseToolArguments('[]'), {});
});

test('pantry payloads filter non-strings and clamp invalid preferences to neutral', () => {
  assert.deepEqual(pantryNamesFromToolArgs({ names: ['carrots', 42, '', 'tofu'] }), ['carrots', 'tofu']);
  assert.equal(preferenceFromToolValue(5), 5);
  assert.equal(preferenceFromToolValue(0), 3);
  assert.equal(preferenceFromToolValue('not-a-rating'), 3);
});

test('recipe payload normalization drops malformed structured fields', () => {
  const recipe = recipeFromToolArgs({
    title: '  Soup  ',
    portions: 0,
    ingredients: [
      { name: ' carrots ', amount: '2', needsShopping: false },
      { name: '', amount: '1' },
      'not-an-object'
    ],
    steps: ['Chop', 123, ''],
    notes: ['Serve hot', null]
  });

  assert.equal(recipe.title, 'Soup');
  assert.equal(recipe.portions, 2);
  assert.deepEqual(recipe.ingredients, [{ name: 'carrots', amount: '2', needsShopping: false }]);
  assert.deepEqual(recipe.steps, ['Chop']);
  assert.deepEqual(recipe.notes, ['Serve hot']);
});

test('questions cap options and supply safe defaults for unusable payloads', () => {
  assert.deepEqual(questionFromToolArgs({ prompt: '', options: ['only one'] }, 'q1'), {
    id: 'q1',
    prompt: 'Which option do you prefer?',
    options: ['First option', 'Second option']
  });

  assert.equal(
    questionFromToolArgs({ prompt: 'Pick one', options: ['1', '2', '3', '4', '5', '6'] }, 'q2').options.length,
    5
  );
});
