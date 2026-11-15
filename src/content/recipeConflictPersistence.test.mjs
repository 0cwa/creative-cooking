import assert from 'node:assert/strict';
import test from 'node:test';
import { commitRecipeConflictSplit } from './recipeConflictPersistence.ts';

class TransactionalOutboxFixture {
  rows;
  proposalActions;
  failOnRemainderInsert = false;

  constructor(rows, proposalActions = []) {
    this.rows = structuredClone(rows);
    this.proposalActions = structuredClone(proposalActions);
  }

  async writeTransaction(callback) {
    const staged = structuredClone(this.rows);
    const stagedActions = structuredClone(this.proposalActions);
    const transaction = {
      getOptional: async (_query, [id]) => staged.find((row) => row.id === id) ?? null,
      execute: async (query, values) => {
        if (query.startsWith('UPDATE local_content_outbox')) {
          const row = staged.find((entry) => entry.id === values[2]);
          if (row) [row.state, row.error_json] = values;
          return;
        }
        if (query.startsWith('UPDATE local_proposal_actions')) {
          const [spaceId, mutationId, errorJson, updatedAt] = values;
          for (const action of stagedActions) {
            if ((action.space_id === spaceId && action.effect_mutation_id === mutationId)
              || (action.personal_space_id === spaceId && action.status_mutation_id === mutationId)) {
              action.stage = action.personal_space_id === spaceId && action.status_mutation_id === mutationId
                ? 'status-blocked' : 'effect-blocked';
              action.error_json = errorJson;
              action.updated_at = updatedAt;
            }
          }
          return;
        }
        if (query.startsWith('INSERT INTO local_content_outbox')) {
          if (this.failOnRemainderInsert) throw new Error('Synthetic quota failure during remainder insert.');
          const [id, space_id, mutation_id, payload_json, state, error_json, created_at] = values;
          staged.push({ id, space_id, mutation_id, payload_json, state, error_json, created_at });
          return;
        }
        throw new Error(`Unexpected SQL in fixture: ${query}`);
      }
    };
    const result = await callback(transaction);
    this.rows = staged;
    this.proposalActions = stagedActions;
    return result;
  }
}

test('recipe-conflict transition and unrelated remainder roll back and retry together', async () => {
  const originalMutation = {
    mutationId: 'batch-original',
    operations: [
      { opId: 'recipe-op', type: 'recipe.save', recipe: { id: 'r-conflict', name: 'attempted' }, baseVersion: 1 },
      { opId: 'pantry-op', type: 'pantry.add', item: { id: 'p-keep', name: 'lentils' } }
    ]
  };
  const remainder = {
    mutationId: 'batch-original-remaining',
    operations: [{ opId: 'batch-original-remaining-op-1', type: 'pantry.add', item: { id: 'p-keep', name: 'lentils' } }]
  };
  const db = new TransactionalOutboxFixture([{
    id: originalMutation.mutationId,
    space_id: 'space-one',
    mutation_id: originalMutation.mutationId,
    payload_json: JSON.stringify(originalMutation),
    state: 'pending',
    error_json: null
  }], [{
    id: 'proposal-action',
    space_id: 'space-one',
    personal_space_id: 'personal-one',
    effect_mutation_id: originalMutation.mutationId,
    status_mutation_id: 'status-mutation',
    stage: 'effect-pending',
    error_json: null
  }]);
  const input = {
    rowId: originalMutation.mutationId,
    spaceId: 'space-one',
    mutationId: originalMutation.mutationId,
    error: { code: 'RECIPE_VERSION_CONFLICT' },
    remainder
  };

  db.failOnRemainderInsert = true;
  await assert.rejects(commitRecipeConflictSplit(db, input), /Synthetic quota failure/);
  assert.deepEqual(db.rows.map(({ id, state }) => ({ id, state })), [
    { id: originalMutation.mutationId, state: 'pending' }
  ]);
  assert.equal(db.proposalActions[0].stage, 'effect-pending');

  db.failOnRemainderInsert = false;
  await commitRecipeConflictSplit(db, input);
  assert.deepEqual(db.rows.map(({ id, state }) => ({ id, state })), [
    { id: originalMutation.mutationId, state: 'conflict' },
    { id: remainder.mutationId, state: 'pending' }
  ]);
  assert.equal(db.proposalActions[0].stage, 'effect-blocked');
  assert.equal(db.rows[1].payload_json, JSON.stringify(remainder));

  await commitRecipeConflictSplit(db, input);
  assert.equal(db.rows.length, 2);
  assert.equal(db.proposalActions[0].stage, 'effect-blocked');
  assert.equal(db.rows[1].payload_json, JSON.stringify(remainder));
});
