import type { CommonPowerSyncDatabase, Transaction } from '@powersync/common';
import type { ContentMutationOperation, ContentMutationRequest } from '../account/contracts';
import { DEFAULT_STATE } from '../domain/defaults';
import type { ChefToolProposal, PersistedState } from '../domain/types';
import { type ContentRows, type ContentRecord, decodeContentRows, encodeContentRows, privateStateFrom, mergeGuestPrivateState } from './recordCodec';
import { remapGuestPersonalStateForWorkspace, remapGuestStateForWorkspace } from './adoptionMapping';
import { buildContentMutationOperations, buildGuestAdoptionMutationOperations, splitContentOperations, withOperationIds } from './mutations';
import { buildPersonalMutationOperations } from './personalMutations';
import { decodePersonalRows, encodePersonalRows, hasPersonalRows, normalizeAllergyName, PERSONAL_TABLES, personalConversationsFromState } from './personalRecordCodec';
import { getContentDatabase } from './powerSyncDatabase';
import { LOCAL_GUEST_SPACE_ID, PERSONAL_CONTENT_TABLES, SHARED_TABLES } from './powerSyncSchema';

export type ContentScope =
  | { kind: 'guest'; profileId: 'guest'; spaceId: typeof LOCAL_GUEST_SPACE_ID }
  | { kind: 'account'; profileId: string; spaceId: string; workspaceKind: 'personal' | 'household'; personalSpaceId: string | null };

export type CachedWorkspaceSelection = {
  spaceId: string;
  workspaceKind: 'personal' | 'household';
  personalSpaceId: string | null;
};

export type GuestAdoptionStatus = {
  available: boolean;
  migrationId: string | null;
  decision: 'merge' | 'keep' | 'in-progress' | null;
};

type TableRows = Record<string, ContentRecord[]>;
type ContentReader = {
  getAll<T>(query: string, parameters?: unknown[]): Promise<T[]>;
  getOptional<T>(query: string, parameters?: unknown[]): Promise<T | null>;
};
type MigrationReceipt = {
  migrationId: string;
  decision: 'merge' | 'keep' | 'in-progress';
  uploadGroup?: string;
  uploadGroups?: Array<{ spaceId: string; group: string }>;
  completedBatches: string[];
  recordCount: number;
  updatedAt: string;
};

const LEGACY_MIGRATION_ID = 'legacy-aggregate-v1';
const PRIVATE_ROW_ID = 'private-state';
const MIGRATION_BATCH_SIZE = 80;
const RECORD_TABLE_ORDER = [
  'pantry_items',
  'recipes',
  'recipe_ingredients',
  'recipe_steps',
  'shopping_lists',
  'shopping_cycles',
  'shopping_items',
  'shopping_purchases'
] as const;

const GUEST_TABLES = new Set<string>(SHARED_TABLES.map((name) => `guest_${name}`));

function adoptionMutationBase(spaceId: string, migrationId: string): string {
  return `guest-adoption-v2-${shortHash(`${spaceId}\0${migrationId}`)}`;
}

function isMutationInGroup(mutationId: string, group: string): boolean {
  return mutationId === group || mutationId.startsWith(`${group}-`);
}

function decodeMigrationReceipt(value: string): MigrationReceipt | null {
  try {
    const receipt = JSON.parse(value) as MigrationReceipt;
    return receipt && typeof receipt.migrationId === 'string' && Array.isArray(receipt.completedBatches)
      ? receipt
      : null;
  } catch {
    return null;
  }
}

async function finishAdoptionIfUploaded(
  transaction: Transaction,
  migrationId: string,
  fallbackSpaceId: string,
  receipt: MigrationReceipt
): Promise<MigrationReceipt> {
  if (receipt.decision === 'keep') return receipt;
  const uploadGroup = receipt.uploadGroup ?? adoptionMutationBase(fallbackSpaceId, migrationId);
  if (!receipt.completedBatches.includes('local-complete')) return { ...receipt, uploadGroup };

  const groups = receipt.uploadGroups?.length
    ? receipt.uploadGroups
    : [{ spaceId: fallbackSpaceId, group: uploadGroup }];
  for (const group of groups) {
    const outboxRows = await transaction.getAll<{ mutation_id: string }>(
      'SELECT mutation_id FROM local_content_outbox WHERE space_id = ?', [group.spaceId]
    );
    if (outboxRows.some((row) => isMutationInGroup(row.mutation_id, group.group))) {
      return { ...receipt, uploadGroup, decision: 'in-progress' };
    }
  }

  const completedBatches = [...new Set([...receipt.completedBatches, 'remote-complete'])];
  const complete = { ...receipt, uploadGroup, uploadGroups: groups, decision: 'merge' as const, completedBatches, updatedAt: new Date().toISOString() };
  await setLocalJson(transaction, 'local_migrations', migrationId, complete);
  return complete;
}

function tableName(scope: ContentScope, name: string): string {
  const table = scope.kind === 'guest' ? `guest_${name}` : name;
  if (scope.kind === 'guest' && !GUEST_TABLES.has(table)) throw new Error('Unsupported guest content table.');
  if (scope.kind === 'account' && !(SHARED_TABLES as string[]).includes(table)) throw new Error('Unsupported shared content table.');
  return table;
}

function rowColumns(row: Record<string, unknown>): string[] {
  return Object.keys(row);
}

function sameSqlValue(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  return left === right;
}

function removalColumn(table: string): 'deleted_at' | 'removed_at' | null {
  const contentTable = table.startsWith('guest_') ? table.slice('guest_'.length) : table;
  if (contentTable === 'shopping_lists' || contentTable === 'shopping_items') return 'removed_at';
  if (contentTable === 'pantry_items' || contentTable === 'recipes' || contentTable === 'recipe_ingredients' || contentTable === 'recipe_steps'
    || contentTable === 'personal_allergies' || contentTable === 'personal_conversations') return 'deleted_at';
  return null;
}

async function insertRow(transaction: Transaction, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = rowColumns(row);
  const placeholders = columns.map(() => '?').join(', ');
  await transaction.execute(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => row[column] ?? null)
  );
}

async function archiveNoResurrection(
  transaction: Transaction,
  table: string,
  scope: ContentScope,
  row: ContentRecord,
  reason: string
): Promise<void> {
  const id = `restore-${shortHash(`${scope.spaceId}\0${table}\0${row.id}`)}`;
  const existing = await transaction.getOptional<{ id: string }>('SELECT id FROM local_sync_issues WHERE id = ?', [id]);
  if (existing) return;
  await insertRow(transaction, 'local_sync_issues', {
    id,
    space_id: scope.spaceId,
    issue_type: 'deleted-record-restore-blocked',
    message: reason,
    data_json: JSON.stringify({ table, record: row }),
    created_at: new Date().toISOString(),
    resolved_at: null
  });
}

async function reconcileRows(
  transaction: Transaction,
  table: string,
  scope: ContentScope,
  desiredRows: ContentRecord[],
  options: { tombstoneMissing?: boolean; immutableExisting?: boolean } = {}
): Promise<void> {
  const currentRows = await transaction.getAll<ContentRecord>(`SELECT * FROM ${table} WHERE space_id = ?`, [scope.spaceId]);
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const desiredById = new Map(desiredRows.map((row) => [row.id, row]));

  for (const desired of desiredRows) {
    const current = currentById.get(desired.id);
    if (current && current.space_id !== scope.spaceId) {
      await archiveNoResurrection(transaction, table, scope, desired, 'A record with this stable ID already belongs to another workspace. The attempted copy was preserved locally.');
      continue;
    }
    if (current) {
      const removedColumn = removalColumn(table);
      if ((current.deleted_at || current.removed_at) && (!removedColumn || !desired[removedColumn])) {
        await archiveNoResurrection(transaction, table, scope, desired, 'A removed record cannot be restored with its old ID. The attempted copy was preserved locally.');
        continue;
      }
      // Personal conversations, messages, proposals, and allergy identities are
      // create/append records. Status changes and removals use explicit commands.
      // Re-encoding the aggregate must not overwrite server timestamps or replay
      // a stale proposal status onto an existing replicated row.
      if (options.immutableExisting) continue;

      const mutableColumns = rowColumns(desired).filter((column) => (
        column !== 'id' && column !== 'version' && column !== 'updated_by'
      ));
      const changed = mutableColumns.filter((column) => !sameSqlValue(current[column], desired[column]));
      if (!changed.length) continue;
      const versionValue = Number(current.version);
      const versionUpdate = Number.isFinite(versionValue) ? versionValue + 1 : 2;
      const hasVersion = table !== 'shopping_cycles' && table !== 'shopping_purchases';
      const setColumns = hasVersion ? [...changed.map((column) => `${column} = ?`), 'version = ?'] : changed.map((column) => `${column} = ?`);
      const parameters = hasVersion
        ? [...changed.map((column) => desired[column] ?? null), versionUpdate, desired.id, scope.spaceId]
        : [...changed.map((column) => desired[column] ?? null), desired.id, scope.spaceId];
      await transaction.execute(
        `UPDATE ${table} SET ${setColumns.join(', ')} WHERE id = ? AND space_id = ?`,
        parameters
      );
      continue;
    }
    await insertRow(transaction, table, desired);
  }

  if (!options.tombstoneMissing) return;
  const removable = removalColumn(table);
  if (!removable) return;
  const now = new Date().toISOString();
  for (const current of currentRows) {
    if (desiredById.has(current.id) || current[removable]) continue;
    await transaction.execute(
      `UPDATE ${table} SET ${removable} = ?, updated_at = ? WHERE id = ? AND space_id = ?`,
      [now, now, current.id, scope.spaceId]
    );
  }
}

function createMutationId(): string {
  const runtimeCrypto = globalThis.crypto as Crypto | undefined;
  if (typeof runtimeCrypto?.randomUUID === 'function') return `cc-${runtimeCrypto.randomUUID()}`;
  if (typeof runtimeCrypto?.getRandomValues === 'function') {
    const bytes = runtimeCrypto.getRandomValues(new Uint8Array(16));
    return `cc-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function writePrivateState(
  transaction: Transaction,
  state: PersistedState,
  profileKind: 'guest' | 'account',
  hasPersonalWorkspace = false
): Promise<void> {
  const privateState = profileKind === 'guest' || !hasPersonalWorkspace
    ? privateStateFrom(state)
    : {
      activeConversationId: state.activeConversationId,
      settings: {
        providerId: state.settings.providerId,
        model: state.settings.model,
        dictationEngine: state.settings.dictationEngine,
        sendLocalTime: state.settings.sendLocalTime
      }
    };
  const data = JSON.stringify(privateState);
  const current = await transaction.getOptional<{ data_json: string }>(
    'SELECT data_json FROM local_private_state WHERE id = ?',
    [PRIVATE_ROW_ID]
  );
  if (current?.data_json === data) return;
  const updatedAt = new Date().toISOString();
  if (current) {
    await transaction.execute('UPDATE local_private_state SET data_json = ?, updated_at = ? WHERE id = ?', [data, updatedAt, PRIVATE_ROW_ID]);
  } else {
    await insertRow(transaction, 'local_private_state', { id: PRIVATE_ROW_ID, data_json: data, updated_at: updatedAt });
  }
}

async function setLocalJson(transaction: Transaction, table: 'local_migrations' | 'local_profile_preferences', id: string, value: unknown): Promise<void> {
  const current = await transaction.getOptional<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, [id]);
  const data = JSON.stringify(value);
  const updatedAt = new Date().toISOString();
  if (current) {
    await transaction.execute(`UPDATE ${table} SET value = ?, updated_at = ? WHERE id = ?`, [data, updatedAt, id]);
  } else {
    await insertRow(transaction, table, { id, value: data, updated_at: updatedAt });
  }
}

async function readLocalJson<T>(db: CommonPowerSyncDatabase, table: 'local_migrations' | 'local_profile_preferences', id: string, fallback: T): Promise<T> {
  const row = await db.getOptional<{ value: string }>(`SELECT value FROM ${table} WHERE id = ?`, [id]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

type PersonalRowVersions = {
  preferences: Map<string, number | null>;
  allergies: Map<string, number | null>;
  conversations: Map<string, number>;
};

async function readPersonalVersions(reader: ContentReader, spaceId: string): Promise<PersonalRowVersions> {
  const [fields, allergies, conversations] = await Promise.all([
    reader.getAll<{ field_key: string; version: number | null }>('SELECT field_key, version FROM personal_profile_fields WHERE space_id = ?', [spaceId]),
    reader.getAll<{ normalized_name: string; version: number | null }>('SELECT normalized_name, version FROM personal_allergies WHERE space_id = ?', [spaceId]),
    reader.getAll<{ entity_id: string; version: number }>('SELECT entity_id, version FROM personal_conversations WHERE space_id = ?', [spaceId])
  ]);
  return {
    preferences: new Map(fields.map((row) => [row.field_key, row.version === null ? null : Number(row.version)])),
    allergies: new Map(allergies.map((row) => [row.normalized_name, row.version === null ? null : Number(row.version)])),
    conversations: new Map(conversations.map((row) => [row.entity_id, Number(row.version) || 1]))
  };
}

async function insertMutationBatches(
  transaction: Transaction,
  spaceId: string,
  operations: ContentMutationOperation[],
  stableBaseId?: string
): Promise<string[]> {
  if (!operations.length) return [];
  const baseId = stableBaseId ?? createMutationId();
  const batches = splitContentOperations(operations);
  const ids: string[] = [];
  for (const [index, batch] of batches.entries()) {
    const id = batches.length === 1 ? baseId : `${baseId}-${index}`;
    const request: ContentMutationRequest = { mutationId: id, operations: withOperationIds(id, batch) };
    const payload = JSON.stringify(request);
    const existing = await transaction.getOptional<{ id: string; space_id: string; payload_json: string }>(
      'SELECT id, space_id, payload_json FROM local_content_outbox WHERE id = ?', [id]
    );
    if (existing && (existing.space_id !== spaceId || existing.payload_json !== payload)) {
      throw new Error('A saved content action reused an upload identity with different content. The local change was kept for recovery.');
    }
    if (!existing) {
      await insertRow(transaction, 'local_content_outbox', {
        id,
        space_id: spaceId,
        mutation_id: id,
        payload_json: payload,
        state: 'pending',
        error_json: null,
        created_at: new Date().toISOString()
      });
    }
    ids.push(id);
  }
  return ids;
}

async function migrateAccountPrivateAggregate(
  transaction: Transaction,
  scope: Extract<ContentScope, { kind: 'account' }>,
  state: PersistedState
): Promise<void> {
  const personalSpaceId = scope.personalSpaceId;
  if (!personalSpaceId) return;
  const migrationId = `personal-private-content-v1:${personalSpaceId}`;
  const marker = await transaction.getOptional<{ id: string }>('SELECT id FROM local_migrations WHERE id = ?', [migrationId]);
  if (marker) return;

  const legacyRow = await transaction.getOptional<{ data_json: string }>(
    'SELECT data_json FROM local_private_state WHERE id = ?', [PRIVATE_ROW_ID]
  );
  if (legacyRow) {
    const archiveId = `legacy-private-${shortHash(`${scope.profileId}\0${personalSpaceId}`)}`;
    const existingArchive = await transaction.getOptional<{ id: string }>('SELECT id FROM local_archives WHERE id = ?', [archiveId]);
    if (!existingArchive) {
      await insertRow(transaction, 'local_archives', {
        id: archiveId,
        scope_id: scope.profileId,
        kind: 'legacy-private-content',
        data_json: legacyRow.data_json,
        created_at: new Date().toISOString()
      });
    }
  }

  const personalRows = await readPersonalRows(transaction, personalSpaceId);
  const remotePrivate = decodePersonalRows(personalRows, DEFAULT_STATE, state.activeConversationId);
  const remoteBaseline: PersistedState = {
    ...DEFAULT_STATE,
    ...remotePrivate,
    activeConversationId: state.activeConversationId,
    settings: {
      ...DEFAULT_STATE.settings,
      ...remotePrivate.settings,
      providerId: state.settings.providerId,
      model: state.settings.model,
      dictationEngine: state.settings.dictationEngine,
      sendLocalTime: state.settings.sendLocalTime
    },
    pantry: state.pantry,
    recipes: state.recipes,
    shopping: state.shopping
  };
  const versions = await readPersonalVersions(transaction, personalSpaceId);
  const operations = buildPersonalMutationOperations(remoteBaseline, state, versions);
  const migrationGroup = `personal-private-migration-${shortHash(`${scope.profileId}\0${personalSpaceId}`)}`;
  await insertMutationBatches(transaction, personalSpaceId, operations, migrationGroup);
  for (const table of PERSONAL_TABLES) {
    await reconcileRows(transaction, table, { ...scope, spaceId: personalSpaceId },
      encodePersonalRows(state, personalSpaceId)[table], { tombstoneMissing: true });
  }
  const receipt: MigrationReceipt = {
    migrationId,
    decision: 'in-progress',
    uploadGroup: migrationGroup,
    uploadGroups: [{ spaceId: personalSpaceId, group: migrationGroup }],
    completedBatches: ['local-complete'],
    recordCount: operations.length,
    updatedAt: new Date().toISOString()
  };
  await setLocalJson(transaction, 'local_migrations', migrationId, receipt);
  await finishAdoptionIfUploaded(transaction, migrationId, personalSpaceId, receipt);
}

function privateStateFromStored(raw: string | null, defaults: PersistedState): PersistedState {
  if (!raw) return defaults;
  try {
    const privateState = JSON.parse(raw) as Partial<PersistedState>;
    return {
      ...defaults,
      ...(Array.isArray(privateState.chatMessages) ? { chatMessages: privateState.chatMessages } : {}),
      ...(Array.isArray(privateState.chatHistory) ? { chatHistory: privateState.chatHistory } : {}),
      ...(privateState.activeConversationId === null || typeof privateState.activeConversationId === 'string'
        ? { activeConversationId: privateState.activeConversationId }
        : {}),
      ...(privateState.mealContext && typeof privateState.mealContext === 'object' ? { mealContext: privateState.mealContext } : {}),
      ...(privateState.settings && typeof privateState.settings === 'object'
        ? { settings: { ...defaults.settings, ...privateState.settings } }
        : {})
    };
  } catch {
    return defaults;
  }
}

function deviceStateFromStored(raw: string | null, defaults: PersistedState): Pick<PersistedState, 'activeConversationId' | 'settings'> {
  const stored = privateStateFromStored(raw, defaults);
  return {
    activeConversationId: stored.activeConversationId,
    settings: {
      ...defaults.settings,
      providerId: stored.settings.providerId,
      model: stored.settings.model,
      dictationEngine: stored.settings.dictationEngine,
      sendLocalTime: stored.settings.sendLocalTime
    }
  };
}

async function readPersonalRows(db: ContentReader, spaceId: string): Promise<Partial<Record<(typeof PERSONAL_TABLES)[number], ContentRecord[]>>> {
  const rows: Partial<Record<(typeof PERSONAL_TABLES)[number], ContentRecord[]>> = {};
  for (const table of PERSONAL_TABLES) {
    rows[table] = await db.getAll<ContentRecord>(`SELECT * FROM ${table} WHERE space_id = ?`, [spaceId]);
  }
  return rows;
}

function mergeLegacyPersonalContent(
  remote: Pick<PersistedState, 'chatMessages' | 'chatHistory' | 'mealContext' | 'settings'>,
  legacy: PersistedState,
  rows: Partial<Record<(typeof PERSONAL_TABLES)[number], ContentRecord[]>>,
  activeConversationId: string | null
): Pick<PersistedState, 'chatMessages' | 'chatHistory' | 'mealContext' | 'settings' | 'activeConversationId'> {
  const fieldRows = new Map((rows.personal_profile_fields ?? []).map((row) => [String(row.field_key ?? row.entity_id), row]));
  const personalRows = rows.personal_conversations ?? [];
  const conversationRowIds = new Set(personalRows.map((row) => String(row.entity_id ?? row.id)));
  const remoteConversations = [
    ...remote.chatHistory,
    ...(remote.chatMessages.length && activeConversationId
      ? personalConversationsFromState({ ...DEFAULT_STATE, ...remote, activeConversationId })
        .filter((conversation) => conversation.id === activeConversationId)
      : [])
  ];
  const conversations = new Map(remoteConversations.map((conversation) => [conversation.id, conversation]));
  for (const conversation of personalConversationsFromState(legacy)) {
    if (!conversationRowIds.has(conversation.id) && !conversations.has(conversation.id)) {
      conversations.set(conversation.id, conversation);
    }
  }
  const selectedConversationId = activeConversationId && conversations.has(activeConversationId)
    ? activeConversationId
    : null;
  const allConversations = [...conversations.values()];
  const activeConversation = selectedConversationId
    ? conversations.get(selectedConversationId) ?? null
    : null;
  const remoteAllergies = new Map(remote.settings.allergies.map((name) => [normalizeAllergyName(name), name]));
  for (const name of legacy.settings.allergies) {
    const normalized = normalizeAllergyName(name);
    const row = (rows.personal_allergies ?? []).find((item) => String(item.normalized_name ?? item.entity_id) === normalized);
    if (normalized && !row && !remoteAllergies.has(normalized)) remoteAllergies.set(normalized, name);
  }
  const settings = {
    ...remote.settings,
    systemPrompt: fieldRows.has('systemPrompt') ? remote.settings.systemPrompt : legacy.settings.systemPrompt,
    city: fieldRows.has('city') ? remote.settings.city : legacy.settings.city,
    allergies: [...remoteAllergies.values()],
    providerId: legacy.settings.providerId,
    model: legacy.settings.model,
    dictationEngine: legacy.settings.dictationEngine,
    sendLocalTime: legacy.settings.sendLocalTime
  };
  const mealContext = {
    willingToShop: fieldRows.has('mealContext.willingToShop') ? remote.mealContext.willingToShop : legacy.mealContext.willingToShop,
    portions: fieldRows.has('mealContext.portions') ? remote.mealContext.portions : legacy.mealContext.portions,
    cooks: fieldRows.has('mealContext.cooksCount') ? remote.mealContext.cooks : legacy.mealContext.cooks
  };
  return {
    activeConversationId: selectedConversationId,
    chatMessages: activeConversation?.messages ?? [],
    chatHistory: allConversations.filter((conversation) => conversation.id !== activeConversation?.id),
    mealContext,
    settings
  };
}

export async function openContentProfile(profileId: string): Promise<CommonPowerSyncDatabase> {
  return getContentDatabase(profileId);
}

export async function migrateLegacyAggregate(
  db: CommonPowerSyncDatabase,
  state: PersistedState | null
): Promise<boolean> {
  const legacy = state ?? DEFAULT_STATE;
  const rows = encodeContentRows(legacy, LOCAL_GUEST_SPACE_ID);
  return db.writeTransaction(async (transaction) => {
    const marker = await transaction.getOptional<{ id: string }>('SELECT id FROM local_migrations WHERE id = ?', [LEGACY_MIGRATION_ID]);
    if (marker) return false;
    if (state) {
      const archive = await transaction.getOptional<{ id: string }>('SELECT id FROM local_archives WHERE id = ?', [LEGACY_MIGRATION_ID]);
      if (!archive) {
        await insertRow(transaction, 'local_archives', {
          id: LEGACY_MIGRATION_ID,
          scope_id: 'guest',
          kind: 'legacy-aggregate-v1',
          data_json: JSON.stringify(state),
          created_at: new Date().toISOString()
        });
      }
      for (const name of RECORD_TABLE_ORDER) {
        await reconcileRows(transaction, `guest_${name}`, { kind: 'guest', profileId: 'guest', spaceId: LOCAL_GUEST_SPACE_ID }, rows[name], { tombstoneMissing: false });
      }
      await writePrivateState(transaction, legacy, 'guest');
    }
    await insertRow(transaction, 'local_migrations', {
      id: LEGACY_MIGRATION_ID,
      value: JSON.stringify({ complete: true, hadLegacyData: Boolean(state), updatedAt: new Date().toISOString() }),
      updated_at: new Date().toISOString()
    });
    return Boolean(state);
  });
}

export async function loadWorkspaceState(
  db: ContentReader,
  scope: ContentScope,
  defaults: PersistedState = DEFAULT_STATE
): Promise<PersistedState> {
  const rows: TableRows = {};
  for (const name of RECORD_TABLE_ORDER) {
    const table = tableName(scope, name);
    rows[name] = await db.getAll<ContentRecord>(`SELECT * FROM ${table} WHERE space_id = ?`, [scope.spaceId]);
  }
  const privateRow = await db.getOptional<{ data_json: string }>(
    'SELECT data_json FROM local_private_state WHERE id = ?',
    [PRIVATE_ROW_ID]
  );
  const content = decodeContentRows(rows as Partial<ContentRows>, defaults);
  if (scope.kind === 'guest' || !scope.personalSpaceId) {
    const privateState = privateStateFromStored(privateRow?.data_json ?? null, defaults);
    return { ...privateState, ...content };
  }

  const personalRows = await readPersonalRows(db, scope.personalSpaceId);
  const device = deviceStateFromStored(privateRow?.data_json ?? null, defaults);
  const personal = decodePersonalRows(personalRows, defaults, device.activeConversationId);
  const migrationId = `personal-private-content-v1:${scope.personalSpaceId}`;
  const migrated = await db.getOptional<{ id: string }>('SELECT id FROM local_migrations WHERE id = ?', [migrationId]);
  const legacy = privateStateFromStored(privateRow?.data_json ?? null, defaults);
  const privateContent = migrated
    ? { ...personal, activeConversationId: device.activeConversationId }
    : mergeLegacyPersonalContent(personal, legacy, personalRows, device.activeConversationId);
  return {
    ...privateContent,
    settings: {
      ...privateContent.settings,
      providerId: device.settings.providerId,
      model: device.settings.model,
      dictationEngine: device.settings.dictationEngine,
      sendLocalTime: device.settings.sendLocalTime
    },
    ...content
  };
}

export async function persistWorkspaceState(
  db: CommonPowerSyncDatabase,
  scope: ContentScope,
  state: PersistedState
): Promise<void> {
  const rows = encodeContentRows(state, scope.spaceId);
  await db.writeTransaction(async (transaction) => {
    const previousState = await loadWorkspaceState(transaction, scope, DEFAULT_STATE);
    const recipeRows = scope.kind === 'account'
      ? await transaction.getAll<{ entity_id: string; version: number }>(
        'SELECT entity_id, version FROM recipes WHERE space_id = ?', [scope.spaceId]
      )
      : [];
    const operations = scope.kind === 'account'
      ? buildContentMutationOperations(previousState, state, {
        recipes: new Map(recipeRows.map((row) => [row.entity_id, Number(row.version) || 1]))
      })
      : [];
    for (const name of RECORD_TABLE_ORDER) {
      await reconcileRows(transaction, tableName(scope, name), scope, rows[name], { tombstoneMissing: true });
    }
    if (scope.kind === 'account' && scope.personalSpaceId) {
      const migrationId = `personal-private-content-v1:${scope.personalSpaceId}`;
      const migrated = await transaction.getOptional<{ id: string }>(
        'SELECT id FROM local_migrations WHERE id = ?', [migrationId]
      );
      if (!migrated) {
        await migrateAccountPrivateAggregate(transaction, scope, state);
      } else {
        const versions = await readPersonalVersions(transaction, scope.personalSpaceId);
        const personalOperations = buildPersonalMutationOperations(previousState, state, versions);
        await insertMutationBatches(transaction, scope.personalSpaceId, personalOperations);
        const personalRows = encodePersonalRows(state, scope.personalSpaceId);
        for (const table of PERSONAL_TABLES) {
          const immutableExisting = table === 'personal_allergies'
            || table === 'personal_conversations'
            || table === 'personal_chat_messages'
            || table === 'personal_chat_proposals';
          await reconcileRows(transaction, table, { ...scope, spaceId: scope.personalSpaceId }, personalRows[table], {
            tombstoneMissing: true,
            immutableExisting
          });
        }
      }
      await writePrivateState(transaction, state, 'account', true);
    } else if (scope.kind === 'guest') {
      await writePrivateState(transaction, state, 'guest');
    } else {
      await writePrivateState(transaction, state, 'account', false);
    }
    if (scope.kind === 'account') await insertMutationBatches(transaction, scope.spaceId, operations);
  });
}

function proposalActionId(profileId: string, personalSpaceId: string, conversationId: string, proposalId: string): string {
  return `proposal-action-${shortHash(`${profileId}\0${personalSpaceId}\0${conversationId}\0${proposalId}`)}`;
}

export function withProposalStatus(
  state: PersistedState,
  conversationId: string,
  proposalId: string,
  status: 'pending' | 'applied'
): PersistedState {
  const updateMessage = (message: PersistedState['chatMessages'][number]) => ({
    ...message,
    proposals: message.proposals?.map((proposal) => proposal.id === proposalId ? { ...proposal, status } : proposal)
  });
  if (state.activeConversationId === conversationId) {
    return { ...state, chatMessages: state.chatMessages.map(updateMessage) };
  }
  return {
    ...state,
    chatHistory: state.chatHistory.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages: conversation.messages.map(updateMessage) }
      : conversation)
  };
}

/**
 * Persist an account Chef effect and its recovery link atomically. The caller
 * must wait for this transaction before publishing the resulting app state.
 */
export async function beginProposalAction(
  db: CommonPowerSyncDatabase,
  scope: Extract<ContentScope, { kind: 'account' }>,
  before: PersistedState,
  after: PersistedState,
  conversationId: string,
  proposal: ChefToolProposal
): Promise<{ state: PersistedState; started: boolean }> {
  if (!scope.personalSpaceId) throw new Error('The personal workspace is not known on this device. Reconnect the account before applying this suggestion.');
  const personalSpaceId = scope.personalSpaceId;
  const actionId = proposalActionId(scope.profileId, personalSpaceId, conversationId, proposal.id);
  const effectMutationId = `${actionId}-effect`;
  const statusMutationId = `${actionId}-status`;
  let started = false;
  await db.writeTransaction(async (transaction) => {
    const priorAction = await transaction.getOptional<{ id: string; space_id: string; conversation_id: string; message_id: string; proposal_id: string }>(
      'SELECT id, space_id, conversation_id, message_id, proposal_id FROM local_proposal_actions WHERE id = ?', [actionId]
    );
    if (priorAction) {
      if (priorAction.conversation_id !== conversationId || priorAction.proposal_id !== proposal.id) {
        throw new Error('A saved Chef action has conflicting identity details. Its local recovery record was kept.');
      }
      if (priorAction.space_id !== scope.spaceId) {
        throw new Error('This suggestion already has a saved action in another cooking workspace. Its original workspace and recovery link were kept.');
      }
      return;
    }

    const privateMigrationId = `personal-private-content-v1:${personalSpaceId}`;
    const privateMigrated = await transaction.getOptional<{ id: string }>(
      'SELECT id FROM local_migrations WHERE id = ?', [privateMigrationId]
    );
    if (!privateMigrated) await migrateAccountPrivateAggregate(transaction, scope, before);

    const stored = await loadWorkspaceState(transaction, scope, DEFAULT_STATE);
    const recipeRows = await transaction.getAll<{ entity_id: string; version: number }>(
      'SELECT entity_id, version FROM recipes WHERE space_id = ?', [scope.spaceId]
    );
    const recipeVersions = new Map(recipeRows.map((row) => [row.entity_id, Number(row.version) || 1]));
    const beforeShared = buildContentMutationOperations(stored, before, { recipes: recipeVersions });
    await insertMutationBatches(transaction, scope.spaceId, beforeShared, `${actionId}-prior-shared`);

    const personalVersions = await readPersonalVersions(transaction, personalSpaceId);
    const beforePersonal = buildPersonalMutationOperations(stored, before, personalVersions);
    await insertMutationBatches(transaction, personalSpaceId, beforePersonal, `${actionId}-prior-personal`);

    const effectVersions = new Map(recipeVersions);
    for (const recipe of before.recipes) if (!effectVersions.has(recipe.id)) effectVersions.set(recipe.id, 1);
    const effectOperations = buildContentMutationOperations(before, after, { recipes: effectVersions });
    if (!effectOperations.length) {
      throw new Error('This suggestion would not change the selected workspace, so it remains pending.');
    }
    if (effectOperations.length > 100) {
      throw new Error('This suggestion contains too many separate changes for one safe server transaction. It remains pending.');
    }
    const operations = withOperationIds(effectMutationId, effectOperations);
    const effectRequest: ContentMutationRequest = { mutationId: effectMutationId, operations };
    const effectOpId = operations[0]!.opId;
    const now = new Date().toISOString();
    await insertRow(transaction, 'local_content_outbox', {
      id: effectMutationId,
      space_id: scope.spaceId,
      mutation_id: effectMutationId,
      payload_json: JSON.stringify(effectRequest),
      state: 'pending',
      error_json: null,
      created_at: now
    });
    await insertRow(transaction, 'local_proposal_actions', {
      id: actionId,
      space_id: scope.spaceId,
      personal_space_id: personalSpaceId,
      conversation_id: conversationId,
      message_id: findMessageId(before, conversationId, proposal.id),
      proposal_id: proposal.id,
      effect_mutation_id: effectMutationId,
      effect_op_id: effectOpId,
      effect_payload_json: JSON.stringify(effectRequest),
      status_mutation_id: statusMutationId,
      status_op_id: `${statusMutationId}:0`,
      base_version: 1,
      stage: 'effect-pending',
      error_json: null,
      created_at: now,
      updated_at: now
    });

    const sharedRows = encodeContentRows(after, scope.spaceId);
    for (const name of RECORD_TABLE_ORDER) {
      await reconcileRows(transaction, tableName(scope, name), scope, sharedRows[name], { tombstoneMissing: true });
    }
    const personalRows = encodePersonalRows(before, personalSpaceId);
    for (const name of PERSONAL_TABLES) {
      await reconcileRows(transaction, name, { ...scope, spaceId: personalSpaceId }, personalRows[name], { tombstoneMissing: true });
    }
    await writePrivateState(transaction, before, 'account', true);
    started = true;
  });
  return { state: await loadWorkspaceState(db, scope, DEFAULT_STATE), started };
}

function findMessageId(state: PersistedState, conversationId: string, proposalId: string): string {
  const conversation = state.chatHistory.find((item) => item.id === conversationId)
    ?? (state.activeConversationId === conversationId
      ? { messages: state.chatMessages }
      : null);
  const message = conversation?.messages.find((item) => item.proposals?.some((proposal) => proposal.id === proposalId));
  if (!message) throw new Error('This Chef suggestion is no longer in the selected conversation.');
  return message.id;
}

export async function readActiveWorkspaceId(db: CommonPowerSyncDatabase): Promise<string | null> {
  const saved = await readLocalJson<unknown>(db, 'local_profile_preferences', 'active-workspace', null);
  return typeof saved === 'string' ? saved
    : saved && typeof saved === 'object' && typeof (saved as CachedWorkspaceSelection).spaceId === 'string'
      ? (saved as CachedWorkspaceSelection).spaceId
      : null;
}

export async function saveActiveWorkspaceId(db: CommonPowerSyncDatabase, spaceId: string): Promise<void> {
  await db.writeTransaction((transaction) => setLocalJson(transaction, 'local_profile_preferences', 'active-workspace', spaceId));
}

export async function readActiveWorkspaceSelection(db: CommonPowerSyncDatabase): Promise<CachedWorkspaceSelection | null> {
  const saved = await readLocalJson<unknown>(db, 'local_profile_preferences', 'active-workspace', null);
  if (saved && typeof saved === 'object') {
    const value = saved as Partial<CachedWorkspaceSelection>;
    if (typeof value.spaceId === 'string' && (value.workspaceKind === 'personal' || value.workspaceKind === 'household')) {
      return { spaceId: value.spaceId, workspaceKind: value.workspaceKind, personalSpaceId: typeof value.personalSpaceId === 'string' ? value.personalSpaceId : null };
    }
  }
  return typeof saved === 'string'
    ? { spaceId: saved, workspaceKind: 'household', personalSpaceId: null }
    : null;
}

export async function saveActiveWorkspaceSelection(db: CommonPowerSyncDatabase, selection: CachedWorkspaceSelection): Promise<void> {
  await db.writeTransaction((transaction) => setLocalJson(transaction, 'local_profile_preferences', 'active-workspace', selection));
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function shortHash(value: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed, seedIndex) => {
    let result = seed;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index) + seedIndex;
      result = Math.imul(result, 0x01000193);
    }
    return (result >>> 0).toString(16).padStart(8, '0');
  }).join('');
}

export async function guestAdoptionStatus(
  guestState: PersistedState,
  accountDb: CommonPowerSyncDatabase,
  defaults: PersistedState = DEFAULT_STATE,
  targetSpaceId = 'personal'
): Promise<GuestAdoptionStatus> {
  const available = hasGuestData(guestState, defaults);
  if (!available) return { available: false, migrationId: null, decision: null };
  const migrationId = `guest-adoption-v1-${shortHash(`${targetSpaceId}\0${stableSerialize(guestState)}`)}`;
  const receipt = await readLocalJson<MigrationReceipt | null>(accountDb, 'local_migrations', migrationId, null);
  const decision = receipt?.decision === 'merge' && !receipt.completedBatches.includes('remote-complete')
    ? 'in-progress'
    : receipt?.decision ?? null;
  return { available, migrationId, decision };
}

export function hasGuestData(state: PersistedState, defaults: PersistedState = DEFAULT_STATE): boolean {
  return state.pantry.length > 0 || state.recipes.length > 0
    || state.shopping.lists.length > 0 || state.shopping.items.length > 0
    || state.shopping.purchases.length > 0 || state.chatMessages.length > 0 || state.chatHistory.length > 0
    || stableSerialize({ mealContext: state.mealContext, settings: state.settings })
      !== stableSerialize({ mealContext: defaults.mealContext, settings: defaults.settings });
}

async function saveAdoptionArchive(db: CommonPowerSyncDatabase, state: PersistedState, migrationId: string, accountId: string): Promise<void> {
  const archiveId = `guest-archive-${shortHash(`${accountId}\0${migrationId}`)}`;
  const existing = await db.getOptional<{ id: string }>('SELECT id FROM local_archives WHERE id = ?', [archiveId]);
  if (existing) return;
  await db.writeTransaction((transaction) => insertRow(transaction, 'local_archives', {
    id: archiveId,
    scope_id: accountId,
    kind: 'guest-adoption-source',
    data_json: JSON.stringify(state),
    created_at: new Date().toISOString()
  }));
}

export async function keepGuestArchive(
  db: CommonPowerSyncDatabase,
  state: PersistedState,
  accountId: string,
  targetSpaceId: string
): Promise<GuestAdoptionStatus> {
  const status = await guestAdoptionStatus(state, db, DEFAULT_STATE, targetSpaceId);
  if (!status.migrationId) return status;
  const receipt: MigrationReceipt = {
    migrationId: status.migrationId,
    decision: 'keep',
    completedBatches: [],
    recordCount: 0,
    updatedAt: new Date().toISOString()
  };
  await saveAdoptionArchive(db, state, status.migrationId, accountId);
  await db.writeTransaction((transaction) => setLocalJson(transaction, 'local_migrations', status.migrationId!, receipt));
  return { ...status, decision: 'keep' };
}

export async function mergeGuestArchive(
  db: CommonPowerSyncDatabase,
  guestState: PersistedState,
  currentAccountState: PersistedState,
  scope: Extract<ContentScope, { kind: 'account' }>,
  defaults: PersistedState = DEFAULT_STATE
): Promise<PersistedState> {
  const status = await guestAdoptionStatus(guestState, db, defaults, scope.spaceId);
  if (!status.migrationId) return currentAccountState;
  const migrationId = status.migrationId;
  const receipt = await readLocalJson<MigrationReceipt | null>(db, 'local_migrations', migrationId, null);
  if (receipt?.decision === 'merge' && receipt.completedBatches.includes('local-complete')
    && receipt.completedBatches.includes('remote-complete')) {
    return loadWorkspaceState(db, scope, defaults);
  }

  await saveAdoptionArchive(db, guestState, migrationId, scope.profileId);
  const remapped = remapGuestStateForWorkspace(guestState, migrationId, scope.spaceId);
  const remappedPersonal = scope.personalSpaceId
    ? remapGuestPersonalStateForWorkspace(guestState, migrationId, scope.personalSpaceId)
    : guestState;
  const priorRecipeRows = await db.getAll<{ entity_id: string; version: number }>(
    'SELECT entity_id, version FROM recipes WHERE space_id = ?', [scope.spaceId]
  );
  const appendUnique = <T extends { id: string }>(first: T[], second: T[]) => {
    const ids = new Set(first.map((row) => row.id));
    return [...first, ...second.filter((row) => !ids.has(row.id))];
  };
  const mergedPrivate = mergeGuestPrivateState(currentAccountState, remappedPersonal);
  const adoptedState: PersistedState = {
    ...currentAccountState,
    ...mergedPrivate,
    pantry: appendUnique(currentAccountState.pantry, remapped.state.pantry),
    recipes: appendUnique(currentAccountState.recipes, remapped.state.recipes),
    shopping: {
      lists: appendUnique(currentAccountState.shopping.lists, remapped.state.shopping.lists),
      cycles: appendUnique(currentAccountState.shopping.cycles, remapped.state.shopping.cycles),
      items: appendUnique(currentAccountState.shopping.items, remapped.state.shopping.items),
      purchases: appendUnique(currentAccountState.shopping.purchases, remapped.state.shopping.purchases)
    }
  };
  const adoptionGroup = adoptionMutationBase(scope.spaceId, migrationId);
  const personalAdoptionGroup = scope.personalSpaceId
    ? adoptionMutationBase(scope.personalSpaceId, `personal:${migrationId}`)
    : null;
  let progress: MigrationReceipt = receipt ?? {
    migrationId,
    decision: 'in-progress',
    completedBatches: [],
    recordCount: Object.values(remapped.rows).reduce((total, rows) => total + rows.length, 0),
    updatedAt: new Date().toISOString()
  };
  progress = {
    ...progress,
    decision: 'in-progress',
    uploadGroup: adoptionGroup,
    uploadGroups: [
      { spaceId: scope.spaceId, group: adoptionGroup },
      ...(personalAdoptionGroup && scope.personalSpaceId ? [{ spaceId: scope.personalSpaceId, group: personalAdoptionGroup }] : [])
    ],
    updatedAt: new Date().toISOString()
  };
  await db.writeTransaction((transaction) => setLocalJson(transaction, 'local_migrations', migrationId, progress));

  if (!progress.completedBatches.includes('outbox-enqueued')) {
    const adoptedPantryIds = new Set(remapped.state.pantry.map((row) => row.id));
    const adoptedRecipeIds = new Set(remapped.state.recipes.map((row) => row.id));
    const adoptedListIds = new Set(remapped.state.shopping.lists.map((row) => row.id));
    const adoptedCycleIds = new Set(remapped.state.shopping.cycles.map((row) => row.id));
    const adoptedItemIds = new Set(remapped.state.shopping.items.map((row) => row.id));
    const adoptedPurchaseIds = new Set(remapped.state.shopping.purchases.map((row) => row.id));
    // A prior interrupted attempt may already have written local rows. Remove
    // this migration's deterministic identities from the command baseline so
    // the complete adoption payload can still be rebuilt with the same IDs.
    const adoptionBaseline: PersistedState = {
      ...currentAccountState,
      pantry: currentAccountState.pantry.filter((row) => !adoptedPantryIds.has(row.id)),
      recipes: currentAccountState.recipes.filter((row) => !adoptedRecipeIds.has(row.id)),
      shopping: {
        lists: currentAccountState.shopping.lists.filter((row) => !adoptedListIds.has(row.id)),
        cycles: currentAccountState.shopping.cycles.filter((row) => !adoptedCycleIds.has(row.id)),
        items: currentAccountState.shopping.items.filter((row) => !adoptedItemIds.has(row.id)),
        purchases: currentAccountState.shopping.purchases.filter((row) => !adoptedPurchaseIds.has(row.id))
      }
    };
    const adoptionOperations = buildGuestAdoptionMutationOperations(adoptionBaseline, adoptedState, {
      recipes: new Map(priorRecipeRows
        .filter((row) => !adoptedRecipeIds.has(row.entity_id))
        .map((row) => [row.entity_id, Number(row.version) || 1]))
    });
    const personalVersions = scope.personalSpaceId ? await readPersonalVersions(db, scope.personalSpaceId) : null;
    const personalOperations = personalVersions
      ? buildPersonalMutationOperations(currentAccountState, adoptedState, personalVersions)
      : [];
    await db.writeTransaction(async (transaction) => {
      await insertMutationBatches(transaction, scope.spaceId, adoptionOperations, adoptionGroup);
      if (personalAdoptionGroup && scope.personalSpaceId) {
        const privateMigrationId = `personal-private-content-v1:${scope.personalSpaceId}`;
        const privateMigrated = await transaction.getOptional<{ id: string }>(
          'SELECT id FROM local_migrations WHERE id = ?', [privateMigrationId]
        );
        if (!privateMigrated) await migrateAccountPrivateAggregate(transaction, scope, currentAccountState);
        await insertMutationBatches(transaction, scope.personalSpaceId, personalOperations, personalAdoptionGroup);
      }
      progress = {
        ...progress,
        completedBatches: [...new Set([...progress.completedBatches, 'outbox-enqueued'])],
        updatedAt: new Date().toISOString()
      };
      await setLocalJson(transaction, 'local_migrations', migrationId, progress);
    });
  }

  for (const name of RECORD_TABLE_ORDER) {
    const table = tableName(scope, name);
    const rows = remapped.rows[name];
    for (let start = 0; start < rows.length; start += MIGRATION_BATCH_SIZE) {
      const batch = rows.slice(start, start + MIGRATION_BATCH_SIZE);
      const batchId = `${name}:${start}`;
      if (progress.completedBatches.includes(batchId)) continue;
      const completedBatches = [...progress.completedBatches, batchId];
      const nextProgress: MigrationReceipt = { ...progress, completedBatches, updatedAt: new Date().toISOString() };
      await db.writeTransaction(async (transaction) => {
        await reconcileRows(transaction, table, scope, batch, { tombstoneMissing: false });
        await setLocalJson(transaction, 'local_migrations', migrationId, nextProgress);
      });
      progress = nextProgress;
    }
  }

  if (scope.personalSpaceId) {
    const personalRows = encodePersonalRows(adoptedState, scope.personalSpaceId);
    for (const name of PERSONAL_TABLES) {
      const rows = personalRows[name];
      for (let start = 0; start < rows.length; start += MIGRATION_BATCH_SIZE) {
        const batch = rows.slice(start, start + MIGRATION_BATCH_SIZE);
        const batchId = `personal:${name}:${start}`;
        if (progress.completedBatches.includes(batchId)) continue;
        const completedBatches = [...progress.completedBatches, batchId];
        const nextProgress: MigrationReceipt = { ...progress, completedBatches, updatedAt: new Date().toISOString() };
        await db.writeTransaction(async (transaction) => {
          await reconcileRows(transaction, name, { ...scope, spaceId: scope.personalSpaceId! }, batch, { tombstoneMissing: false });
          await setLocalJson(transaction, 'local_migrations', migrationId, nextProgress);
        });
        progress = nextProgress;
      }
    }
  }

  const mergedState: PersistedState = { ...currentAccountState, ...mergedPrivate };
  const locallyComplete: MigrationReceipt = {
    ...progress,
    decision: 'in-progress',
    completedBatches: [...new Set([...progress.completedBatches, 'local-complete'])],
    updatedAt: new Date().toISOString()
  };
  await db.writeTransaction(async (transaction) => {
    await writePrivateState(transaction, mergedState, 'account', Boolean(scope.personalSpaceId));
    await setLocalJson(transaction, 'local_migrations', migrationId, locallyComplete);
    await finishAdoptionIfUploaded(transaction, migrationId, scope.spaceId, locallyComplete);
  });
  return loadWorkspaceState(db, scope, defaults);
}

export async function recordGuestKeepChoice(db: CommonPowerSyncDatabase, state: PersistedState, accountId: string, targetSpaceId: string): Promise<GuestAdoptionStatus> {
  return keepGuestArchive(db, state, accountId, targetSpaceId);
}

export async function archiveWorkspaceState(
  db: CommonPowerSyncDatabase,
  scope: ContentScope,
  state: PersistedState,
  kind: 'signout' | 'membership-removed' | 'workspace-switch'
): Promise<string> {
  const proposalActions = scope.kind === 'account'
    ? await db.getAll<{ space_id: string; personal_space_id: string }>(
      'SELECT space_id, personal_space_id FROM local_proposal_actions WHERE space_id = ? OR personal_space_id = ?',
      [scope.spaceId, scope.personalSpaceId ?? scope.spaceId]
    )
    : [];
  const relatedSpaces = scope.kind === 'account'
    ? [...new Set([
      scope.spaceId,
      scope.personalSpaceId,
      ...proposalActions.flatMap((action) => [action.space_id, action.personal_space_id])
    ].filter((spaceId): spaceId is string => Boolean(spaceId)))]
    : [];
  const placeholders = relatedSpaces.map(() => '?').join(',');
  const [pending, blocked, issues, conflicts] = relatedSpaces.length
    ? await Promise.all([
      db.getAll(`SELECT space_id, mutation_id, payload_json, created_at FROM local_content_outbox WHERE space_id IN (${placeholders}) AND state = ? ORDER BY created_at`, [...relatedSpaces, 'pending']),
      db.getAll(`SELECT space_id, mutation_id, payload_json, error_json, created_at FROM local_content_outbox WHERE space_id IN (${placeholders}) AND state != ? ORDER BY created_at`, [...relatedSpaces, 'pending']),
      db.getAll(`SELECT space_id, issue_type, message, data_json, created_at FROM local_sync_issues WHERE space_id IN (${placeholders}) AND resolved_at IS NULL ORDER BY created_at`, relatedSpaces),
      db.getAll(`SELECT space_id, recipe_id, attempted_json, current_json, reason, created_at FROM local_recipe_conflicts WHERE space_id IN (${placeholders}) ORDER BY created_at`, relatedSpaces)
    ])
    : [[], [], [], []];
  const archive = { version: 2, state, pending, blocked, issues, conflicts, proposalActions };
  const archiveId = `workspace-${kind}-${shortHash(`${scope.spaceId}\0${stableSerialize(archive)}`)}`;
  const existing = await db.getOptional<{ id: string }>('SELECT id FROM local_archives WHERE id = ?', [archiveId]);
  if (!existing) {
    await db.writeTransaction((transaction) => insertRow(transaction, 'local_archives', {
      id: archiveId,
      scope_id: scope.spaceId,
      kind,
      data_json: JSON.stringify(archive),
      created_at: new Date().toISOString()
    }));
  }
  return archiveId;
}

export type ArchivedWorkspace = {
  id: string;
  scope_id: string;
  kind: string;
  data_json: string;
  created_at: string;
};

export async function listLocalArchives(db: CommonPowerSyncDatabase): Promise<ArchivedWorkspace[]> {
  return db.getAll('SELECT id, scope_id, kind, data_json, created_at FROM local_archives ORDER BY created_at DESC');
}

export async function recordLocalSyncIssue(
  db: CommonPowerSyncDatabase,
  issue: { spaceId: string; type: string; message: string; data: unknown }
): Promise<void> {
  const id = `issue-${shortHash(`${issue.spaceId}\0${issue.type}\0${stableSerialize(issue.data)}`)}`;
  const current = await db.getOptional<{ id: string }>('SELECT id FROM local_sync_issues WHERE id = ?', [id]);
  if (current) return;
  await db.writeTransaction((transaction) => insertRow(transaction, 'local_sync_issues', {
    id,
    space_id: issue.spaceId,
    issue_type: issue.type,
    message: issue.message,
    data_json: JSON.stringify(issue.data),
    created_at: new Date().toISOString(),
    resolved_at: null
  }));
}

export async function recordLocalRecipeConflict(
  db: CommonPowerSyncDatabase,
  conflict: { spaceId: string; recipeId: string; attempted: unknown; current: unknown; reason: string }
): Promise<void> {
  const id = `recipe-conflict-${shortHash(`${conflict.spaceId}\0${conflict.recipeId}\0${stableSerialize(conflict.attempted)}`)}`;
  const current = await db.getOptional<{ id: string }>('SELECT id FROM local_recipe_conflicts WHERE id = ?', [id]);
  if (current) return;
  await db.writeTransaction((transaction) => insertRow(transaction, 'local_recipe_conflicts', {
    id,
    space_id: conflict.spaceId,
    recipe_id: conflict.recipeId,
    attempted_json: JSON.stringify(conflict.attempted),
    current_json: JSON.stringify(conflict.current),
    reason: conflict.reason,
    created_at: new Date().toISOString()
  }));
}

export async function loadLocalRecipeConflicts(db: CommonPowerSyncDatabase, spaceId: string): Promise<Array<{
  id: string;
  recipe_id: string;
  attempted_json: string;
  current_json: string;
  reason: string;
  created_at: string;
}>> {
  return db.getAll('SELECT id, recipe_id, attempted_json, current_json, reason, created_at FROM local_recipe_conflicts WHERE space_id = ? ORDER BY created_at DESC', [spaceId]);
}

export type PersonalContentConflict = {
  id: string;
  entity_type: string;
  entity_identity: string;
  field_key: string | null;
  base_version: number | null;
  current_version: number | null;
  attempted_content: string;
  reason: string;
  created_at: string;
};

export async function loadPersonalContentConflicts(
  db: CommonPowerSyncDatabase,
  personalSpaceId: string | null
): Promise<PersonalContentConflict[]> {
  if (!personalSpaceId) return [];
  return db.getAll<PersonalContentConflict>(
    `SELECT id, entity_type, entity_identity, field_key, base_version, current_version,
       attempted_content, reason, created_at
     FROM personal_content_conflicts WHERE space_id = ? ORDER BY created_at DESC, id`,
    [personalSpaceId]
  );
}

export type PendingContentMutation = {
  id: string;
  space_id: string;
  mutation_id: string;
  payload_json: string;
  state: 'pending' | 'blocked' | 'conflict';
  error_json: string | null;
  created_at: string;
};

export async function listPendingContentMutations(
  db: CommonPowerSyncDatabase,
  spaceId?: string
): Promise<PendingContentMutation[]> {
  const where = spaceId ? 'WHERE state = ? AND space_id = ?' : 'WHERE state = ?';
  const values = spaceId ? ['pending', spaceId] : ['pending'];
  return db.getAll<PendingContentMutation>(
    `SELECT id, space_id, mutation_id, payload_json, state, error_json, created_at FROM local_content_outbox ${where} ORDER BY created_at, id`,
    values
  );
}

export async function updateContentMutationState(
  db: CommonPowerSyncDatabase,
  id: string,
  state: 'blocked' | 'conflict',
  error: unknown
): Promise<void> {
  await db.writeTransaction(async (transaction) => {
    await transaction.execute(
      'UPDATE local_content_outbox SET state = ?, error_json = ? WHERE id = ?',
      [state, JSON.stringify(error), id]
    );
    const row = await transaction.getOptional<{ mutation_id: string; space_id: string }>(
      'SELECT mutation_id, space_id FROM local_content_outbox WHERE id = ?', [id]
    );
    if (row) {
      await transaction.execute(
        `UPDATE local_proposal_actions SET stage = CASE WHEN personal_space_id = ? AND status_mutation_id = ?
             THEN 'status-blocked' ELSE 'effect-blocked' END,
           error_json = ?, updated_at = ?
         WHERE (space_id = ? AND effect_mutation_id = ?) OR (personal_space_id = ? AND status_mutation_id = ?)`,
        [row.space_id, row.mutation_id, JSON.stringify(error), new Date().toISOString(), row.space_id, row.mutation_id, row.space_id, row.mutation_id]
      );
    }
  });
}

export async function acknowledgeContentMutation(db: CommonPowerSyncDatabase, id: string): Promise<void> {
  await db.writeTransaction(async (transaction) => {
    const row = await transaction.getOptional<{ space_id: string; mutation_id: string }>(
      'SELECT space_id, mutation_id FROM local_content_outbox WHERE id = ?', [id]
    );
    if (!row) return;
    await transaction.execute('DELETE FROM local_content_outbox WHERE id = ?', [id]);

    const effectAction = await transaction.getOptional<{
      id: string; personal_space_id: string; conversation_id: string; message_id: string; proposal_id: string;
      effect_op_id: string; status_mutation_id: string; status_op_id: string; base_version: number; stage: string;
    }>(
      `SELECT id, personal_space_id, conversation_id, message_id, proposal_id,
         effect_op_id, status_mutation_id, status_op_id, base_version, stage
       FROM local_proposal_actions WHERE space_id = ? AND effect_mutation_id = ?`,
      [row.space_id, row.mutation_id]
    );
    if (effectAction && effectAction.stage !== 'status-pending' && effectAction.stage !== 'status-blocked') {
      const statusOperation: ContentMutationOperation = {
        opId: effectAction.status_op_id,
        type: 'personal.chat.proposal.setStatus',
        conversationId: effectAction.conversation_id,
        messageId: effectAction.message_id,
        proposalId: effectAction.proposal_id,
        status: 'applied',
        baseVersion: Number(effectAction.base_version) || 1,
        effectSpaceId: row.space_id,
        effectMutationId: row.mutation_id,
        effectOpId: effectAction.effect_op_id
      };
      await insertMutationBatches(transaction, effectAction.personal_space_id, [statusOperation], effectAction.status_mutation_id);
      await transaction.execute(
        `UPDATE local_proposal_actions SET stage = 'status-pending', error_json = NULL, updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), effectAction.id]
      );
    }

    const statusAction = await transaction.getOptional<{
      id: string; personal_space_id: string; conversation_id: string; message_id: string; proposal_id: string;
    }>(
      `SELECT id, personal_space_id, conversation_id, message_id, proposal_id
       FROM local_proposal_actions WHERE personal_space_id = ? AND status_mutation_id = ?`,
      [row.space_id, row.mutation_id]
    );
    if (statusAction) {
      await transaction.execute(
        `UPDATE personal_chat_proposals SET status = 'applied', version = 2, updated_at = ?
         WHERE space_id = ? AND conversation_id = ? AND message_id = ? AND entity_id = ?`,
        [new Date().toISOString(), statusAction.personal_space_id, statusAction.conversation_id, statusAction.message_id, statusAction.proposal_id]
      );
      await transaction.execute('DELETE FROM local_proposal_actions WHERE id = ?', [statusAction.id]);
    }

    const receipts = await transaction.getAll<{ id: string; value: string }>(
      'SELECT id, value FROM local_migrations'
    );
    for (const stored of receipts) {
      const receipt = decodeMigrationReceipt(stored.value);
      if (!receipt) continue;
      const groups = receipt.uploadGroups?.length
        ? receipt.uploadGroups
        : receipt.uploadGroup
          ? [{ spaceId: row.space_id, group: receipt.uploadGroup }]
          : [{ spaceId: row.space_id, group: adoptionMutationBase(row.space_id, stored.id) }];
      if (!groups.some((group) => group.spaceId === row.space_id && isMutationInGroup(row.mutation_id, group.group))) continue;
      await finishAdoptionIfUploaded(transaction, stored.id, row.space_id, receipt);
    }
  });
}

export async function enqueueContentMutation(
  db: CommonPowerSyncDatabase,
  spaceId: string,
  mutation: ContentMutationRequest
): Promise<void> {
  const exists = await db.getOptional<{ id: string }>('SELECT id FROM local_content_outbox WHERE id = ?', [mutation.mutationId]);
  if (exists) return;
  await db.writeTransaction((transaction) => insertRow(transaction, 'local_content_outbox', {
    id: mutation.mutationId,
    space_id: spaceId,
    mutation_id: mutation.mutationId,
    payload_json: JSON.stringify(mutation),
    state: 'pending',
    error_json: null,
    created_at: new Date().toISOString()
  }));
}
