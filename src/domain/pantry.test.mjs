import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPantryForChef, normalizeIngredientName, parseIngredientInput } from './pantry.ts';

test('normalizes whitespace and parses a deduplicated ingredient list', () => {
  assert.equal(normalizeIngredientName('  green   onions  '), 'green onions');
  assert.deepEqual(
    parseIngredientInput('Carrots, green onions\ncarrots;  Tofu  '),
    ['Carrots', 'green onions', 'Tofu']
  );
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
