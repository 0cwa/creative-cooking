import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalFingerprint, proposalPresentation } from './proposals.ts';

function proposal(toolName, args) {
  return {
    id: 'proposal-1',
    toolName,
    arguments: JSON.stringify(args),
    status: 'pending'
  };
}

test('recipe proposals expose a compact preview and add action', () => {
  const view = proposalPresentation(proposal('recipe_save', {
    title: 'Sesame noodles',
    portions: 2,
    ingredients: [
      { name: 'noodles', amount: '200 g' },
      { name: 'sesame oil', amount: '1 tbsp' }
    ],
    steps: ['Boil noodles.', 'Toss with sesame oil.'],
    propose: true
  }));

  assert.equal(view.kind, 'recipe');
  assert.equal(view.title, 'Sesame noodles');
  assert.match(view.summary, /2 portions/);
  assert.match(view.summary, /2 ingredients/);
  assert.equal(view.actionLabel, 'Add recipe');
  assert.equal(view.recipe?.steps.length, 2);
});

test('pantry proposal copy stays short and action-oriented', () => {
  const update = proposalPresentation(proposal('pantry_update', {
    name: 'mint',
    newName: 'mint (dried)',
    propose: true
  }));
  assert.equal(update.title, 'Update Pantry item');
  assert.equal(update.summary, 'mint → mint (dried)');
  assert.equal(update.actionLabel, 'Update');

  const remove = proposalPresentation(proposal('pantry_remove', {
    name: 'old spinach',
    propose: true
  }));
  assert.equal(remove.actionTone, 'destructive');
  assert.equal(remove.summary, 'old spinach');
});

test('proposal fingerprints ignore only the propose flag', () => {
  const first = proposal('pantry_add', { names: ['milk'], propose: true });
  const second = proposal('pantry_add', { names: ['milk'], propose: false });
  const third = proposal('pantry_add', { names: ['eggs'], propose: true });

  assert.equal(proposalFingerprint(first), proposalFingerprint(second));
  assert.notEqual(proposalFingerprint(first), proposalFingerprint(third));
});
