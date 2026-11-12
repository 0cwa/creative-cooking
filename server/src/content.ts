import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { ApiFault, requireAuth, requireMembershipInTransaction, transaction } from './authz.js';
import type { ServerConfig } from './config.js';
import { contentStorageId } from './contentIdentity.js';
import {
  applyPersonalContentOperation,
  findPersonalContentConflicts,
  isPersonalContentOperation,
  personalContentOperationSchema,
  type PersonalContentOperation,
} from './personalContent.js';
import { issuePowerSyncJwt, powerSyncJwks } from './syncAuth.js';

const textId = z.string().trim().min(1).max(200);
const opId = z.string().min(1).max(80);
const isoDate = z.string().datetime({ offset: true });
const baseVersion = z.number().int().min(0).nullable().optional();
const metadataSchema = z.record(z.string(), z.unknown()).optional();

const ingredientSchema = z.object({
  id: textId,
  name: z.string().trim().min(1).max(240),
  amount: z.string().max(300).nullable().optional(),
  needsShopping: z.boolean().optional(),
  metadata: metadataSchema,
}).strict();

const recipeStepSchema = z.object({
  id: textId,
  text: z.string().max(8000),
}).strict();

const recipeSchema = z.object({
  id: textId,
  title: z.string().trim().min(1).max(400),
  description: z.string().max(8000).nullable().optional(),
  portions: z.number().int().min(1).max(100),
  notes: z.array(z.string().max(3000)).max(100).default([]),
  ingredients: z.array(ingredientSchema).max(200),
  steps: z.array(recipeStepSchema).max(300),
}).strict().superRefine((recipe, context) => {
  for (const [key, rows] of [['ingredients', recipe.ingredients], ['steps', recipe.steps]] as const) {
    const ids = new Set<string>();
    rows.forEach((row, index) => {
      if (ids.has(row.id)) context.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'Nested row IDs must be unique.' });
      ids.add(row.id);
    });
  }
});

const pantryUpsertSchema = z.object({
  opId,
  type: z.literal('pantry.upsert'),
  id: textId,
  name: z.string().trim().min(1).max(240),
  preference: z.number().int().min(1).max(5),
}).strict();

const pantryDeleteSchema = z.object({
  opId,
  type: z.literal('pantry.delete'),
  id: textId,
}).strict();

const recipeSaveSchema = z.object({
  opId,
  type: z.literal('recipe.save'),
  baseVersion,
  recipe: recipeSchema,
}).strict();

const recipeDeleteSchema = z.object({
  opId,
  type: z.literal('recipe.delete'),
  id: textId,
  baseVersion: z.number().int().min(1),
}).strict();

const shoppingListCreateSchema = z.object({
  opId,
  type: z.literal('shopping.list.create'),
  list: z.object({
    id: textId,
    name: z.string().trim().min(1).max(120),
    currentCycleId: textId,
    createdAt: isoDate,
    updatedAt: isoDate,
  }).strict(),
  cycle: z.object({ id: textId, listId: textId, startedAt: isoDate }).strict(),
}).strict().superRefine((value, context) => {
  if (value.list.currentCycleId !== value.cycle.id || value.cycle.listId !== value.list.id) {
    context.addIssue({ code: 'custom', path: ['cycle'], message: 'A new shopping list must point to its initial cycle.' });
  }
});

const shoppingListRenameSchema = z.object({
  opId,
  type: z.literal('shopping.list.rename'),
  id: textId,
  name: z.string().trim().min(1).max(120),
  updatedAt: isoDate,
}).strict();

const shoppingListRemoveSchema = z.object({
  opId,
  type: z.literal('shopping.list.remove'),
  id: textId,
  removedAt: isoDate.optional(),
}).strict();

const shoppingCycleStartSchema = z.object({
  opId,
  type: z.literal('shopping.cycle.start'),
  listId: textId,
  cycle: z.object({ id: textId, startedAt: isoDate }).strict(),
}).strict();

const shoppingItemUpsertSchema = z.object({
  opId,
  type: z.literal('shopping.item.upsert'),
  item: z.object({
    id: textId,
    listId: textId,
    name: z.string().trim().min(1).max(240),
    recipeId: textId.nullable().optional(),
    ingredientId: textId.nullable().optional(),
    displayQuantity: z.string().max(300).nullable().optional(),
    displayUnit: z.string().max(120).nullable().optional(),
    purchaseCycleId: textId,
    checked: z.boolean(),
    purchasedCycleId: textId.nullable().optional(),
    createdAt: isoDate,
    updatedAt: isoDate,
  }).strict(),
}).strict();

const shoppingItemCheckSchema = z.object({
  opId,
  type: z.literal('shopping.item.check'),
  id: textId,
  listId: textId,
  purchaseCycleId: textId,
  checked: z.boolean(),
}).strict();

const shoppingItemRemoveSchema = z.object({
  opId,
  type: z.literal('shopping.item.remove'),
  id: textId,
  listId: textId,
  purchaseCycleId: textId,
  removedAt: isoDate.optional(),
}).strict();

const shoppingPurchaseSchema = z.object({
  opId,
  type: z.literal('shopping.purchase'),
  purchase: z.object({
    id: textId,
    listId: textId,
    purchaseCycleId: textId,
    itemIds: z.array(textId).min(1).max(200),
    pantryItemIds: z.array(textId).max(200),
    purchasedAt: isoDate,
  }).strict(),
  pantryAdds: z.array(z.object({
    id: textId,
    name: z.string().trim().min(1).max(240),
    preference: z.number().int().min(1).max(5).default(3),
  }).strict()).max(200).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.purchase.itemIds).size !== value.purchase.itemIds.length) {
    context.addIssue({ code: 'custom', path: ['purchase', 'itemIds'], message: 'Purchase item IDs must be unique.' });
  }
  if (new Set(value.purchase.pantryItemIds).size !== value.purchase.pantryItemIds.length) {
    context.addIssue({ code: 'custom', path: ['purchase', 'pantryItemIds'], message: 'Purchase pantry IDs must be unique.' });
  }
});

const shoppingHistoryImportSchema = z.object({
  opId,
  type: z.literal('shopping.history.import'),
  listId: textId,
  currentCycleId: textId,
  cycles: z.array(z.object({ id: textId, startedAt: isoDate }).strict()).max(200),
  purchases: z.array(z.object({
    id: textId,
    purchaseCycleId: textId,
    itemIds: z.array(textId).max(200),
    pantryItemIds: z.array(textId).max(200),
    purchasedAt: isoDate,
  }).strict()).max(200),
}).strict().superRefine((value, context) => {
  if (value.cycles.some((cycle) => cycle.id === value.currentCycleId)) {
    context.addIssue({ code: 'custom', path: ['cycles'], message: 'The active shopping cycle cannot be imported as historical.' });
  }
  if (value.cycles.length === 0 && value.purchases.length === 0) {
    context.addIssue({ code: 'custom', path: ['cycles'], message: 'A history import must contain at least one cycle or purchase.' });
  }
});

const contentOperationSchema = z.discriminatedUnion('type', [
  pantryUpsertSchema,
  pantryDeleteSchema,
  recipeSaveSchema,
  recipeDeleteSchema,
  shoppingListCreateSchema,
  shoppingListRenameSchema,
  shoppingListRemoveSchema,
  shoppingCycleStartSchema,
  shoppingItemUpsertSchema,
  shoppingItemCheckSchema,
  shoppingItemRemoveSchema,
  shoppingPurchaseSchema,
  shoppingHistoryImportSchema,
  ...personalContentOperationSchema.options,
]);

const contentMutationSchema = z.object({
  mutationId: z.string().trim().min(1).max(128),
  operations: z.array(contentOperationSchema).min(1).max(100),
}).strict().superRefine((mutation, context) => {
  const seenOperations = new Set<string>();
  const seenRows = new Set<string>();
  const seenPersonalRows = new Set<string>();
  const personalConversationOperations = new Map<string, number>();
  const firstConversationCreate = new Map<string, number>();
  const firstAssistantMessage = new Map<string, number>();
  mutation.operations.forEach((operation, index) => {
    if (operation.type === 'personal.chat.conversation.create' && !firstConversationCreate.has(operation.conversation.id)) {
      firstConversationCreate.set(operation.conversation.id, index);
    }
    if (operation.type === 'personal.chat.message.append' && operation.message.role === 'assistant') {
      const key = JSON.stringify([operation.conversationId, operation.message.id]);
      if (!firstAssistantMessage.has(key)) firstAssistantMessage.set(key, index);
    }
  });
  mutation.operations.forEach((operation, index) => {
    if (seenOperations.has(operation.opId)) {
      context.addIssue({ code: 'custom', path: ['operations', index, 'opId'], message: 'Operation IDs must be unique in a mutation.' });
    }
    seenOperations.add(operation.opId);
    const rowKey = operation.type === 'recipe.save'
      ? `recipe:${operation.recipe.id}`
      : operation.type === 'recipe.delete' ? `recipe:${operation.id}` : null;
    if (rowKey && seenRows.has(rowKey)) {
      context.addIssue({ code: 'custom', path: ['operations', index], message: 'A recipe can be changed only once per mutation.' });
    }
    if (rowKey) seenRows.add(rowKey);

    let personalRowKey: string | null = null;
    let conversationId: string | null = null;
    if (operation.type === 'personal.preference.set') personalRowKey = `preference:${operation.field}`;
    if (operation.type === 'personal.allergy.set') personalRowKey = `allergy:${operation.name.trim().toLocaleLowerCase('en')}`;
    if (operation.type === 'personal.chat.conversation.create') {
      personalRowKey = `conversation:${operation.conversation.id}`;
      conversationId = operation.conversation.id;
    }
    if (operation.type === 'personal.chat.message.append') {
      personalRowKey = `message:${JSON.stringify([operation.conversationId, operation.message.id])}`;
      conversationId = operation.conversationId;
    }
    if (operation.type === 'personal.chat.proposal.create' || operation.type === 'personal.chat.proposal.setStatus') {
      personalRowKey = `proposal:${JSON.stringify([operation.conversationId, operation.messageId, operation.type === 'personal.chat.proposal.create' ? operation.proposal.id : operation.proposalId])}`;
      conversationId = operation.conversationId;
    }
    if (operation.type === 'personal.chat.conversation.delete') {
      personalRowKey = `conversation:${operation.id}`;
      conversationId = operation.id;
    }
    if (personalRowKey && seenPersonalRows.has(personalRowKey)) {
      context.addIssue({ code: 'custom', path: ['operations', index], message: 'A personal record can be changed only once per mutation.' });
    }
    if (personalRowKey) seenPersonalRows.add(personalRowKey);
    if (conversationId !== null) personalConversationOperations.set(conversationId, (personalConversationOperations.get(conversationId) ?? 0) + 1);

    if (operation.type === 'personal.chat.message.append') {
      const createIndex = firstConversationCreate.get(operation.conversationId);
      if (createIndex !== undefined && createIndex > index) {
        context.addIssue({ code: 'custom', path: ['operations', index], message: 'Create a conversation before appending its messages.' });
      }
    }
    if (operation.type === 'personal.chat.proposal.create') {
      const messageIndex = firstAssistantMessage.get(JSON.stringify([operation.conversationId, operation.messageId]));
      if (messageIndex !== undefined && messageIndex > index) {
        context.addIssue({ code: 'custom', path: ['operations', index], message: 'Append a proposal message before creating its proposals.' });
      }
    }
  });
  const deletedConversations = new Set(mutation.operations
    .filter((operation) => operation.type === 'personal.chat.conversation.delete')
    .map((operation) => operation.id));
  for (const conversationId of deletedConversations) {
    if ((personalConversationOperations.get(conversationId) ?? 0) > 1) {
      context.addIssue({ code: 'custom', path: ['operations'], message: 'Conversation deletion must be a separate mutation from changes to that conversation.' });
    }
  }
});

type ContentOperation = z.infer<typeof contentOperationSchema>;
type RecipePayload = z.infer<typeof recipeSchema>;
type MutationReply = { statusCode: number; body: Record<string, unknown> };

function fail(reply: import('fastify').FastifyReply, statusCode: number, code: string, message: string): void {
  reply.code(statusCode).send({ error: { code, message } });
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('en');
}

async function readRecipe(client: PoolClient, spaceId: string, recipeId: string, includeDeleted = false) {
  const found = await client.query<{
    id: string; title: string; description: string | null; portions: number; notes: string[];
    created_at: Date; updated_at: Date; deleted_at: Date | null; version: string;
  }>(
    `SELECT entity_id AS id, title, description, portions, notes, created_at, updated_at, deleted_at, version
     FROM recipes WHERE entity_id = $1 AND space_id = $2${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
    [recipeId, spaceId],
  );
  const recipe = found.rows[0];
  if (!recipe) return null;
  const [ingredients, steps] = await Promise.all([
    client.query<{
      id: string; name: string; amount: string | null; needs_shopping: boolean; metadata: Record<string, unknown>;
    }>(
      `SELECT entity_id AS id, name, amount, needs_shopping, metadata FROM recipe_ingredients
       WHERE space_id = $1 AND recipe_id = $2 AND deleted_at IS NULL ORDER BY position, id`,
      [spaceId, recipeId],
    ),
    client.query<{ id: string; text: string }>(
      `SELECT entity_id AS id, text FROM recipe_steps
       WHERE space_id = $1 AND recipe_id = $2 AND deleted_at IS NULL ORDER BY position, id`,
      [spaceId, recipeId],
    ),
  ]);
  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    portions: recipe.portions,
    notes: recipe.notes,
    ingredients: ingredients.rows.map((row) => ({
      id: row.id, name: row.name, amount: row.amount, needsShopping: row.needs_shopping, metadata: row.metadata,
    })),
    steps: steps.rows,
    createdAt: recipe.created_at.toISOString(),
    updatedAt: recipe.updated_at.toISOString(),
    deletedAt: recipe.deleted_at?.toISOString() ?? null,
    version: Number(recipe.version),
  };
}

async function saveRecipeChildren(
  client: PoolClient,
  userId: string,
  spaceId: string,
  recipe: RecipePayload,
): Promise<void> {
  const ingredientIds = recipe.ingredients.map((row) => row.id);
  const stepIds = recipe.steps.map((row) => row.id);
  await client.query(
    `UPDATE recipe_ingredients SET deleted_at = now(), updated_at = now(), version = version + 1, updated_by = $3
     WHERE space_id = $1 AND recipe_id = $2 AND deleted_at IS NULL AND NOT (entity_id = ANY($4::text[]))`,
    [spaceId, recipe.id, userId, ingredientIds],
  );
  await client.query(
    `UPDATE recipe_steps SET deleted_at = now(), updated_at = now(), version = version + 1, updated_by = $3
     WHERE space_id = $1 AND recipe_id = $2 AND deleted_at IS NULL AND NOT (entity_id = ANY($4::text[]))`,
    [spaceId, recipe.id, userId, stepIds],
  );
  for (const [position, ingredient] of recipe.ingredients.entries()) {
    const storageId = contentStorageId('recipe_ingredients', spaceId, recipe.id, ingredient.id);
    const existing = await client.query<{
      space_id: string; recipe_id: string; deleted_at: Date | null;
    }>('SELECT space_id, recipe_id, deleted_at FROM recipe_ingredients WHERE space_id = $1 AND recipe_id = $2 AND entity_id = $3 FOR UPDATE', [spaceId, recipe.id, ingredient.id]);
    const row = existing.rows[0];
    if (row && (row.space_id !== spaceId || row.recipe_id !== recipe.id || row.deleted_at)) {
      throw new ApiFault(409, 'RECIPE_CHILD_ID_REUSED', 'A removed or unrelated ingredient identity cannot be reused.');
    }
    if (row) {
      await client.query(
        `UPDATE recipe_ingredients SET position = $4, name = $5, amount = $6, needs_shopping = $7,
          metadata = $8::jsonb, updated_at = now(), version = version + 1, updated_by = $9
         WHERE space_id = $1 AND recipe_id = $2 AND entity_id = $3`,
        [spaceId, recipe.id, ingredient.id, position, ingredient.name, ingredient.amount ?? null, ingredient.needsShopping ?? false,
          JSON.stringify(ingredient.metadata ?? {}), userId],
      );
    } else {
      await client.query(
        `INSERT INTO recipe_ingredients(id, entity_id, space_id, recipe_id, position, name, amount, needs_shopping, metadata, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [storageId, ingredient.id, spaceId, recipe.id, position, ingredient.name, ingredient.amount ?? null,
          ingredient.needsShopping ?? false, JSON.stringify(ingredient.metadata ?? {}), userId],
      );
    }
  }
  for (const [position, step] of recipe.steps.entries()) {
    const storageId = contentStorageId('recipe_steps', spaceId, recipe.id, step.id);
    const existing = await client.query<{
      space_id: string; recipe_id: string; deleted_at: Date | null;
    }>('SELECT space_id, recipe_id, deleted_at FROM recipe_steps WHERE space_id = $1 AND recipe_id = $2 AND entity_id = $3 FOR UPDATE', [spaceId, recipe.id, step.id]);
    const row = existing.rows[0];
    if (row && (row.space_id !== spaceId || row.recipe_id !== recipe.id || row.deleted_at)) {
      throw new ApiFault(409, 'RECIPE_CHILD_ID_REUSED', 'A removed or unrelated step identity cannot be reused.');
    }
    if (row) {
      await client.query(
        `UPDATE recipe_steps SET position = $4, text = $5, updated_at = now(), version = version + 1, updated_by = $6
         WHERE space_id = $1 AND recipe_id = $2 AND entity_id = $3`,
        [spaceId, recipe.id, step.id, position, step.text, userId],
      );
    } else {
      await client.query(
        `INSERT INTO recipe_steps(id, entity_id, space_id, recipe_id, position, text, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [storageId, step.id, spaceId, recipe.id, position, step.text, userId],
      );
    }
  }
}

async function recordRecipeConflict(
  client: PoolClient,
  userId: string,
  spaceId: string,
  mutationId: string,
  op: Extract<ContentOperation, { type: 'recipe.save' | 'recipe.delete' }>,
  currentVersion: number,
): Promise<Record<string, unknown>> {
  const recipeId = op.type === 'recipe.save' ? op.recipe.id : op.id;
  const attemptedContent = op.type === 'recipe.save' ? op.recipe : { action: 'delete', recipeId };
  const inserted = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO recipe_conflicts(space_id, recipe_id, mutation_id, base_version, current_version, attempted_content, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id, created_at`,
    [spaceId, recipeId, mutationId, op.type === 'recipe.save' ? op.baseVersion ?? null : op.baseVersion,
      currentVersion, JSON.stringify(attemptedContent), userId],
  );
  return {
    id: inserted.rows[0]!.id,
    opId: op.opId,
    recipeId,
    baseVersion: op.type === 'recipe.save' ? op.baseVersion ?? null : op.baseVersion,
    currentVersion,
    attempted: attemptedContent,
    current: await readRecipe(client, spaceId, recipeId, true),
    createdAt: inserted.rows[0]!.created_at.toISOString(),
  };
}

async function findRecipeConflict(
  client: PoolClient,
  userId: string,
  spaceId: string,
  mutationId: string,
  operation: ContentOperation,
): Promise<Record<string, unknown> | null> {
  if (operation.type !== 'recipe.save' && operation.type !== 'recipe.delete') return null;
  const recipeId = operation.type === 'recipe.save' ? operation.recipe.id : operation.id;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`recipe:${spaceId}:${recipeId}`]);
  const found = await client.query<{ space_id: string; version: string; deleted_at: Date | null }>(
    'SELECT space_id, version, deleted_at FROM recipes WHERE space_id = $1 AND entity_id = $2 FOR UPDATE', [spaceId, recipeId],
  );
  const current = found.rows[0];
  if (current && current.space_id !== spaceId) throw new ApiFault(404, 'RECIPE_NOT_FOUND', 'Recipe was not found in this workspace.');
  if (!current) {
    if (operation.type === 'recipe.save' && (operation.baseVersion === undefined || operation.baseVersion === null || operation.baseVersion === 0)) return null;
    if (operation.type === 'recipe.delete') return null;
    throw new ApiFault(409, 'RECIPE_BASE_VERSION_INVALID', 'The recipe no longer exists; save the attempted version as a new recipe.');
  }
  const version = Number(current.version);
  const suppliedBase = operation.type === 'recipe.save' ? operation.baseVersion ?? null : operation.baseVersion;
  const isCreateAgainstExisting = operation.type === 'recipe.save' && suppliedBase === null;
  if (current.deleted_at || isCreateAgainstExisting || suppliedBase !== version) {
    return recordRecipeConflict(client, userId, spaceId, mutationId, operation, version);
  }
  if (operation.type === 'recipe.save') {
    for (const [table, ids] of [
      ['recipe_ingredients', operation.recipe.ingredients.map((row) => row.id)],
      ['recipe_steps', operation.recipe.steps.map((row) => row.id)],
    ] as const) {
      for (const childId of ids) {
        const child = await client.query<{ space_id: string; recipe_id: string; deleted_at: Date | null }>(
          `SELECT space_id, recipe_id, deleted_at FROM ${table} WHERE space_id = $1 AND recipe_id = $2 AND entity_id = $3 FOR UPDATE`, [spaceId, recipeId, childId],
        );
        const row = child.rows[0];
        if (row && (row.space_id !== spaceId || row.recipe_id !== recipeId || row.deleted_at)) {
          return recordRecipeConflict(client, userId, spaceId, mutationId, operation, version);
        }
      }
    }
  }
  return null;
}

async function applyPantryUpsert(client: PoolClient, userId: string, spaceId: string, operation: z.infer<typeof pantryUpsertSchema>) {
  const found = await client.query<{
    space_id: string; name: string; preference: number; version: string; deleted_at: Date | null;
  }>('SELECT space_id, name, preference, version, deleted_at FROM pantry_items WHERE space_id = $1 AND entity_id = $2 FOR UPDATE', [spaceId, operation.id]);
  const current = found.rows[0];
  if (current && current.space_id !== spaceId) throw new ApiFault(404, 'PANTRY_ITEM_NOT_FOUND', 'Pantry item was not found in this workspace.');
  if (current?.deleted_at) throw new ApiFault(409, 'ENTITY_TOMBSTONED', 'A deleted pantry item cannot be restored with its old ID.');

  const duplicateName = await client.query<{ id: string; version: string }>(
    `SELECT id, version FROM pantry_items
     WHERE space_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND deleted_at IS NULL AND entity_id <> $3
     FOR UPDATE`,
    [spaceId, operation.name, operation.id],
  );
  if (duplicateName.rowCount) throw new ApiFault(409, 'PANTRY_NAME_CONFLICT', 'A pantry item with that name already exists in this workspace.');

  if (current) {
    const updated = await client.query<{ version: string }>(
      `UPDATE pantry_items SET name = $3, preference = $4, updated_at = now(), version = version + 1, updated_by = $5
       WHERE space_id = $1 AND entity_id = $2 RETURNING version`,
      [spaceId, operation.id, operation.name, operation.preference, userId],
    );
    return { opId: operation.opId, status: 'applied', entityId: operation.id, version: Number(updated.rows[0]!.version) };
  }
  await client.query(
    `INSERT INTO pantry_items(id, entity_id, space_id, name, preference, updated_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [contentStorageId('pantry_items', spaceId, null, operation.id), operation.id, spaceId, operation.name, operation.preference, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.id, version: 1 };
}

async function applyPantryDelete(client: PoolClient, userId: string, spaceId: string, operation: z.infer<typeof pantryDeleteSchema>) {
  const found = await client.query<{ space_id: string; deleted_at: Date | null; version: string }>(
    'SELECT space_id, deleted_at, version FROM pantry_items WHERE space_id = $1 AND entity_id = $2 FOR UPDATE', [spaceId, operation.id],
  );
  const current = found.rows[0];
  if (!current) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.id };
  if (current.space_id !== spaceId) throw new ApiFault(404, 'PANTRY_ITEM_NOT_FOUND', 'Pantry item was not found in this workspace.');
  if (current.deleted_at) return { opId: operation.opId, status: 'ignored', reason: 'already_deleted', entityId: operation.id };
  const updated = await client.query<{ version: string }>(
    `UPDATE pantry_items SET deleted_at = now(), updated_at = now(), version = version + 1, updated_by = $3
     WHERE space_id = $1 AND entity_id = $2 RETURNING version`,
    [spaceId, operation.id, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.id, version: Number(updated.rows[0]!.version) };
}

async function applyRecipeSave(client: PoolClient, userId: string, spaceId: string, operation: z.infer<typeof recipeSaveSchema>) {
  const { recipe } = operation;
  const found = await client.query<{ space_id: string; version: string; deleted_at: Date | null }>(
    'SELECT space_id, version, deleted_at FROM recipes WHERE space_id = $1 AND entity_id = $2 FOR UPDATE', [spaceId, recipe.id],
  );
  const current = found.rows[0];
  if (current && current.space_id !== spaceId) throw new ApiFault(404, 'RECIPE_NOT_FOUND', 'Recipe was not found in this workspace.');
  if (current?.deleted_at) throw new ApiFault(409, 'RECIPE_TOMBSTONED', 'A deleted recipe cannot be restored with its old ID.');
  let version: number;
  if (current) {
    const updated = await client.query<{ version: string }>(
      `UPDATE recipes SET title = $3, description = $4, portions = $5, notes = $6,
        updated_at = now(), version = version + 1, updated_by = $7
       WHERE space_id = $1 AND entity_id = $2 RETURNING version`,
      [spaceId, recipe.id, recipe.title, recipe.description ?? null, recipe.portions, recipe.notes, userId],
    );
    version = Number(updated.rows[0]!.version);
  } else {
    await client.query(
      `INSERT INTO recipes(id, entity_id, space_id, title, description, portions, notes, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [contentStorageId('recipes', spaceId, null, recipe.id), recipe.id, spaceId, recipe.title, recipe.description ?? null, recipe.portions, recipe.notes, userId],
    );
    version = 1;
  }
  await saveRecipeChildren(client, userId, spaceId, recipe);
  return { opId: operation.opId, status: 'applied', entityId: recipe.id, version };
}

async function applyRecipeDelete(client: PoolClient, userId: string, spaceId: string, operation: z.infer<typeof recipeDeleteSchema>) {
  const found = await client.query<{ space_id: string; version: string; deleted_at: Date | null }>(
    'SELECT space_id, version, deleted_at FROM recipes WHERE space_id = $1 AND entity_id = $2 FOR UPDATE', [spaceId, operation.id],
  );
  const current = found.rows[0];
  if (!current) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.id };
  if (current.space_id !== spaceId) throw new ApiFault(404, 'RECIPE_NOT_FOUND', 'Recipe was not found in this workspace.');
  if (current.deleted_at) return { opId: operation.opId, status: 'ignored', reason: 'already_deleted', entityId: operation.id };
  const updated = await client.query<{ version: string }>(
    `UPDATE recipes SET deleted_at = now(), updated_at = now(), version = version + 1, updated_by = $3
     WHERE space_id = $1 AND entity_id = $2 RETURNING version`,
    [spaceId, operation.id, userId],
  );
  await client.query(
    `UPDATE recipe_ingredients SET deleted_at = now(), updated_at = now(), version = version + 1, updated_by = $3
     WHERE space_id = $1 AND recipe_id = $2 AND deleted_at IS NULL`,
    [spaceId, operation.id, userId],
  );
  await client.query(
    `UPDATE recipe_steps SET deleted_at = now(), updated_at = now(), version = version + 1, updated_by = $3
     WHERE space_id = $1 AND recipe_id = $2 AND deleted_at IS NULL`,
    [spaceId, operation.id, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.id, version: Number(updated.rows[0]!.version) };
}

async function getShoppingList(client: PoolClient, spaceId: string, listId: string, lock = false) {
  const result = await client.query<{
    id: string; name: string; current_cycle_id: string; removed_at: Date | null; version: string;
  }>(
    `SELECT entity_id AS id, name, current_cycle_id, removed_at, version FROM shopping_lists
     WHERE entity_id = $1 AND space_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [listId, spaceId],
  );
  return result.rows[0] ?? null;
}

async function applyShoppingListCreate(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingListCreateSchema>,
) {
  const { list, cycle } = operation;
  const existing = await client.query<{ space_id: string; current_cycle_id: string }>(
    'SELECT space_id, current_cycle_id FROM shopping_lists WHERE space_id = $1 AND entity_id = $2 FOR UPDATE', [spaceId, list.id],
  );
  if (existing.rowCount) {
    if (existing.rows[0]!.space_id !== spaceId) throw new ApiFault(404, 'SHOPPING_LIST_NOT_FOUND', 'Shopping list was not found in this workspace.');
    if (existing.rows[0]!.current_cycle_id === list.currentCycleId) {
      return { opId: operation.opId, status: 'ignored', reason: 'already_exists', entityId: list.id };
    }
    throw new ApiFault(409, 'SHOPPING_LIST_ID_REUSED', 'A shopping list ID cannot be reused for another list.');
  }
  await client.query(
    `INSERT INTO shopping_lists(id, entity_id, space_id, name, current_cycle_id, created_at, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [contentStorageId('shopping_lists', spaceId, null, list.id), list.id, spaceId, list.name, list.currentCycleId, list.createdAt, list.updatedAt, userId],
  );
  await client.query(
    'INSERT INTO shopping_cycles(id, entity_id, space_id, list_id, started_at) VALUES ($1, $2, $3, $4, $5)',
    [contentStorageId('shopping_cycles', spaceId, list.id, cycle.id), cycle.id, spaceId, list.id, cycle.startedAt],
  );
  return { opId: operation.opId, status: 'applied', entityId: list.id, currentCycleId: cycle.id };
}

async function applyShoppingListRename(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingListRenameSchema>,
) {
  const list = await getShoppingList(client, spaceId, operation.id, true);
  if (!list) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.id };
  if (list.removed_at) throw new ApiFault(409, 'ENTITY_TOMBSTONED', 'A removed shopping list cannot be restored with its old ID.');
  await client.query(
    `UPDATE shopping_lists SET name = $3, updated_at = $4, version = version + 1, updated_by = $5
     WHERE entity_id = $1 AND space_id = $2`,
    [operation.id, spaceId, operation.name, operation.updatedAt, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.id };
}

async function applyShoppingListRemove(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingListRemoveSchema>,
) {
  const list = await getShoppingList(client, spaceId, operation.id, true);
  if (!list) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.id };
  if (list.removed_at) return { opId: operation.opId, status: 'ignored', reason: 'already_removed', entityId: operation.id };
  await client.query(
    `UPDATE shopping_lists SET removed_at = $3, updated_at = now(), version = version + 1, updated_by = $4
     WHERE entity_id = $1 AND space_id = $2`,
    [operation.id, spaceId, operation.removedAt ?? new Date().toISOString(), userId],
  );
  await client.query(
    `UPDATE shopping_items SET removed_at = now(), updated_at = now(), version = version + 1, updated_by = $3
     WHERE space_id = $1 AND list_id = $2 AND removed_at IS NULL`,
    [spaceId, operation.id, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.id };
}

async function applyShoppingCycleStart(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingCycleStartSchema>,
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shopping-list:${spaceId}:${operation.listId}`]);
  const list = await getShoppingList(client, spaceId, operation.listId, true);
  if (!list) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.listId };
  if (list.removed_at) throw new ApiFault(409, 'ENTITY_TOMBSTONED', 'A removed shopping list cannot start another cycle.');
  if (list.current_cycle_id === operation.cycle.id) {
    return { opId: operation.opId, status: 'ignored', reason: 'already_current', entityId: operation.cycle.id };
  }
  const existingCycle = await client.query<{ space_id: string; list_id: string }>(
    'SELECT space_id, list_id FROM shopping_cycles WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR UPDATE', [spaceId, operation.listId, operation.cycle.id],
  );
  if (existingCycle.rowCount) throw new ApiFault(409, 'SHOPPING_CYCLE_ID_REUSED', 'A shopping cycle ID cannot be reused.');
  await client.query(
    'INSERT INTO shopping_cycles(id, entity_id, space_id, list_id, started_at) VALUES ($1, $2, $3, $4, $5)',
    [contentStorageId('shopping_cycles', spaceId, operation.listId, operation.cycle.id), operation.cycle.id, spaceId, operation.listId, operation.cycle.startedAt],
  );
  await client.query(
    `UPDATE shopping_lists SET current_cycle_id = $3, updated_at = now(), version = version + 1, updated_by = $4
     WHERE entity_id = $1 AND space_id = $2`,
    [operation.listId, spaceId, operation.cycle.id, userId],
  );
  await client.query(
    `UPDATE shopping_items SET purchase_cycle_id = $3, checked = false, purchased_cycle_id = NULL,
      updated_at = now(), version = version + 1, updated_by = $4
     WHERE space_id = $1 AND list_id = $2 AND removed_at IS NULL`,
    [spaceId, operation.listId, operation.cycle.id, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.cycle.id, listId: operation.listId };
}

async function applyShoppingItemUpsert(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingItemUpsertSchema>,
) {
  const item = operation.item;
  const list = await getShoppingList(client, spaceId, item.listId, true);
  if (!list) throw new ApiFault(404, 'SHOPPING_LIST_NOT_FOUND', 'Shopping list was not found in this workspace.');
  if (list.removed_at) throw new ApiFault(409, 'ENTITY_TOMBSTONED', 'A removed shopping list cannot accept items.');
  if (item.purchaseCycleId !== list.current_cycle_id) {
    return { opId: operation.opId, status: 'ignored', reason: 'stale_cycle', entityId: item.id };
  }
  if (item.purchasedCycleId && item.purchasedCycleId !== item.purchaseCycleId) {
    return { opId: operation.opId, status: 'ignored', reason: 'stale_purchase_cycle', entityId: item.id };
  }
  const found = await client.query<{
    space_id: string; list_id: string; removed_at: Date | null; purchased_cycle_id: string | null; checked: boolean; version: string;
  }>('SELECT space_id, list_id, removed_at, purchased_cycle_id, checked, version FROM shopping_items WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR UPDATE', [spaceId, item.listId, item.id]);
  const current = found.rows[0];
  if (current && (current.space_id !== spaceId || current.list_id !== item.listId)) {
    throw new ApiFault(404, 'SHOPPING_ITEM_NOT_FOUND', 'Shopping item was not found in this list.');
  }
  if (current?.removed_at) throw new ApiFault(409, 'ENTITY_TOMBSTONED', 'A removed shopping item cannot be restored with its old ID.');
  if (current?.purchased_cycle_id === item.purchaseCycleId && item.checked === false) {
    return { opId: operation.opId, status: 'ignored', reason: 'already_purchased', entityId: item.id };
  }
  const purchasedCycleId = current?.purchased_cycle_id ?? null;
  const checked = purchasedCycleId === item.purchaseCycleId ? true : item.checked;
  if (current) {
    const updated = await client.query<{ version: string }>(
      `UPDATE shopping_items SET name = $4, recipe_id = $5, ingredient_id = $6, display_quantity = $7,
        display_unit = $8, purchase_cycle_id = $9, checked = $10, purchased_cycle_id = $11,
        updated_at = $12, version = version + 1, updated_by = $13
       WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 RETURNING version`,
      [spaceId, item.listId, item.id, item.name, item.recipeId ?? null, item.ingredientId ?? null, item.displayQuantity ?? null,
        item.displayUnit ?? null, item.purchaseCycleId, checked, purchasedCycleId, item.updatedAt, userId],
    );
    return { opId: operation.opId, status: 'applied', entityId: item.id, version: Number(updated.rows[0]!.version) };
  }
  if (item.purchasedCycleId) throw new ApiFault(409, 'USE_PURCHASE_COMMAND', 'Purchase completion must be recorded with an atomic shopping purchase.');
  await client.query(
    `INSERT INTO shopping_items(id, entity_id, space_id, list_id, name, recipe_id, ingredient_id, display_quantity, display_unit,
      purchase_cycle_id, checked, created_at, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [contentStorageId('shopping_items', spaceId, item.listId, item.id), item.id, spaceId, item.listId, item.name, item.recipeId ?? null, item.ingredientId ?? null,
      item.displayQuantity ?? null, item.displayUnit ?? null, item.purchaseCycleId, item.checked,
      item.createdAt, item.updatedAt, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: item.id, version: 1 };
}

async function applyShoppingItemCheck(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingItemCheckSchema>,
) {
  const list = await getShoppingList(client, spaceId, operation.listId, true);
  if (!list || list.removed_at) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.id };
  const found = await client.query<{
    space_id: string; list_id: string; purchase_cycle_id: string; purchased_cycle_id: string | null; removed_at: Date | null;
  }>('SELECT space_id, list_id, purchase_cycle_id, purchased_cycle_id, removed_at FROM shopping_items WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR UPDATE', [spaceId, operation.listId, operation.id]);
  const item = found.rows[0];
  if (!item) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.id };
  if (item.space_id !== spaceId || item.list_id !== operation.listId) throw new ApiFault(404, 'SHOPPING_ITEM_NOT_FOUND', 'Shopping item was not found in this list.');
  if (item.removed_at) return { opId: operation.opId, status: 'ignored', reason: 'removed', entityId: operation.id };
  if (list.current_cycle_id !== operation.purchaseCycleId || item.purchase_cycle_id !== operation.purchaseCycleId) {
    return { opId: operation.opId, status: 'ignored', reason: 'stale_cycle', entityId: operation.id };
  }
  if (item.purchased_cycle_id === operation.purchaseCycleId) {
    return { opId: operation.opId, status: 'ignored', reason: 'already_purchased', entityId: operation.id };
  }
  await client.query(
    `UPDATE shopping_items SET checked = $4, updated_at = now(), version = version + 1, updated_by = $5
     WHERE space_id = $1 AND list_id = $2 AND entity_id = $3`,
    [spaceId, operation.listId, operation.id, operation.checked, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.id };
}

async function applyShoppingItemRemove(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingItemRemoveSchema>,
) {
  const list = await getShoppingList(client, spaceId, operation.listId, true);
  if (!list || list.removed_at) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.id };
  const found = await client.query<{
    space_id: string; list_id: string; purchase_cycle_id: string; removed_at: Date | null;
  }>('SELECT space_id, list_id, purchase_cycle_id, removed_at FROM shopping_items WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR UPDATE', [spaceId, operation.listId, operation.id]);
  const item = found.rows[0];
  if (!item) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: operation.id };
  if (item.space_id !== spaceId || item.list_id !== operation.listId) throw new ApiFault(404, 'SHOPPING_ITEM_NOT_FOUND', 'Shopping item was not found in this list.');
  if (item.removed_at) return { opId: operation.opId, status: 'ignored', reason: 'already_removed', entityId: operation.id };
  if (list.current_cycle_id !== operation.purchaseCycleId || item.purchase_cycle_id !== operation.purchaseCycleId) {
    return { opId: operation.opId, status: 'ignored', reason: 'stale_cycle', entityId: operation.id };
  }
  await client.query(
    `UPDATE shopping_items SET removed_at = $4, updated_at = now(), version = version + 1, updated_by = $5
     WHERE space_id = $1 AND list_id = $2 AND entity_id = $3`,
    [spaceId, operation.listId, operation.id, operation.removedAt ?? new Date().toISOString(), userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.id };
}

async function applyShoppingPurchase(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingPurchaseSchema>,
) {
  const purchase = operation.purchase;
  const list = await getShoppingList(client, spaceId, purchase.listId, true);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shopping-purchase:${spaceId}:${purchase.id}`]);
  const existingPurchase = await client.query<{
    space_id: string; list_id: string; purchase_cycle_id: string; item_ids: string[]; pantry_item_ids: string[]; purchased_at: Date;
  }>('SELECT space_id, list_id, purchase_cycle_id, item_ids, pantry_item_ids, purchased_at FROM shopping_purchases WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR UPDATE', [spaceId, purchase.listId, purchase.id]);
  if (existingPurchase.rowCount) {
    const existing = existingPurchase.rows[0]!;
    if (existing.purchase_cycle_id !== purchase.purchaseCycleId
      || JSON.stringify([...existing.item_ids].sort()) !== JSON.stringify([...purchase.itemIds].sort())
      || JSON.stringify([...existing.pantry_item_ids].sort()) !== JSON.stringify([...purchase.pantryItemIds].sort())
      || existing.purchased_at.getTime() !== new Date(purchase.purchasedAt).getTime()) {
      throw new ApiFault(409, 'PURCHASE_ID_REUSED', 'A shopping purchase ID cannot be reused for a different purchase.');
    }
    return { opId: operation.opId, status: 'ignored', reason: 'duplicate_purchase', entityId: purchase.id, pantryItemIds: existing.pantry_item_ids };
  }

  if (!list || list.removed_at) return { opId: operation.opId, status: 'ignored', reason: 'not_found', entityId: purchase.id };
  if (list.current_cycle_id !== purchase.purchaseCycleId) {
    return { opId: operation.opId, status: 'ignored', reason: 'stale_cycle', entityId: purchase.id };
  }
  const foundItems = await client.query<{
    id: string; name: string; purchase_cycle_id: string; purchased_cycle_id: string | null; removed_at: Date | null;
  }>(
    `SELECT entity_id AS id, name, purchase_cycle_id, purchased_cycle_id, removed_at FROM shopping_items
     WHERE space_id = $1 AND list_id = $2 AND entity_id = ANY($3::text[]) FOR UPDATE`,
    [spaceId, purchase.listId, purchase.itemIds],
  );
  if (foundItems.rowCount !== purchase.itemIds.length || foundItems.rows.some((item) => item.removed_at || item.purchase_cycle_id !== purchase.purchaseCycleId)) {
    return { opId: operation.opId, status: 'ignored', reason: 'stale_items', entityId: purchase.id };
  }

  const additionsByName = new Map(operation.pantryAdds.map((addition) => [normalizedName(addition.name), addition]));
  const resolvedPantryIds = new Set<string>();
  const processedNames = new Set<string>();
  const newlyPurchased = foundItems.rows.filter((item) => item.purchased_cycle_id !== purchase.purchaseCycleId);
  for (const item of newlyPurchased) {
    const normalized = normalizedName(item.name);
    if (processedNames.has(normalized)) continue;
    processedNames.add(normalized);
    const existingPantry = await client.query<{ id: string; space_id: string; deleted_at: Date | null }>(
      `SELECT entity_id AS id, space_id, deleted_at FROM pantry_items
       WHERE space_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND deleted_at IS NULL FOR UPDATE`,
      [spaceId, item.name],
    );
    if (existingPantry.rowCount) {
      resolvedPantryIds.add(existingPantry.rows[0]!.id);
      continue;
    }
    const addition = additionsByName.get(normalized);
    if (!addition) throw new ApiFault(422, 'PANTRY_ADD_REQUIRED', 'A stable pantry row ID is required for each new pantry item from a purchase.');
    const reusedId = await client.query<{ space_id: string; name: string; deleted_at: Date | null }>(
      'SELECT space_id, name, deleted_at FROM pantry_items WHERE space_id = $1 AND entity_id = $2 FOR UPDATE', [spaceId, addition.id],
    );
    if (reusedId.rowCount) {
      const row = reusedId.rows[0]!;
      if (row.space_id !== spaceId || row.deleted_at || normalizedName(row.name) !== normalized) {
        throw new ApiFault(409, 'PANTRY_ITEM_ID_REUSED', 'A pantry item identity cannot be reused.');
      }
      resolvedPantryIds.add(addition.id);
      continue;
    }
    await client.query(
      'INSERT INTO pantry_items(id, entity_id, space_id, name, preference, updated_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [contentStorageId('pantry_items', spaceId, null, addition.id), addition.id, spaceId, item.name, addition.preference, userId],
    );
    resolvedPantryIds.add(addition.id);
  }
  for (const item of foundItems.rows.filter((row) => row.purchased_cycle_id === purchase.purchaseCycleId)) {
    const existingPantry = await client.query<{ id: string }>(
      `SELECT entity_id AS id FROM pantry_items WHERE space_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND deleted_at IS NULL`,
      [spaceId, item.name],
    );
    if (existingPantry.rowCount) resolvedPantryIds.add(existingPantry.rows[0]!.id);
  }
  const pantryItemIds = [...resolvedPantryIds].sort();
  if (JSON.stringify([...purchase.pantryItemIds].sort()) !== JSON.stringify(pantryItemIds)) {
    throw new ApiFault(409, 'PURCHASE_PANTRY_MISMATCH', 'The purchase pantry IDs do not match the current pantry rows.');
  }

  for (const item of newlyPurchased) {
    await client.query(
      `UPDATE shopping_items SET checked = true, purchased_cycle_id = $3, updated_at = now(),
        version = version + 1, updated_by = $4 WHERE space_id = $1 AND list_id = $2 AND entity_id = $5`,
      [spaceId, purchase.listId, purchase.purchaseCycleId, userId, item.id],
    );
  }
  await client.query(
    `INSERT INTO shopping_purchases(id, entity_id, space_id, list_id, purchase_cycle_id, item_ids, pantry_item_ids, purchased_at, purchased_by)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9)`,
    [contentStorageId('shopping_purchases', spaceId, purchase.listId, purchase.id), purchase.id, spaceId, purchase.listId, purchase.purchaseCycleId,
      purchase.itemIds, pantryItemIds, purchase.purchasedAt, userId],
  );
  return {
    opId: operation.opId,
    status: 'applied',
    entityId: purchase.id,
    itemIds: purchase.itemIds,
    pantryItemIds,
  };
}

async function applyShoppingHistoryImport(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: z.infer<typeof shoppingHistoryImportSchema>,
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shopping-list:${spaceId}:${operation.listId}`]);
  const list = await getShoppingList(client, spaceId, operation.listId, true);
  if (!list) throw new ApiFault(404, 'SHOPPING_LIST_NOT_FOUND', 'Shopping list was not found in this workspace.');
  if (list.current_cycle_id !== operation.currentCycleId) {
    throw new ApiFault(409, 'SHOPPING_HISTORY_STALE_CYCLE', 'The shopping list active cycle changed before history import.');
  }

  const activeCycle = await client.query(
    'SELECT 1 FROM shopping_cycles WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR KEY SHARE',
    [spaceId, operation.listId, operation.currentCycleId],
  );
  if (!activeCycle.rowCount) {
    throw new ApiFault(409, 'SHOPPING_HISTORY_CYCLE_SCOPE', 'The asserted active cycle does not belong to this list.');
  }

  const cycleResults: Record<string, unknown>[] = [];
  for (const cycle of operation.cycles) {
    const existing = await client.query<{ same_content: boolean }>(
      `SELECT started_at = $4::timestamptz AS same_content FROM shopping_cycles
       WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR UPDATE`,
      [spaceId, operation.listId, cycle.id, cycle.startedAt],
    );
    if (existing.rowCount) {
      if (!existing.rows[0]!.same_content) {
        throw new ApiFault(409, 'SHOPPING_CYCLE_ID_REUSED', 'A shopping cycle ID cannot be reused with different history.');
      }
      cycleResults.push({ id: cycle.id, status: 'ignored', reason: 'already_exists' });
      continue;
    }
    await client.query(
      'INSERT INTO shopping_cycles(id, entity_id, space_id, list_id, started_at) VALUES ($1, $2, $3, $4, $5)',
      [contentStorageId('shopping_cycles', spaceId, operation.listId, cycle.id), cycle.id, spaceId, operation.listId, cycle.startedAt],
    );
    cycleResults.push({ id: cycle.id, status: 'applied' });
  }

  const purchaseResults: Record<string, unknown>[] = [];
  for (const purchase of operation.purchases) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shopping-purchase:${spaceId}:${purchase.id}`]);
    const existing = await client.query<{ same_cycle: boolean; same_items: boolean; same_pantry: boolean; same_time: boolean }>(
      `SELECT purchase_cycle_id = $4 AS same_cycle,
              item_ids = $5::text[] AS same_items,
              pantry_item_ids = $6::text[] AS same_pantry,
              purchased_at = $7::timestamptz AS same_time
       FROM shopping_purchases
       WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR UPDATE`,
      [spaceId, operation.listId, purchase.id, purchase.purchaseCycleId, purchase.itemIds, purchase.pantryItemIds, purchase.purchasedAt],
    );
    if (existing.rowCount) {
      const row = existing.rows[0]!;
      if (!row.same_cycle || !row.same_items || !row.same_pantry || !row.same_time) {
        throw new ApiFault(409, 'PURCHASE_ID_REUSED', 'A shopping purchase ID cannot be reused with different history.');
      }
      purchaseResults.push({ id: purchase.id, status: 'ignored', reason: 'already_exists' });
      continue;
    }

    const purchaseCycle = await client.query(
      `SELECT 1 FROM shopping_cycles WHERE space_id = $1 AND list_id = $2 AND entity_id = $3 FOR KEY SHARE`,
      [spaceId, operation.listId, purchase.purchaseCycleId],
    );
    if (!purchaseCycle.rowCount) {
      throw new ApiFault(422, 'SHOPPING_HISTORY_CYCLE_SCOPE', 'A purchase cycle must belong to this workspace and shopping list.');
    }

    await client.query(
      `INSERT INTO shopping_purchases(id, entity_id, space_id, list_id, purchase_cycle_id, item_ids, pantry_item_ids, purchased_at, purchased_by)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9)`,
      [contentStorageId('shopping_purchases', spaceId, operation.listId, purchase.id), purchase.id, spaceId, operation.listId,
        purchase.purchaseCycleId, purchase.itemIds, purchase.pantryItemIds, purchase.purchasedAt, userId],
    );
    purchaseResults.push({ id: purchase.id, status: 'applied' });
  }

  return {
    opId: operation.opId,
    status: 'applied',
    listId: operation.listId,
    currentCycleId: operation.currentCycleId,
    cycles: cycleResults,
    purchases: purchaseResults,
  };
}

async function applyContentOperation(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: ContentOperation,
) {
  switch (operation.type) {
    case 'personal.preference.set':
    case 'personal.allergy.set':
    case 'personal.chat.conversation.create':
    case 'personal.chat.message.append':
    case 'personal.chat.proposal.create':
    case 'personal.chat.proposal.setStatus':
    case 'personal.chat.conversation.delete':
      return applyPersonalContentOperation(client, userId, spaceId, operation as PersonalContentOperation);
    case 'pantry.upsert': return applyPantryUpsert(client, userId, spaceId, operation);
    case 'pantry.delete': return applyPantryDelete(client, userId, spaceId, operation);
    case 'recipe.save': return applyRecipeSave(client, userId, spaceId, operation);
    case 'recipe.delete': return applyRecipeDelete(client, userId, spaceId, operation);
    case 'shopping.list.create': return applyShoppingListCreate(client, userId, spaceId, operation);
    case 'shopping.list.rename': return applyShoppingListRename(client, userId, spaceId, operation);
    case 'shopping.list.remove': return applyShoppingListRemove(client, userId, spaceId, operation);
    case 'shopping.cycle.start': return applyShoppingCycleStart(client, userId, spaceId, operation);
    case 'shopping.item.upsert': return applyShoppingItemUpsert(client, userId, spaceId, operation);
    case 'shopping.item.check': return applyShoppingItemCheck(client, userId, spaceId, operation);
    case 'shopping.item.remove': return applyShoppingItemRemove(client, userId, spaceId, operation);
    case 'shopping.purchase': return applyShoppingPurchase(client, userId, spaceId, operation);
    case 'shopping.history.import': return applyShoppingHistoryImport(client, userId, spaceId, operation);
  }
}

async function saveMutationReceipt(
  client: PoolClient,
  userId: string,
  spaceId: string,
  mutationId: string,
  reply: MutationReply,
): Promise<MutationReply> {
  await client.query(
    `INSERT INTO content_mutations(user_id, mutation_id, space_id, status_code, response)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, mutationId, spaceId, reply.statusCode, JSON.stringify(reply.body)],
  );
  return reply;
}

async function handleContentMutation(
  pool: Pool,
  userId: string,
  spaceId: string,
  mutation: z.infer<typeof contentMutationSchema>,
): Promise<MutationReply> {
  return transaction(pool, async (client) => {
    // This lock/check intentionally precedes idempotency lookup and receipt replay.
    const membership = await requireMembershipInTransaction(client, userId, spaceId, 'editor');
    const personalOperations = mutation.operations.filter(isPersonalContentOperation);
    if (personalOperations.length > 0) {
      const workspace = await client.query<{ created_by: string }>('SELECT created_by FROM spaces WHERE id = $1', [spaceId]);
      if (membership.kind !== 'personal' || membership.role !== 'owner' || workspace.rows[0]?.created_by !== userId) {
        throw new ApiFault(403, 'PERSONAL_SPACE_REQUIRED', 'Personal content can only be written to the signed-in owner’s personal workspace.');
      }
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`content-mutation:${userId}:${mutation.mutationId}`]);
    const replay = await client.query<{ space_id: string; status_code: number; response: Record<string, unknown> }>(
      'SELECT space_id, status_code, response FROM content_mutations WHERE user_id = $1 AND mutation_id = $2 FOR UPDATE',
      [userId, mutation.mutationId],
    );
    if (replay.rowCount) {
      const prior = replay.rows[0]!;
      if (prior.space_id !== spaceId) {
        return { statusCode: 409, body: { error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'A mutation ID cannot be reused in another workspace.' } } };
      }
      return { statusCode: prior.status_code, body: prior.response };
    }

    const recipeOperations = mutation.operations
      .filter((operation): operation is Extract<ContentOperation, { type: 'recipe.save' | 'recipe.delete' }> =>
        operation.type === 'recipe.save' || operation.type === 'recipe.delete')
      .sort((a, b) => (a.type === 'recipe.save' ? a.recipe.id : a.id).localeCompare(b.type === 'recipe.save' ? b.recipe.id : b.id));
    const conflicts: Record<string, unknown>[] = [];
    for (const operation of recipeOperations) {
      const conflict = await findRecipeConflict(client, userId, spaceId, mutation.mutationId, operation);
      if (conflict) conflicts.push(conflict);
    }
    if (conflicts.length) {
      const response = await saveMutationReceipt(client, userId, spaceId, mutation.mutationId, {
        statusCode: 409,
        body: {
          error: { code: 'RECIPE_VERSION_CONFLICT', message: 'The accepted recipe changed; both versions were kept for review.' },
          conflicts,
        },
      });
      return response;
    }

    const personalConflicts = await findPersonalContentConflicts(client, userId, spaceId,
      mutation.mutationId, personalOperations);
    if (personalConflicts.length) {
      return saveMutationReceipt(client, userId, spaceId, mutation.mutationId, {
        statusCode: 409,
        body: {
          error: { code: 'PERSONAL_CONTENT_CONFLICT', message: 'Personal content changed elsewhere; both versions were kept for review.' },
          conflicts: personalConflicts,
        },
      });
    }

    const results: Record<string, unknown>[] = [];
    for (const operation of mutation.operations) {
      results.push(await applyContentOperation(client, userId, spaceId, operation));
    }
    return saveMutationReceipt(client, userId, spaceId, mutation.mutationId, {
      statusCode: 200,
      body: { mutationId: mutation.mutationId, operations: results },
    });
  });
}

function validPath(reply: import('fastify').FastifyReply, schema: z.ZodType, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    fail(reply, 400, 'INVALID_REQUEST', 'Request path is invalid.');
    return null;
  }
  return parsed.data as { spaceId: string; recipeId?: string };
}

export async function registerContentRoutes(
  app: FastifyInstance,
  pool: Pool,
  authenticate: preHandlerHookHandler,
  config: Pick<ServerConfig,
    'syncJwtAudience' | 'syncJwtIssuer' | 'syncJwtKeyId' | 'syncJwtPrivateKeyB64Url' | 'syncJwtPublicKeyB64Url'
  >,
): Promise<void> {
  app.get('/v1/sync/jwks', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return reply.send(await powerSyncJwks(config));
  });

  app.post('/v1/sync/credentials', { preHandler: authenticate }, async (request, reply) => {
    const auth = requireAuth(request);
    return reply.send(await issuePowerSyncJwt(config, auth.userId));
  });

  app.post('/v1/spaces/:spaceId/content/mutations', {
    preHandler: authenticate,
    bodyLimit: 1024 * 1024,
  }, async (request, reply) => {
    const path = validPath(reply, z.object({ spaceId: z.string().uuid() }).strict(), request.params);
    if (!path) return;
    const mutation = contentMutationSchema.safeParse(request.body);
    if (!mutation.success) return fail(reply, 400, 'INVALID_REQUEST', 'Mutation body is invalid.');
    const auth = requireAuth(request);
    const result = await handleContentMutation(pool, auth.userId, path.spaceId, mutation.data);
    return reply.code(result.statusCode).send(result.body);
  });

  app.get('/v1/spaces/:spaceId/content/recipes/:recipeId', { preHandler: authenticate }, async (request, reply) => {
    const path = validPath(reply, z.object({ spaceId: z.string().uuid(), recipeId: textId }).strict(), request.params);
    if (!path || !path.recipeId) return;
    const auth = requireAuth(request);
    const recipe = await transaction(pool, async (client) => {
      await requireMembershipInTransaction(client, auth.userId, path.spaceId, 'viewer');
      return readRecipe(client, path.spaceId, path.recipeId!);
    });
    if (!recipe) return fail(reply, 404, 'RECIPE_NOT_FOUND', 'Recipe was not found in this workspace.');
    return reply.send({ recipe });
  });

  app.get('/v1/spaces/:spaceId/content/conflicts', { preHandler: authenticate }, async (request, reply) => {
    const path = validPath(reply, z.object({ spaceId: z.string().uuid() }).strict(), request.params);
    if (!path) return;
    const auth = requireAuth(request);
    const conflicts = await transaction(pool, async (client) => {
      await requireMembershipInTransaction(client, auth.userId, path.spaceId, 'viewer');
      const result = await client.query<{
        id: string; recipe_id: string; mutation_id: string; base_version: string | null; current_version: string | null;
        attempted_content: Record<string, unknown>; created_by: string; created_at: Date;
      }>(
        `SELECT id, recipe_id, mutation_id, base_version, current_version, attempted_content, created_by, created_at
         FROM recipe_conflicts WHERE space_id = $1 AND resolved_at IS NULL ORDER BY created_at, id`,
        [path.spaceId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        recipeId: row.recipe_id,
        mutationId: row.mutation_id,
        baseVersion: row.base_version === null ? null : Number(row.base_version),
        currentVersion: row.current_version === null ? null : Number(row.current_version),
        attempted: row.attempted_content,
        createdBy: row.created_by,
        createdAt: row.created_at.toISOString(),
      }));
    });
    return reply.send({ conflicts });
  });

}
