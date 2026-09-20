import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRecipeAllergies } from './allergyValidation.ts';

const check = (ingredient, allergies) =>
  validateRecipeAllergies([{ name: ingredient }], allergies);

test('blocks direct matches across singular and plural forms', () => {
  const result = check('Roasted peanut butter', ['peanuts']);
  assert.equal(result.ok, false);
  assert.equal(result.matches[0]?.kind, 'direct');
});

test('blocks common ingredient aliases', () => {
  const result = check('Cold-pressed groundnut oil', ['peanut']);
  assert.equal(result.ok, false);
  assert.equal(result.matches[0]?.kind, 'alias');
});

test('expands broad allergen categories conservatively', () => {
  const result = check('Almond flour', ['tree nuts']);
  assert.equal(result.ok, false);
  assert.equal(result.matches[0]?.matchedTerm, 'almond');
});

test('flags likely derived-food matches rather than accepting them', () => {
  const result = check('Mayonnaise', ['egg']);
  assert.equal(result.ok, false);
  assert.equal(result.matches[0]?.kind, 'possible');
});

test('treats broad nuts wording conservatively without conflating tree nuts and peanuts', () => {
  assert.equal(check('Peanut butter', ['nuts']).ok, false);
  assert.equal(check('Peanut butter', ['tree nuts']).ok, true);
});

test('does not use unsafe substring matching', () => {
  assert.equal(check('Eggplant', ['egg']).ok, true);
  assert.equal(check('Buckwheat flour', ['wheat']).ok, true);
  assert.equal(check('Nutmeg', ['nut']).ok, true);
  assert.equal(check('Milkfish', ['milk']).ok, true);
});

test('honors explicit allergen-free ingredient labels', () => {
  assert.equal(check('Gluten-free soy sauce', ['gluten']).ok, true);
  assert.equal(check('Dairy-free cheese alternative', ['dairy']).ok, true);
});
