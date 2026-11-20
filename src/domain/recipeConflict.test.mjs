import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_STATE } from './defaults.ts';
import {
  keepWorkspaceRecipeVersion,
  recipeConflictCopyId,
  recipeCopyFromConflict,
  recipeSnapshotFromConflict,
  sameRecipeConflictCopy
} from './recipeConflict.ts';

const conflict = {
  id: 'recipe-conflict-1a2b3c',
  recipe_id: 'shared-recipe',
  created_at: '2026-11-12T20:00:00.000Z',
  attempted_json: JSON.stringify({
    id: 'shared-recipe',
    title: 'My lentils',
    description: 'Keep the original wording.',
    portions: 3,
    notes: ['A note'],
    ingredients: [
      { id: 'ingredient-one', name: 'lentils', amount: '1 cup', needsShopping: true, metadata: { note: 'first line' } },
      { id: 'ingredient-two', name: 'lentils', amount: '2 cups', needsShopping: false, metadata: { source: 'second line' } }
    ],
    steps: [{ id: 'step-one', text: 'Soak.' }, { id: 'step-two', text: 'Cook.' }]
  })
};

test('recipe conflict copy has a stable new recipe ID and preserves attempted content and nested identities', () => {
  const copy = recipeCopyFromConflict(conflict);
  assert.ok(copy);
  assert.equal(copy.id, recipeConflictCopyId(conflict.id));
  assert.notEqual(copy.id, conflict.recipe_id);
  assert.equal(copy.title, 'My lentils');
  assert.equal(copy.description, 'Keep the original wording.');
  assert.equal(copy.portions, 3);
  assert.deepEqual(copy.notes, ['A note']);
  assert.deepEqual(copy.ingredients.map(({ id, name, amount, needsShopping }) => ({ id, name, amount, needsShopping })), [
    { id: 'ingredient-one', name: 'lentils', amount: '1 cup', needsShopping: true },
    { id: 'ingredient-two', name: 'lentils', amount: '2 cups', needsShopping: false }
  ]);
  assert.equal(copy.ingredients[0].note, 'first line');
  assert.equal(copy.ingredients[1].source, 'second line');
  assert.deepEqual(copy.steps, ['Soak.', 'Cook.']);
  assert.deepEqual(copy.stepIds, ['step-one', 'step-two']);
  assert.equal(copy.createdAt, conflict.created_at);
  assert.equal(copy.updatedAt, conflict.created_at);
  assert.equal(sameRecipeConflictCopy(copy, recipeCopyFromConflict(conflict)), true);
});

test('deletion and malformed recipe conflicts cannot be offered as recipe copies', () => {
  assert.equal(recipeCopyFromConflict({ ...conflict, attempted_json: JSON.stringify({ action: 'delete', recipeId: 'shared-recipe' }) }), null);
  assert.equal(recipeCopyFromConflict({ ...conflict, attempted_json: '{' }), null);
  assert.equal(recipeCopyFromConflict({ ...conflict, attempted_json: JSON.stringify({ ...JSON.parse(conflict.attempted_json), ingredients: [] }) }), null);
});

test('recovery copy identity rejects oversized conflict keys', () => {
  assert.throws(() => recipeConflictCopyId('x'.repeat(181)), /invalid recovery identity/);
});

const workspaceRecipe = {
  id: 'shared-recipe',
  title: 'Owner version',
  description: 'Accepted workspace text.',
  portions: 4,
  notes: ['Server note'],
  ingredients: [{ id: 'server-ingredient', name: 'lentils', amount: '2 cups', needsShopping: true, metadata: { source: 'server' } }],
  steps: [{ id: 'server-step', text: 'Cook slowly.' }],
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-12T20:05:00.000Z',
  deletedAt: null,
  version: 2
};

test('workspace conflict snapshot retains server version, recipe and nested identities', () => {
  const snapshot = recipeSnapshotFromConflict({
    ...conflict,
    current_json: JSON.stringify(workspaceRecipe)
  });
  assert.ok(snapshot);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.deletedAt, null);
  assert.equal(snapshot.recipe?.title, 'Owner version');
  assert.equal(snapshot.recipe?.description, 'Accepted workspace text.');
  assert.deepEqual(snapshot.recipe?.ingredients[0], {
    id: 'server-ingredient', name: 'lentils', amount: '2 cups', needsShopping: true, source: 'server'
  });
  assert.deepEqual(snapshot.recipe?.stepIds, ['server-step']);
  assert.deepEqual(snapshot.recipe?.steps, ['Cook slowly.']);
});

test('workspace conflict resolution replaces only the conflicted recipe and leaves personal and shopping state intact', () => {
  const original = {
    ...DEFAULT_STATE,
    recipes: [
      { ...recipeCopyFromConflict(conflict), id: 'shared-recipe', title: 'Editor version' },
      { ...recipeCopyFromConflict(conflict), id: 'other-recipe', title: 'Unrelated recipe' }
    ],
    chatMessages: [{ id: 'private-message', role: 'user', content: 'private text', createdAt: '2026-11-12T20:00:00.000Z' }],
    shopping: { ...DEFAULT_STATE.shopping, lists: [{ id: 'list-one', name: 'Groceries', currentCycleId: 'cycle-one', createdAt: '2026-11-12T19:00:00.000Z', updatedAt: '2026-11-12T19:00:00.000Z' }] }
  };
  const result = keepWorkspaceRecipeVersion(original, {
    ...conflict,
    current_json: JSON.stringify(workspaceRecipe)
  });
  assert.ok(result);
  assert.equal(result.snapshot.version, 2);
  assert.deepEqual(new Set(result.state.recipes.map((recipe) => recipe.id)), new Set(['shared-recipe', 'other-recipe']));
  assert.equal(result.state.recipes.find((recipe) => recipe.id === 'shared-recipe').title, 'Owner version');
  assert.equal(result.state.recipes.find((recipe) => recipe.id === 'other-recipe').title, 'Unrelated recipe');
  assert.deepEqual(result.state.chatMessages, original.chatMessages);
  assert.deepEqual(result.state.shopping, original.shopping);
});

test('deleted or absent workspace versions remove the local recipe, while malformed snapshots remain unresolved', () => {
  const original = { ...DEFAULT_STATE, recipes: [{ ...recipeCopyFromConflict(conflict), id: 'shared-recipe' }] };
  const deleted = keepWorkspaceRecipeVersion(original, {
    ...conflict,
    current_json: JSON.stringify({ ...workspaceRecipe, deletedAt: '2026-11-12T20:10:00.000Z' })
  });
  assert.ok(deleted);
  assert.equal(deleted.snapshot.recipe, null);
  assert.deepEqual(deleted.state.recipes, []);

  const absent = keepWorkspaceRecipeVersion(original, { ...conflict, current_json: 'null' });
  assert.ok(absent);
  assert.deepEqual(absent.state.recipes, []);
  assert.equal(keepWorkspaceRecipeVersion(original, { ...conflict, current_json: '{' }), null);
  assert.equal(keepWorkspaceRecipeVersion(original, { ...conflict, recipe_id: 'different-recipe', current_json: JSON.stringify(workspaceRecipe) }), null);
});
