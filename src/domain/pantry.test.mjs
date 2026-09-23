import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPantryForChef, normalizeIngredientName, parseIngredientInput, updatePantryItemName } from './pantry.ts';

test('normalizes whitespace and parses a deduplicated ingredient list', () => {
  assert.equal(normalizeIngredientName('  green   onions  '), 'green onions');
  assert.deepEqual(
    parseIngredientInput('Carrots, green onions\ncarrots;  Tofu  '),
    ['Carrots', 'green onions', 'Tofu']
  );
});

test('updates pantry descriptions without losing preference or creating duplicates', () => {
  const items = [
    { id: 'mint', name: 'mint', preference: 5, createdAt: 'old', updatedAt: 'old' },
    { id: 'okra', name: 'okra (frozen)', preference: 3, createdAt: 'old', updatedAt: 'old' }
  ];

  const renamed = updatePantryItemName(items, 'mint', 'mint (dried)');
  assert.equal(renamed.updated, true);
  assert.equal(renamed.items[0].id, 'mint');
  assert.equal(renamed.items[0].name, 'mint (dried)');
  assert.equal(renamed.items[0].preference, 5);
  assert.equal(renamed.items[0].createdAt, 'old');
  assert.notEqual(renamed.items[0].updatedAt, 'old');

  const duplicate = updatePantryItemName(renamed.items, 'mint (dried)', 'okra (frozen)');
  assert.equal(duplicate.updated, false);
  assert.deepEqual(duplicate.items, renamed.items);
});

test('groups pantry items in preference order with explicit empty groups', () => {
  const items = [
    { id: '1', name: 'carrots', preference: 5, createdAt: '', updatedAt: '' },
    { id: '2', name: 'tofu', preference: 3, createdAt: '', updatedAt: '' },
    { id: '3', name: 'olives', preference: 1, createdAt: '', updatedAt: '' }
  ];

  const grouped = groupPantryForChef(items);
  assert.ok(grouped.indexOf('Would like to eat') < grouped.indexOf('Open to eating'));
  assert.match(grouped, /Would like to eat:\n- carrots/);
  assert.match(grouped, /Would probably like eating:\n- \(none\)/);
  assert.match(grouped, /Open to eating:\n- tofu/);
  assert.match(grouped, /Don't want to eat:\n- olives/);
});
