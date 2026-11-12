import type { CommonPowerSyncDatabase, CrudEntry, PowerSyncBackendConnector } from '@powersync/common';
import { AccountApiError } from '../account/api';
import {
  fetchPowerSyncCredential,
  getAccountWorkspaceSnapshot,
  submitContentMutation
} from '../account/accountWorkspace';
import type { ContentMutationOperation, ContentMutationRequest } from '../account/contracts';
import {
  acknowledgeContentMutation,
  enqueueContentMutation,
  listPendingContentMutations,
  recordLocalRecipeConflict,
  recordLocalSyncIssue,
  updateContentMutationState
} from './contentStore';
import { createContentOutboxDrain } from './outboxDrain.ts';
import { withOperationIds } from './mutations';

function mutationFromJson(value: string): ContentMutationRequest {
  const parsed = JSON.parse(value) as ContentMutationRequest;
  if (!parsed || typeof parsed.mutationId !== 'string' || !Array.isArray(parsed.operations)) {
    throw new Error('A saved content upload could not be read. Its local copy is preserved.');
  }
  return parsed;
}
function spaceIdsFromCrud(crud: CrudEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of crud) {
    const spaceId = entry.opData?.space_id ?? entry.previousValues?.space_id;
    if (typeof spaceId === 'string' && spaceId) ids.add(spaceId);
  }
  return [...ids];
}

function conflictData(error: AccountApiError): {
  conflicts: Array<{ recipeId: string; attempted: unknown; current: unknown }>;
} | null {
  if (error.code !== 'RECIPE_VERSION_CONFLICT' || !error.payload || typeof error.payload !== 'object') return null;
  const conflicts = (error.payload as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts)) return null;
  return {
    conflicts: conflicts.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as { recipeId?: unknown; attempted?: unknown; current?: unknown };
      if (typeof item.recipeId !== 'string') return [];
      return [{ recipeId: item.recipeId, attempted: item.attempted, current: item.current }];
    })
  };
}

function stableRemainderId(mutationId: string): string {
  return `${mutationId.slice(0, 112)}-remaining`;
}

async function handleRecipeConflict(
  db: CommonPowerSyncDatabase,
  spaceId: string,
  row: { id: string; mutation_id: string; payload_json: string },
  error: AccountApiError
): Promise<void> {
  const parsed = mutationFromJson(row.payload_json);
  const data = conflictData(error);
  if (!data?.conflicts.length) {
    await updateContentMutationState(db, row.id, 'blocked', error.payload);
    await recordLocalSyncIssue(db, {
      spaceId,
      type: 'recipe-conflict-response-invalid',
      message: 'The server reported a recipe conflict without enough detail to show both versions. The local edits were kept.',
      data: { mutationId: row.mutation_id, response: error.payload }
    });
    return;
  }

  const conflictedIds = new Set(data.conflicts.map((conflict) => conflict.recipeId));
  for (const conflict of data.conflicts) {
    await recordLocalRecipeConflict(db, {
      spaceId,
      recipeId: conflict.recipeId,
      attempted: conflict.attempted,
      current: conflict.current,
      reason: 'The server accepted a newer version of this recipe. Both versions are preserved for review.'
    });
  }
  await updateContentMutationState(db, row.id, 'conflict', error.payload);

  const remaining = parsed.operations.filter((operation) => !isConflictedRecipe(operation, conflictedIds));
  if (remaining.length) {
    const mutationId = stableRemainderId(parsed.mutationId);
    await enqueueContentMutation(db, spaceId, {
      mutationId,
      operations: withOperationIds(mutationId, remaining)
    });
  }
}

function isConflictedRecipe(operation: ContentMutationOperation, ids: Set<string>): boolean {
  if (operation.type === 'recipe.save') return ids.has(operation.recipe.id);
  if (operation.type === 'recipe.delete') return ids.has(operation.id);
  return false;
}

function responseIssues(value: unknown): Array<{ type: string; message: string; data: unknown }> {
  if (!value || typeof value !== 'object') return [];
  const operations = (value as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((result) => {
    if (!result || typeof result !== 'object') return [];
    const row = result as { status?: unknown; reason?: unknown; entityId?: unknown };
    if (row.status !== 'ignored' || typeof row.reason !== 'string') return [];
    if (!['stale_cycle', 'stale_items', 'not_found'].includes(row.reason)) return [];
    return [{
      type: `server-${row.reason}`,
      message: 'The server safely ignored an edit for a removed item or older shopping cycle. Review the saved workspace state.',
      data: result
    }];
  });
}

function ignoredOperations(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const operations = (value as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return [];
  return operations.filter((result) => (
    result && typeof result === 'object' && (result as { status?: unknown }).status === 'ignored'
  ));
}

async function uploadPendingForSpace(db: CommonPowerSyncDatabase, spaceId: string): Promise<void> {
  while (true) {
    const [row] = await listPendingContentMutations(db, spaceId);
    if (!row) return;
    const mutation = mutationFromJson(row.payload_json);
    try {
      const response = await submitContentMutation(spaceId, mutation);
      for (const issue of responseIssues(response)) await recordLocalSyncIssue(db, { spaceId, ...issue });
      const ignored = ignoredOperations(response);
      if (row.mutation_id.startsWith('guest-adoption-v2-') && ignored.length > 0) {
        await updateContentMutationState(db, row.id, 'blocked', {
          code: 'ADOPTION_OPERATION_IGNORED',
          operations: ignored
        });
        await recordLocalSyncIssue(db, {
          spaceId,
          type: 'adoption-operation-ignored',
          message: 'The server did not apply every guest-adoption operation. The migration remains incomplete and the local source archive is preserved.',
          data: { mutationId: row.mutation_id, operations: ignored }
        });
        return;
      }
      await acknowledgeContentMutation(db, row.id);
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 409) {
        const conflict = conflictData(error);
        if (conflict) {
          await handleRecipeConflict(db, spaceId, row, error);
          continue;
        }
      }

      if (error instanceof AccountApiError && error.status === 401) throw error;
      if (error instanceof AccountApiError && (error.status === 403 || error.status === 400 || error.status === 404 || error.status === 409 || error.status === 422)) {
        await updateContentMutationState(db, row.id, 'blocked', { code: error.code, message: error.message, payload: error.payload });
        await recordLocalSyncIssue(db, {
          spaceId,
          type: `upload-${error.code ?? error.status}`,
          message: 'The server did not accept a workspace edit. The local copy and upload details are preserved for review.',
          data: { mutationId: row.mutation_id, code: error.code, payload: error.payload }
        });
        return;
      }
      throw error;
    }
  }
}

const outboxDrains = new WeakMap<CommonPowerSyncDatabase, () => Promise<void>>();

async function drainPendingOutboxes(db: CommonPowerSyncDatabase): Promise<void> {
  while (true) {
    const pending = await listPendingContentMutations(db);
    if (!pending.length) return;
    const account = getAccountWorkspaceSnapshot();
    if (account.status !== 'signed-in' || !account.user) {
      throw new Error('The account session must be confirmed before workspace changes can upload.');
    }
    for (const spaceId of [...new Set(pending.map((row) => row.space_id))]) {
      await uploadPendingForSpace(db, spaceId);
    }
  }
}

/** Drain durable account outboxes after app restart or an independent effect transaction. */
export function flushPendingContentMutations(db: CommonPowerSyncDatabase): Promise<void> {
  let drain = outboxDrains.get(db);
  if (!drain) {
    drain = createContentOutboxDrain(() => drainPendingOutboxes(db));
    outboxDrains.set(db, drain);
  }
  return drain();
}

export function createPowerSyncConnector(db: CommonPowerSyncDatabase): PowerSyncBackendConnector {
  return {
    fetchCredentials: async () => {
      const account = getAccountWorkspaceSnapshot();
      if (account.status !== 'signed-in' || !account.user) return null;
      return fetchPowerSyncCredential();
    },
    uploadData: async (database) => {
      while (true) {
        const transaction = await database.getNextCrudTransaction();
        if (!transaction) {
          // local_content_outbox is local-only. A later stage can be enqueued
          // while acknowledging another workspace's CRUD transaction, so it
          // must be drained even when no new PowerSync row change remains.
          await flushPendingContentMutations(db);
          return;
        }
        const spaces = spaceIdsFromCrud(transaction.crud);
        if (spaces.length) {
          const account = getAccountWorkspaceSnapshot();
          if (account.status !== 'signed-in' || !account.user) {
            throw new Error('The account session must be confirmed before workspace changes can upload.');
          }
        }
        await flushPendingContentMutations(db);
        await transaction.complete();
      }
    }
  };
}
