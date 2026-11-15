import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiFault } from './authz.js';
import { contentStorageId } from './contentIdentity.js';

const textId = z.string().trim().min(1).max(200);
const operationId = z.string().min(1).max(80);
const isoDate = z.string().datetime({ offset: true });
const profileFields = [
  'systemPrompt',
  'city',
  'mealContext.willingToShop',
  'mealContext.portions',
  'mealContext.cooksCount',
] as const;
const preferenceField = z.union([
  z.enum(profileFields),
  z.string().regex(/^mealContext\.cooks\.[0-7]$/),
]);

const preferenceSetSchema = z.object({
  opId: operationId,
  type: z.literal('personal.preference.set'),
  field: preferenceField,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  baseVersion: z.number().int().min(1).nullable(),
}).strict().superRefine((operation, context) => {
  const { field, value } = operation;
  const valid = field === 'systemPrompt'
    ? typeof value === 'string' && value.length <= 16000
    : field === 'city'
      ? typeof value === 'string' && value.length <= 240
      : field === 'mealContext.willingToShop'
        ? typeof value === 'boolean'
        : field === 'mealContext.portions'
          ? typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100
          : field === 'mealContext.cooksCount'
            ? typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8
            : value === null || value === 'low' || value === 'medium' || value === 'high';
  if (!valid) context.addIssue({ code: 'custom', path: ['value'], message: 'The preference value does not match its field.' });
});

const allergySetSchema = z.object({
  opId: operationId,
  type: z.literal('personal.allergy.set'),
  name: z.string().trim().min(1).max(240),
  enabled: z.boolean(),
  baseVersion: z.number().int().min(1).nullable(),
}).strict();

const conversationCreateSchema = z.object({
  opId: operationId,
  type: z.literal('personal.chat.conversation.create'),
  conversation: z.object({
    id: textId,
    title: z.string().trim().min(1).max(200),
    createdAt: isoDate,
  }).strict(),
}).strict();

const messageAppendSchema = z.object({
  opId: operationId,
  type: z.literal('personal.chat.message.append'),
  conversationId: textId,
  message: z.object({
    id: textId,
    role: z.enum(['user', 'assistant']),
    content: z.string().max(32000),
    createdAt: isoDate,
  }).strict(),
}).strict();

const proposalCreateSchema = z.object({
  opId: operationId,
  type: z.literal('personal.chat.proposal.create'),
  conversationId: textId,
  messageId: textId,
  proposal: z.object({
    id: textId,
    toolName: z.string().trim().min(1).max(80),
    arguments: z.string().max(16000),
    status: z.enum(['pending', 'applied']),
  }).strict(),
}).strict();

const proposalSetStatusSchema = z.object({
  opId: operationId,
  type: z.literal('personal.chat.proposal.setStatus'),
  conversationId: textId,
  messageId: textId,
  proposalId: textId,
  status: z.literal('applied'),
  baseVersion: z.number().int().min(1),
  effectSpaceId: z.string().uuid(),
  effectMutationId: z.string().trim().min(1).max(128),
  effectOpId: operationId,
}).strict();

const conversationDeleteSchema = z.object({
  opId: operationId,
  type: z.literal('personal.chat.conversation.delete'),
  id: textId,
  baseVersion: z.number().int().min(1),
}).strict();

export const personalContentOperationSchema = z.discriminatedUnion('type', [
  preferenceSetSchema,
  allergySetSchema,
  conversationCreateSchema,
  messageAppendSchema,
  proposalCreateSchema,
  proposalSetStatusSchema,
  conversationDeleteSchema,
]);

export type PersonalContentOperation = z.infer<typeof personalContentOperationSchema>;

export function isPersonalContentOperation(operation: { type: string }): operation is PersonalContentOperation {
  return operation.type.startsWith('personal.');
}

type Conflict = Record<string, unknown>;

function allergyIdentity(name: string): string {
  return name.trim().toLocaleLowerCase('en');
}

function proposalParent(conversationId: string, messageId: string): string {
  return JSON.stringify([conversationId, messageId]);
}

async function recordConflict(
  client: PoolClient,
  userId: string,
  spaceId: string,
  mutationId: string,
  operation: PersonalContentOperation,
  recordType: string,
  entityId: string,
  base: number | null,
  current: number | null,
  attempted: unknown,
  reason: string,
): Promise<Conflict> {
  const id = contentStorageId('personal_content_conflicts', spaceId, JSON.stringify([mutationId, operation.opId]), entityId);
  const inserted = await client.query<{ created_at: Date }>(
    `INSERT INTO personal_content_conflicts(
       id, entity_id, space_id, record_type, mutation_id, op_id, base_version,
       current_version, attempted_content, reason, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     ON CONFLICT (space_id, mutation_id, op_id) DO NOTHING
     RETURNING created_at`,
    [id, entityId, spaceId, recordType, mutationId, operation.opId, base, current, JSON.stringify(attempted), reason, userId],
  );
  const existing = inserted.rows[0] ?? (await client.query<{ created_at: Date }>(
    'SELECT created_at FROM personal_content_conflicts WHERE space_id = $1 AND mutation_id = $2 AND op_id = $3',
    [spaceId, mutationId, operation.opId],
  )).rows[0];
  return {
    id,
    opId: operation.opId,
    recordType,
    entityId,
    baseVersion: base,
    currentVersion: current,
    attempted,
    reason,
    createdAt: existing?.created_at.toISOString() ?? new Date().toISOString(),
  };
}

async function checkEffectReceipt(
  client: PoolClient,
  userId: string,
  operation: Extract<PersonalContentOperation, { type: 'personal.chat.proposal.setStatus' }>,
): Promise<void> {
  const receipt = await client.query<{ response: { operations?: unknown } }>(
    `SELECT response FROM content_mutations
     WHERE user_id = $1 AND space_id = $2 AND mutation_id = $3 AND status_code = 200`,
    [userId, operation.effectSpaceId, operation.effectMutationId],
  );
  const results = receipt.rows[0]?.response.operations;
  const matching = Array.isArray(results)
    ? results.filter((result) => typeof result === 'object' && result !== null && 'opId' in result
      && result.opId === operation.effectOpId)
    : [];
  const allApplied = Array.isArray(results)
    && results.length > 0
    && results.every((result) => typeof result === 'object' && result !== null
      && 'opId' in result && typeof result.opId === 'string'
      && 'status' in result && result.status === 'applied');
  if (matching.length !== 1 || !allApplied) {
    throw new ApiFault(409, 'PROPOSAL_EFFECT_NOT_ACKNOWLEDGED', 'The proposal effect must be accepted before its personal status can change.');
  }
}

async function findConflict(
  client: PoolClient,
  userId: string,
  spaceId: string,
  mutationId: string,
  operation: PersonalContentOperation,
  prior: { conversationCreated: boolean; assistantMessageAppended: boolean },
): Promise<Conflict | null> {
  if (operation.type === 'personal.preference.set') {
    const entityId = operation.field;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`personal-profile:${spaceId}:${entityId}`]);
    const found = await client.query<{ value: unknown; deleted_at: Date | null; version: string }>(
      'SELECT value, deleted_at, version FROM personal_profile_fields WHERE space_id = $1 AND field_key = $2 FOR UPDATE',
      [spaceId, entityId],
    );
    const row = found.rows[0];
    const currentValue = row && !row.deleted_at ? row.value : null;
    if ((!row || row.deleted_at) && operation.value === null) return null;
    if (row && currentValue === operation.value) return null;
    if ((!row && operation.baseVersion === null) || (row && operation.baseVersion === Number(row.version))) return null;
    return recordConflict(client, userId, spaceId, mutationId, operation, 'preference', entityId,
      operation.baseVersion, row ? Number(row.version) : null, operation, 'version_mismatch');
  }

  if (operation.type === 'personal.allergy.set') {
    const normalized = allergyIdentity(operation.name);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`personal-allergy:${spaceId}:${normalized}`]);
    const found = await client.query<{ name: string; deleted_at: Date | null; version: string }>(
      'SELECT name, deleted_at, version FROM personal_allergies WHERE space_id = $1 AND normalized_name = $2 FOR UPDATE',
      [spaceId, normalized],
    );
    const row = found.rows[0];
    if ((!row || row.deleted_at) && !operation.enabled) return null;
    if (row && !row.deleted_at && operation.enabled && row.name === operation.name) return null;
    if ((!row && operation.baseVersion === null) || (row && operation.baseVersion === Number(row.version))) return null;
    return recordConflict(client, userId, spaceId, mutationId, operation, 'allergy', normalized,
      operation.baseVersion, row ? Number(row.version) : null, operation, 'version_mismatch');
  }

  if (operation.type === 'personal.chat.conversation.create') {
    const { id, title, createdAt } = operation.conversation;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`personal-conversation:${spaceId}:${id}`]);
    const found = await client.query<{
      title: string; created_at: Date; deleted_at: Date | null; version: string;
      same_title: boolean; same_created_at: boolean;
    }>(
      `SELECT title, created_at, deleted_at, version, title = $3 AS same_title,
         created_at = $4::timestamptz AS same_created_at
       FROM personal_conversations WHERE space_id = $1 AND entity_id = $2 FOR UPDATE`,
      [spaceId, id, title, createdAt],
    );
    if (!found.rowCount) return null;
    const row = found.rows[0]!;
    const same = row.same_title && row.same_created_at && !row.deleted_at;
    return same ? null : recordConflict(client, userId, spaceId, mutationId, operation, 'conversation', id,
      null, Number(row.version), operation, 'identity_reused');
  }

  if (operation.type === 'personal.chat.message.append') {
    const { conversationId, message } = operation;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`personal-conversation:${spaceId}:${conversationId}`]);
    const conversation = await client.query<{ deleted_at: Date | null; version: string }>(
      'SELECT deleted_at, version FROM personal_conversations WHERE space_id = $1 AND entity_id = $2 FOR UPDATE',
      [spaceId, conversationId],
    );
    const existing = await client.query<{ role: string; content: string; created_at: Date; same_message: boolean }>(
      `SELECT role, content, created_at, role = $4 AND content = $5 AND created_at = $6::timestamptz AS same_message
       FROM personal_chat_messages WHERE space_id = $1 AND conversation_id = $2 AND entity_id = $3 FOR UPDATE`,
      [spaceId, conversationId, message.id, message.role, message.content, message.createdAt],
    );
    if (existing.rowCount) {
      const row = existing.rows[0]!;
      return row.same_message ? null : recordConflict(client, userId, spaceId, mutationId, operation, 'message', message.id,
        null, conversation.rows[0] ? Number(conversation.rows[0].version) : null, operation, 'identity_reused');
    }
    if ((!conversation.rowCount && !prior.conversationCreated) || conversation.rows[0]?.deleted_at) {
      return recordConflict(client, userId, spaceId, mutationId, operation, 'message', message.id,
        null, conversation.rows[0] ? Number(conversation.rows[0].version) : null, operation, 'conversation_missing_or_deleted');
    }
    return null;
  }

  if (operation.type === 'personal.chat.proposal.create') {
    const { conversationId, messageId, proposal } = operation;
    const parent = proposalParent(conversationId, messageId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`personal-conversation:${spaceId}:${conversationId}`]);
    const conversation = await client.query<{ deleted_at: Date | null; version: string }>(
      'SELECT deleted_at, version FROM personal_conversations WHERE space_id = $1 AND entity_id = $2 FOR UPDATE',
      [spaceId, conversationId],
    );
    const existing = await client.query<{ tool_name: string; arguments: string; status: string }>(
      `SELECT tool_name, arguments, status FROM personal_chat_proposals
       WHERE space_id = $1 AND conversation_id = $2 AND message_id = $3 AND entity_id = $4 FOR UPDATE`,
      [spaceId, conversationId, messageId, proposal.id],
    );
    if (existing.rowCount) {
      const row = existing.rows[0]!;
      const same = row.tool_name === proposal.toolName && row.arguments === proposal.arguments && row.status === proposal.status;
      return same ? null : recordConflict(client, userId, spaceId, mutationId, operation, 'proposal', JSON.stringify([conversationId, messageId, proposal.id]),
        null, null, operation, 'identity_reused');
    }
    const message = await client.query<{ role: string }>(
      'SELECT role FROM personal_chat_messages WHERE space_id = $1 AND conversation_id = $2 AND entity_id = $3 FOR KEY SHARE',
      [spaceId, conversationId, messageId],
    );
    const hasAssistantMessage = message.rowCount
      ? message.rows[0]!.role === 'assistant'
      : prior.assistantMessageAppended;
    if (!hasAssistantMessage || (!conversation.rowCount && !prior.conversationCreated) || conversation.rows[0]?.deleted_at) {
      return recordConflict(client, userId, spaceId, mutationId, operation, 'proposal', JSON.stringify([conversationId, messageId, proposal.id]),
        null, conversation.rows[0] ? Number(conversation.rows[0].version) : null, operation, 'message_missing_or_not_active_assistant');
    }
    return null;
  }

  if (operation.type === 'personal.chat.proposal.setStatus') {
    const parent = proposalParent(operation.conversationId, operation.messageId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`personal-conversation:${spaceId}:${operation.conversationId}`]);
    const conversation = await client.query<{ deleted_at: Date | null; version: string }>(
      'SELECT deleted_at, version FROM personal_conversations WHERE space_id = $1 AND entity_id = $2 FOR UPDATE',
      [spaceId, operation.conversationId],
    );
    const found = await client.query<{
      status: string; version: string; applied_effect_space_id: string | null;
      applied_effect_mutation_id: string | null; applied_effect_op_id: string | null;
    }>(
      `SELECT status, version, applied_effect_space_id, applied_effect_mutation_id, applied_effect_op_id
       FROM personal_chat_proposals
       WHERE space_id = $1 AND conversation_id = $2 AND message_id = $3 AND entity_id = $4 FOR UPDATE`,
      [spaceId, operation.conversationId, operation.messageId, operation.proposalId],
    );
    if (!found.rowCount) {
      return recordConflict(client, userId, spaceId, mutationId, operation, 'proposal', JSON.stringify([operation.conversationId, operation.messageId, operation.proposalId]),
        operation.baseVersion, null, operation, 'proposal_missing');
    }
    const row = found.rows[0]!;
    const exactApplied = row.status === 'applied'
      && row.applied_effect_space_id === operation.effectSpaceId
      && row.applied_effect_mutation_id === operation.effectMutationId
      && row.applied_effect_op_id === operation.effectOpId;
    if (exactApplied) return null;
    if (row.status === 'applied') {
      return recordConflict(client, userId, spaceId, mutationId, operation, 'proposal', JSON.stringify([operation.conversationId, operation.messageId, operation.proposalId]),
        operation.baseVersion, Number(row.version), operation,
        row.applied_effect_mutation_id === null ? 'historical_applied_status' : 'already_applied_with_different_effect');
    }
    if (!conversation.rowCount || conversation.rows[0]!.deleted_at) {
      return recordConflict(client, userId, spaceId, mutationId, operation, 'proposal', JSON.stringify([operation.conversationId, operation.messageId, operation.proposalId]),
        operation.baseVersion, Number(row.version), operation, 'conversation_missing_or_deleted');
    }
    if (operation.baseVersion !== Number(row.version)) {
      return recordConflict(client, userId, spaceId, mutationId, operation, 'proposal', JSON.stringify([operation.conversationId, operation.messageId, operation.proposalId]),
        operation.baseVersion, Number(row.version), operation, 'version_mismatch');
    }
    await checkEffectReceipt(client, userId, operation);
    return null;
  }

  if (operation.type === 'personal.chat.conversation.delete') {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`personal-conversation:${spaceId}:${operation.id}`]);
    const found = await client.query<{ deleted_at: Date | null; version: string }>(
      'SELECT deleted_at, version FROM personal_conversations WHERE space_id = $1 AND entity_id = $2 FOR UPDATE',
      [spaceId, operation.id],
    );
    const row = found.rows[0];
    if (!row || operation.baseVersion !== Number(row.version)) {
      return recordConflict(client, userId, spaceId, mutationId, operation, 'conversation', operation.id,
        operation.baseVersion, row ? Number(row.version) : null, operation, row ? 'version_mismatch' : 'conversation_missing');
    }
    return null;
  }

  return null;
}

export async function findPersonalContentConflicts(
  client: PoolClient,
  userId: string,
  spaceId: string,
  mutationId: string,
  operations: PersonalContentOperation[],
): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  const createdConversations = new Map<string, number>();
  const appendedAssistantMessages = new Map<string, number>();
  for (const [index, operation] of operations.entries()) {
    if (operation.type === 'personal.chat.conversation.create') createdConversations.set(operation.conversation.id, index);
    if (operation.type === 'personal.chat.message.append' && operation.message.role === 'assistant') {
      appendedAssistantMessages.set(JSON.stringify([operation.conversationId, operation.message.id]), index);
    }
  }
  for (const [index, operation] of operations.entries()) {
    const conversationId = operation.type === 'personal.chat.conversation.create'
      ? operation.conversation.id
      : 'conversationId' in operation ? operation.conversationId
        : operation.type === 'personal.chat.conversation.delete' ? operation.id
          : null;
    const messageId = operation.type === 'personal.chat.proposal.create' || operation.type === 'personal.chat.proposal.setStatus'
      ? operation.messageId
      : operation.type === 'personal.chat.message.append' ? operation.message.id : null;
    const createdIndex = conversationId === null ? undefined : createdConversations.get(conversationId);
    const appendedIndex = conversationId === null || messageId === null
      ? undefined
      : appendedAssistantMessages.get(JSON.stringify([conversationId, messageId]));
    const conflict = await findConflict(client, userId, spaceId, mutationId, operation, {
      conversationCreated: createdIndex !== undefined && createdIndex < index,
      assistantMessageAppended: appendedIndex !== undefined && appendedIndex < index,
    });
    if (conflict) conflicts.push(conflict);
  }
  return conflicts;
}

async function applyPreference(client: PoolClient, userId: string, spaceId: string,
  operation: Extract<PersonalContentOperation, { type: 'personal.preference.set' }>) {
  const found = await client.query<{ value: unknown; deleted_at: Date | null; version: string }>(
    'SELECT value, deleted_at, version FROM personal_profile_fields WHERE space_id = $1 AND field_key = $2 FOR UPDATE',
    [spaceId, operation.field],
  );
  const row = found.rows[0];
  const currentValue = row && !row.deleted_at ? row.value : null;
  if ((!row || row.deleted_at) && operation.value === null) return { opId: operation.opId, status: 'ignored', reason: 'already_absent' };
  if (row && currentValue === operation.value) return { opId: operation.opId, status: 'ignored', reason: 'already_current' };
  if (row) {
    await client.query(
      `UPDATE personal_profile_fields SET value = $3::jsonb,
        deleted_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now(),
        version = version + 1, updated_by = $5 WHERE space_id = $1 AND field_key = $2`,
      [spaceId, operation.field, operation.value === null ? null : JSON.stringify(operation.value),
        operation.value === null, userId],
    );
  } else {
    await client.query(
      `INSERT INTO personal_profile_fields(id, entity_id, space_id, field_key, value, deleted_at, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,CASE WHEN $6 THEN now() ELSE NULL END,$7)`,
      [contentStorageId('personal_profile_fields', spaceId, null, operation.field), operation.field, spaceId,
        operation.field, operation.value === null ? null : JSON.stringify(operation.value),
        operation.value === null, userId],
    );
  }
  const version = Number(row?.version ?? 0) + 1;
  return { opId: operation.opId, status: 'applied', entityId: operation.field, version };
}

async function applyAllergy(client: PoolClient, userId: string, spaceId: string,
  operation: Extract<PersonalContentOperation, { type: 'personal.allergy.set' }>) {
  const normalized = allergyIdentity(operation.name);
  const found = await client.query<{ entity_id: string; name: string; deleted_at: Date | null; version: string }>(
    'SELECT entity_id, name, deleted_at, version FROM personal_allergies WHERE space_id = $1 AND normalized_name = $2 FOR UPDATE',
    [spaceId, normalized],
  );
  const row = found.rows[0];
  if ((!row || row.deleted_at) && !operation.enabled) return { opId: operation.opId, status: 'ignored', reason: 'already_absent' };
  if (row && !row.deleted_at && operation.enabled && row.name === operation.name) {
    return { opId: operation.opId, status: 'ignored', reason: 'already_current' };
  }
  if (row) {
    await client.query(
      `UPDATE personal_allergies SET name = $3,
        deleted_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now(),
        version = version + 1, updated_by = $5 WHERE space_id = $1 AND normalized_name = $2`,
      [spaceId, normalized, operation.name, !operation.enabled, userId],
    );
  } else {
    await client.query(
      `INSERT INTO personal_allergies(id, entity_id, space_id, name, normalized_name, deleted_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,CASE WHEN $6 THEN NULL ELSE now() END,$7)`,
      [contentStorageId('personal_allergies', spaceId, null, normalized), normalized, spaceId,
        operation.name, normalized, operation.enabled, userId],
    );
  }
  return { opId: operation.opId, status: 'applied', entityId: normalized, version: Number(row?.version ?? 0) + 1 };
}

async function applyConversationCreate(client: PoolClient, userId: string, spaceId: string,
  operation: Extract<PersonalContentOperation, { type: 'personal.chat.conversation.create' }>) {
  const { id, title, createdAt } = operation.conversation;
  const found = await client.query<{ title: string; created_at: Date; deleted_at: Date | null }>(
    'SELECT title, created_at, deleted_at FROM personal_conversations WHERE space_id = $1 AND entity_id = $2 FOR UPDATE',
    [spaceId, id],
  );
  if (found.rowCount) return { opId: operation.opId, status: 'ignored', reason: 'already_exists', entityId: id };
  await client.query(
    `INSERT INTO personal_conversations(id, entity_id, space_id, title, created_at, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$5,$6)`,
    [contentStorageId('personal_conversations', spaceId, null, id), id, spaceId, title, createdAt, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: id, version: 1 };
}

async function applyMessageAppend(client: PoolClient, userId: string, spaceId: string,
  operation: Extract<PersonalContentOperation, { type: 'personal.chat.message.append' }>) {
  const { conversationId, message } = operation;
  const found = await client.query<{ created_at: Date }>(
    'SELECT created_at FROM personal_chat_messages WHERE space_id = $1 AND conversation_id = $2 AND entity_id = $3 FOR UPDATE',
    [spaceId, conversationId, message.id],
  );
  if (found.rowCount) return { opId: operation.opId, status: 'ignored', reason: 'already_exists', entityId: message.id };
  await client.query(
    `INSERT INTO personal_chat_messages(id, entity_id, space_id, conversation_id, role, content, created_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [contentStorageId('personal_chat_messages', spaceId, conversationId, message.id), message.id,
      spaceId, conversationId, message.role, message.content, message.createdAt, userId],
  );
  const advanced = await client.query<{ version: string }>(
    `UPDATE personal_conversations SET updated_at = GREATEST(updated_at, $3::timestamptz),
       version = version + 1, updated_by = $4
     WHERE space_id = $1 AND entity_id = $2 RETURNING version`,
    [spaceId, conversationId, message.createdAt, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: message.id, version: Number(advanced.rows[0]!.version) };
}

async function applyProposalCreate(client: PoolClient, userId: string, spaceId: string,
  operation: Extract<PersonalContentOperation, { type: 'personal.chat.proposal.create' }>) {
  const { conversationId, messageId, proposal } = operation;
  const existing = await client.query(
    `SELECT 1 FROM personal_chat_proposals WHERE space_id = $1 AND conversation_id = $2
       AND message_id = $3 AND entity_id = $4 FOR UPDATE`,
    [spaceId, conversationId, messageId, proposal.id],
  );
  if (existing.rowCount) return { opId: operation.opId, status: 'ignored', reason: 'already_exists', entityId: proposal.id };
  await client.query(
    `INSERT INTO personal_chat_proposals(
       id, entity_id, space_id, conversation_id, message_id, tool_name, arguments, status, updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [contentStorageId('personal_chat_proposals', spaceId, proposalParent(conversationId, messageId), proposal.id),
      proposal.id, spaceId, conversationId, messageId, proposal.toolName, proposal.arguments, proposal.status, userId],
  );
  const messageTime = await client.query<{ created_at: Date }>(
    'SELECT created_at FROM personal_chat_messages WHERE space_id = $1 AND conversation_id = $2 AND entity_id = $3',
    [spaceId, conversationId, messageId],
  );
  await client.query(
    `UPDATE personal_conversations SET updated_at = GREATEST(updated_at, $3::timestamptz),
       version = version + 1, updated_by = $4 WHERE space_id = $1 AND entity_id = $2`,
    [spaceId, conversationId, messageTime.rows[0]!.created_at, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: proposal.id, version: 1,
    historicalApplied: proposal.status === 'applied' };
}

async function applyProposalStatus(client: PoolClient, userId: string, spaceId: string,
  operation: Extract<PersonalContentOperation, { type: 'personal.chat.proposal.setStatus' }>) {
  const { conversationId, messageId, proposalId } = operation;
  const found = await client.query<{
    status: string; version: string; applied_effect_space_id: string | null;
    applied_effect_mutation_id: string | null; applied_effect_op_id: string | null;
  }>(
    `SELECT status, version, applied_effect_space_id, applied_effect_mutation_id, applied_effect_op_id
     FROM personal_chat_proposals WHERE space_id = $1 AND conversation_id = $2 AND message_id = $3 AND entity_id = $4 FOR UPDATE`,
    [spaceId, conversationId, messageId, proposalId],
  );
  const row = found.rows[0]!;
  if (row.status === 'applied') return { opId: operation.opId, status: 'ignored', reason: 'already_applied', entityId: proposalId };
  const updated = await client.query<{ version: string }>(
    `UPDATE personal_chat_proposals SET status = 'applied', applied_effect_space_id = $5,
       applied_effect_mutation_id = $6, applied_effect_op_id = $7, updated_at = now(),
       version = version + 1, updated_by = $8
     WHERE space_id = $1 AND conversation_id = $2 AND message_id = $3 AND entity_id = $4
     RETURNING version`,
    [spaceId, conversationId, messageId, proposalId, operation.effectSpaceId,
      operation.effectMutationId, operation.effectOpId, userId],
  );
  await client.query(
    `UPDATE personal_conversations SET updated_at = now(), version = version + 1, updated_by = $3
     WHERE space_id = $1 AND entity_id = $2`,
    [spaceId, conversationId, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: proposalId, version: Number(updated.rows[0]!.version) };
}

async function applyConversationDelete(client: PoolClient, userId: string, spaceId: string,
  operation: Extract<PersonalContentOperation, { type: 'personal.chat.conversation.delete' }>) {
  const found = await client.query<{ deleted_at: Date | null; version: string }>(
    'SELECT deleted_at, version FROM personal_conversations WHERE space_id = $1 AND entity_id = $2 FOR UPDATE',
    [spaceId, operation.id],
  );
  const row = found.rows[0]!;
  if (row.deleted_at) return { opId: operation.opId, status: 'ignored', reason: 'already_deleted', entityId: operation.id };
  const updated = await client.query<{ version: string }>(
    `UPDATE personal_conversations SET deleted_at = now(), updated_at = now(),
       version = version + 1, updated_by = $3 WHERE space_id = $1 AND entity_id = $2 RETURNING version`,
    [spaceId, operation.id, userId],
  );
  return { opId: operation.opId, status: 'applied', entityId: operation.id, version: Number(updated.rows[0]!.version) };
}

export async function applyPersonalContentOperation(
  client: PoolClient,
  userId: string,
  spaceId: string,
  operation: PersonalContentOperation,
) {
  switch (operation.type) {
    case 'personal.preference.set': return applyPreference(client, userId, spaceId, operation);
    case 'personal.allergy.set': return applyAllergy(client, userId, spaceId, operation);
    case 'personal.chat.conversation.create': return applyConversationCreate(client, userId, spaceId, operation);
    case 'personal.chat.message.append': return applyMessageAppend(client, userId, spaceId, operation);
    case 'personal.chat.proposal.create': return applyProposalCreate(client, userId, spaceId, operation);
    case 'personal.chat.proposal.setStatus': return applyProposalStatus(client, userId, spaceId, operation);
    case 'personal.chat.conversation.delete': return applyConversationDelete(client, userId, spaceId, operation);
  }
}
