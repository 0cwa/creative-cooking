import type { ChatConversation, ChatMessage, CookEnergy, PersistedState } from '../domain/types';
import { chatConversationFromMessages, sortChatHistory } from '../domain/conversations.ts';
import { DEFAULT_STATE } from '../domain/defaults.ts';
import { contentStorageId, type ContentRecord } from './recordCodec.ts';

export const PERSONAL_TABLES = [
  'personal_profile_fields',
  'personal_allergies',
  'personal_conversations',
  'personal_chat_messages',
  'personal_chat_proposals',
  'personal_content_conflicts'
] as const;

export type PersonalRows = Record<(typeof PERSONAL_TABLES)[number], ContentRecord[]>;
export type PersonalWorkspaceState = Pick<PersistedState,
  'chatMessages' | 'chatHistory' | 'mealContext' | 'settings'>;

const PERSONAL_PREFERENCE_FIELDS = [
  'systemPrompt',
  'city',
  'mealContext.willingToShop',
  'mealContext.portions',
  'mealContext.cooksCount',
  ...Array.from({ length: 8 }, (_, index) => `mealContext.cooks.${index}`)
] as const;

export type PersonalPreferenceField = (typeof PERSONAL_PREFERENCE_FIELDS)[number];

export function personalConversationsFromState(state: PersistedState): ChatConversation[] {
  const active = state.activeConversationId
    ? chatConversationFromMessages(state.activeConversationId, state.chatMessages)
    : null;
  const byId = new Map(state.chatHistory.map((conversation) => [conversation.id, conversation]));
  if (active) byId.set(active.id, active);
  return sortChatHistory([...byId.values()]);
}

function storageRecord(
  spaceId: string,
  table: string,
  entityId: string,
  parentId: string | null,
  values: Record<string, unknown>
): ContentRecord {
  return {
    id: contentStorageId(table, spaceId, parentId, entityId),
    entity_id: entityId,
    space_id: spaceId,
    ...values
  } as ContentRecord;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function normalizeAllergyName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function fieldValue(state: PersistedState, field: PersonalPreferenceField): unknown {
  switch (field) {
    case 'systemPrompt': return state.settings.systemPrompt;
    case 'city': return state.settings.city;
    case 'mealContext.willingToShop': return state.mealContext.willingToShop;
    case 'mealContext.portions': return state.mealContext.portions;
    case 'mealContext.cooksCount': return state.mealContext.cooks.length;
    default: {
      const index = Number(field.slice('mealContext.cooks.'.length));
      return state.mealContext.cooks[index] ?? null;
    }
  }
}

export function encodePersonalRows(state: PersistedState, spaceId: string): PersonalRows {
  const conversations = personalConversationsFromState(state);
  const profileFields = PERSONAL_PREFERENCE_FIELDS.flatMap((field) => {
    const value = fieldValue(state, field);
    return [storageRecord(spaceId, 'personal_profile_fields', field, null, {
      field_key: field,
      value: json(value)
    })];
  });
  const allergies = [...new Map(state.settings.allergies
    .map((name) => ({ name: name.trim().replace(/\s+/g, ' '), normalized: normalizeAllergyName(name) }))
    .filter((item) => item.normalized)
    .map((item) => [item.normalized, item])).values()]
    .map((item) => storageRecord(spaceId, 'personal_allergies', item.normalized, null, {
      name: item.name,
      normalized_name: item.normalized,
      created_at: null,
      updated_at: null,
      deleted_at: null,
      version: null,
      updated_by: null
    }));
  const conversationRows: ContentRecord[] = [];
  const messageRows: ContentRecord[] = [];
  const proposalRows: ContentRecord[] = [];
  for (const conversation of conversations) {
    conversationRows.push(storageRecord(spaceId, 'personal_conversations', conversation.id, null, {
      title: conversation.title,
      created_at: conversation.createdAt,
      updated_at: conversation.updatedAt,
      deleted_at: null,
      version: null,
      updated_by: null
    }));
    for (const message of conversation.messages) {
      messageRows.push(storageRecord(spaceId, 'personal_chat_messages', message.id, conversation.id, {
        conversation_id: conversation.id,
        role: message.role,
        content: message.content,
        created_at: message.createdAt,
        version: null,
        updated_by: null
      }));
      for (const proposal of message.proposals ?? []) {
        proposalRows.push(storageRecord(
          spaceId,
          'personal_chat_proposals',
          proposal.id,
          JSON.stringify([conversation.id, message.id]),
          {
            conversation_id: conversation.id,
            message_id: message.id,
            tool_name: proposal.toolName,
            arguments: proposal.arguments,
            status: proposal.status,
            created_at: message.createdAt,
            updated_at: message.createdAt,
            version: null,
            updated_by: null
          }
        ));
      }
    }
  }
  return {
    personal_profile_fields: profileFields,
    personal_allergies: allergies,
    personal_conversations: conversationRows,
    personal_chat_messages: messageRows,
    personal_chat_proposals: proposalRows,
    personal_content_conflicts: []
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function getField(rows: ContentRecord[], key: string): { found: boolean; value?: unknown } {
  const row = rows.find((item) => String(item.field_key ?? item.entity_id) === key && !item.deleted_at);
  return row ? { found: true, value: parseJson(row.value) } : { found: false };
}

export function decodePersonalRows(
  rows: Partial<PersonalRows>,
  defaults: PersistedState,
  activeConversationId: string | null
): PersonalWorkspaceState {
  const fields = rows.personal_profile_fields ?? [];
  const city = getField(fields, 'city');
  const systemPrompt = getField(fields, 'systemPrompt');
  const willing = getField(fields, 'mealContext.willingToShop');
  const portions = getField(fields, 'mealContext.portions');
  const count = getField(fields, 'mealContext.cooksCount');
  const cookCount = count.found && Number.isInteger(Number(count.value))
    ? Math.max(0, Math.min(8, Number(count.value)))
    : defaults.mealContext.cooks.length;
  const cooks = Array.from({ length: cookCount }, (_, index) => {
    const saved = getField(fields, `mealContext.cooks.${index}`);
    const value = saved.value;
    return value === 'low' || value === 'medium' || value === 'high'
      ? value as CookEnergy
      : defaults.mealContext.cooks[index] ?? 'medium';
  });
  const allergies = (rows.personal_allergies ?? [])
    .filter((row) => !row.deleted_at)
    .sort((left, right) => String(left.normalized_name ?? left.entity_id).localeCompare(String(right.normalized_name ?? right.entity_id)))
    .map((row) => String(row.name ?? row.normalized_name ?? row.entity_id));
  const messagesByConversation = new Map<string, ContentRecord[]>();
  for (const row of rows.personal_chat_messages ?? []) {
    const id = String(row.conversation_id ?? '');
    const list = messagesByConversation.get(id) ?? [];
    list.push(row);
    messagesByConversation.set(id, list);
  }
  const proposalsByMessage = new Map<string, ContentRecord[]>();
  for (const row of rows.personal_chat_proposals ?? []) {
    const key = JSON.stringify([String(row.conversation_id ?? ''), String(row.message_id ?? '')]);
    const list = proposalsByMessage.get(key) ?? [];
    list.push(row);
    proposalsByMessage.set(key, list);
  }
  const conversations: ChatConversation[] = (rows.personal_conversations ?? [])
    .filter((row) => !row.deleted_at)
    .map((row) => {
      const id = String(row.entity_id ?? row.id);
      const messages: ChatMessage[] = (messagesByConversation.get(id) ?? [])
        .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))
          || String(left.entity_id ?? left.id).localeCompare(String(right.entity_id ?? right.id)))
        .map((message) => {
          const messageId = String(message.entity_id ?? message.id);
          const proposals = (proposalsByMessage.get(JSON.stringify([id, messageId])) ?? [])
            .sort((left, right) => String(left.entity_id ?? left.id).localeCompare(String(right.entity_id ?? right.id)))
            .map((proposal) => ({
              id: String(proposal.entity_id ?? proposal.id),
              toolName: String(proposal.tool_name ?? ''),
              arguments: String(proposal.arguments ?? ''),
              status: proposal.status === 'applied' ? 'applied' as const : 'pending' as const
            }));
          return {
            id: messageId,
            role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
            content: String(message.content ?? ''),
            createdAt: String(message.created_at ?? ''),
            ...(proposals.length ? { proposals } : {})
          };
        });
      return {
        id,
        title: String(row.title ?? 'Untitled chat'),
        messages,
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? row.created_at ?? '')
      };
    })
    .filter((conversation) => conversation.messages.length > 0);
  const activeConversation = activeConversationId
    ? conversations.find((conversation) => conversation.id === activeConversationId) ?? null
    : null;
  return {
    chatMessages: activeConversation?.messages ?? [],
    chatHistory: sortChatHistory(conversations.filter((conversation) => conversation.id !== activeConversation?.id)),
    mealContext: {
      willingToShop: typeof willing.value === 'boolean' ? willing.value : defaults.mealContext.willingToShop,
      portions: Number(portions.value) > 0 ? Number(portions.value) : defaults.mealContext.portions,
      cooks
    },
    settings: {
      ...defaults.settings,
      systemPrompt: typeof systemPrompt.value === 'string' ? systemPrompt.value : defaults.settings.systemPrompt,
      city: typeof city.value === 'string' ? city.value : defaults.settings.city,
      allergies
    }
  };
}

export function hasPersonalRows(rows: Partial<PersonalRows>): boolean {
  return PERSONAL_TABLES.some((table) => (rows[table]?.length ?? 0) > 0);
}

export const PERSONAL_FIELDS = PERSONAL_PREFERENCE_FIELDS;
