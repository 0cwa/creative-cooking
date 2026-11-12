import type { ContentMutationOperation } from '../account/contracts';
import type { ChatConversation, ChatMessage, PersistedState } from '../domain/types';
import { PERSONAL_FIELDS, normalizeAllergyName, personalConversationsFromState, type PersonalPreferenceField } from './personalRecordCodec.ts';

export type PersonalVersions = {
  preferences: Map<string, number | null>;
  allergies: Map<string, number | null>;
  conversations: Map<string, number>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function preferenceValue(state: PersistedState, field: PersonalPreferenceField): unknown {
  switch (field) {
    case 'systemPrompt': return state.settings.systemPrompt;
    case 'city': return state.settings.city;
    case 'mealContext.willingToShop': return state.mealContext.willingToShop;
    case 'mealContext.portions': return state.mealContext.portions;
    case 'mealContext.cooksCount': return state.mealContext.cooks.length;
    default: return state.mealContext.cooks[Number(field.slice('mealContext.cooks.'.length))] ?? null;
  }
}

function mapById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function proposalsById(message: ChatMessage) {
  return new Map((message.proposals ?? []).map((proposal) => [proposal.id, proposal]));
}

function messageById(conversation: ChatConversation) {
  return new Map(conversation.messages.map((message) => [message.id, message]));
}

function sameMessageContent(left: ChatMessage, right: ChatMessage): boolean {
  return left.id === right.id && left.role === right.role
    && left.content === right.content && left.createdAt === right.createdAt;
}

/** Build only personal-workspace commands; shared cooking commands stay in mutations.ts. */
export function buildPersonalMutationOperations(
  before: PersistedState,
  after: PersistedState,
  versions: PersonalVersions
): ContentMutationOperation[] {
  const operations: ContentMutationOperation[] = [];
  for (const field of PERSONAL_FIELDS) {
    const previous = preferenceValue(before, field);
    const next = preferenceValue(after, field);
    if (stable(previous) === stable(next)) continue;
    operations.push({
      opId: '',
      type: 'personal.preference.set',
      field,
      value: next,
      baseVersion: versions.preferences.get(field) ?? null
    });
  }

  const previousAllergies = new Map(before.settings.allergies
    .map((name) => [normalizeAllergyName(name), name] as const)
    .filter(([normalized]) => normalized));
  const nextAllergies = new Map(after.settings.allergies
    .map((name) => [normalizeAllergyName(name), name] as const)
    .filter(([normalized]) => normalized));
  for (const normalized of nextAllergies.keys()) {
    if (previousAllergies.has(normalized)) continue;
    operations.push({
      opId: '', type: 'personal.allergy.set', name: normalized, enabled: true,
      baseVersion: versions.allergies.get(normalized) ?? null
    });
  }
  for (const normalized of previousAllergies.keys()) {
    if (nextAllergies.has(normalized)) continue;
    operations.push({
      opId: '', type: 'personal.allergy.set', name: normalized, enabled: false,
      baseVersion: versions.allergies.get(normalized) ?? null
    });
  }

  const previousConversations = mapById(personalConversationsFromState(before));
  const nextConversations = mapById(personalConversationsFromState(after));
  for (const [id, conversation] of nextConversations) {
    const previous = previousConversations.get(id);
    if (!previous) {
      operations.push({
        opId: '', type: 'personal.chat.conversation.create',
        conversation: { id, title: conversation.title, createdAt: conversation.createdAt }
      });
    }
    const previousMessages = previous ? messageById(previous) : new Map<string, ChatMessage>();
    for (const message of conversation.messages) {
      const priorMessage = previousMessages.get(message.id);
      if (!priorMessage || !sameMessageContent(priorMessage, message)) {
        operations.push({
          opId: '', type: 'personal.chat.message.append', conversationId: id,
          message: { id: message.id, role: message.role, content: message.content, createdAt: message.createdAt }
        });
      }
      const previousProposals = priorMessage ? proposalsById(priorMessage) : new Map();
      for (const proposal of message.proposals ?? []) {
        const priorProposal = previousProposals.get(proposal.id);
        // Proposal status is advanced only by the receipt-linked two-stage action.
        if (priorProposal?.status === proposal.status
          && priorProposal.toolName === proposal.toolName
          && priorProposal.arguments === proposal.arguments) continue;
        if (priorProposal && priorProposal.status !== proposal.status) continue;
        operations.push({
          opId: '', type: 'personal.chat.proposal.create', conversationId: id, messageId: message.id,
          proposal: { id: proposal.id, toolName: proposal.toolName, arguments: proposal.arguments, status: proposal.status }
        });
      }
    }
  }

  for (const id of previousConversations.keys()) {
    if (nextConversations.has(id)) continue;
    operations.push({
      opId: '', type: 'personal.chat.conversation.delete', id,
      baseVersion: versions.conversations.get(id) ?? 1
    });
  }
  return operations;
}
