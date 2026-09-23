import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChefProposal, executeChefTool } from './toolExecution.ts';

function createExecutor() {
  const state = {
    added: [],
    updated: [],
    removed: [],
    preferences: [],
    recipes: [],
    proposals: []
  };

  const tools = {
    addPantry(names, preference) {
      state.added.push({ names, preference });
    },
    updatePantry(name, newName) {
      state.updated.push({ name, newName });
      return true;
    },
    removePantry(name) {
      state.removed.push(name);
      return true;
    },
    setPantryPreference(name, preference) {
      state.preferences.push({ name, preference });
      return true;
    },
    saveRecipe(recipe) {
      state.recipes.push(recipe);
      return { ...recipe, id: 'recipe-1', createdAt: 'now', updatedAt: 'now' };
    },
    propose(proposal) {
      state.proposals.push(proposal);
    }
  };

  return { state, tools };
}

test('proposed pantry changes are captured without mutating state until accepted', () => {
  const { state, tools } = createExecutor();
  const outcome = executeChefTool({
    id: 'call-1',
    name: 'pantry_add',
    arguments: JSON.stringify({ names: ['mint (dried)'], propose: true })
  }, tools);

  assert.deepEqual(JSON.parse(outcome.result), { ok: true, proposed: true });
  assert.equal(outcome.sideEffectApplied, false);
  assert.equal(state.added.length, 0);
  assert.equal(state.proposals.length, 1);
  assert.equal(state.proposals[0].toolName, 'pantry_add');
  assert.equal(state.proposals[0].status, 'pending');

  const applied = applyChefProposal(state.proposals[0], tools);
  assert.equal(JSON.parse(applied.result).ok, true);
  assert.equal(applied.sideEffectApplied, true);
  assert.deepEqual(state.added, [{ names: ['mint (dried)'], preference: 3 }]);
  assert.equal(state.proposals.length, 1);
});

test('forceProposals intercepts mutation tools even when the model does not request confirmation', () => {
  const { state, tools } = createExecutor();
  tools.forceProposals = true;

  executeChefTool({
    id: 'call-2',
    name: 'pantry_remove',
    arguments: JSON.stringify({ name: 'milk' })
  }, tools);

  assert.deepEqual(state.removed, []);
  assert.equal(state.proposals.length, 1);
  assert.equal(state.proposals[0].toolName, 'pantry_remove');
});

test('recipe proposals stay unsaved until accepted', () => {
  const { state, tools } = createExecutor();
  executeChefTool({
    id: 'call-3',
    name: 'recipe_save',
    arguments: JSON.stringify({
      title: 'Crispy chickpeas',
      portions: 2,
      ingredients: [{ name: 'chickpeas' }],
      steps: ['Roast until crisp.'],
      propose: true
    })
  }, tools);

  assert.equal(state.recipes.length, 0);
  assert.equal(state.proposals.length, 1);

  applyChefProposal(state.proposals[0], tools);
  assert.equal(state.recipes.length, 1);
  assert.equal(state.recipes[0].title, 'Crispy chickpeas');
});
