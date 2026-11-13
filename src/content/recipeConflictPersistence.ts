import type { CommonPowerSyncDatabase } from '@powersync/common';
import type { ContentMutationRequest } from '../account/contracts';

/** Commit a recipe-conflict split as one local transaction so unrelated edits remain retryable. */
export async function commitRecipeConflictSplit(
  db: CommonPowerSyncDatabase,
  input: {
    rowId: string;
    spaceId: string;
    mutationId: string;
    error: unknown;
    remainder: ContentMutationRequest | null;
  }
): Promise<void> {
  await db.writeTransaction(async (transaction) => {
    const original = await transaction.getOptional<{
      space_id: string;
      mutation_id: string;
      state: string;
    }>(
      'SELECT space_id, mutation_id, state FROM local_content_outbox WHERE id = ?',
      [input.rowId]
    );
    if (!original || original.space_id !== input.spaceId || original.mutation_id !== input.mutationId) {
      throw new Error('The recipe-conflict outbox row changed before its local recovery transaction.');
    }
    if (original.state !== 'pending' && original.state !== 'conflict') {
      throw new Error('The recipe-conflict outbox row is no longer pending recovery.');
    }

    const errorJson = JSON.stringify(input.error);
    await transaction.execute(
      'UPDATE local_content_outbox SET state = ?, error_json = ? WHERE id = ?',
      ['conflict', errorJson, input.rowId]
    );
    await transaction.execute(
      `UPDATE local_proposal_actions SET stage = CASE WHEN personal_space_id = ? AND status_mutation_id = ?
           THEN 'status-blocked' ELSE 'effect-blocked' END,
         error_json = ?, updated_at = ?
       WHERE (space_id = ? AND effect_mutation_id = ?) OR (personal_space_id = ? AND status_mutation_id = ?)`,
      [input.spaceId, input.mutationId, errorJson, new Date().toISOString(), input.spaceId, input.mutationId, input.spaceId, input.mutationId]
    );

    if (!input.remainder) return;
    const payloadJson = JSON.stringify(input.remainder);
    const existing = await transaction.getOptional<{
      space_id: string;
      mutation_id: string;
      payload_json: string;
    }>(
      'SELECT space_id, mutation_id, payload_json FROM local_content_outbox WHERE id = ?',
      [input.remainder.mutationId]
    );
    if (existing) {
      if (existing.space_id !== input.spaceId
        || existing.mutation_id !== input.remainder.mutationId
        || existing.payload_json !== payloadJson) {
        throw new Error('The saved recipe-conflict remainder identity has different content.');
      }
      return;
    }
    await transaction.execute(
      `INSERT INTO local_content_outbox
       (id, space_id, mutation_id, payload_json, state, error_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.remainder.mutationId, input.spaceId, input.remainder.mutationId, payloadJson, 'pending', null, new Date().toISOString()]
    );
  });
}
