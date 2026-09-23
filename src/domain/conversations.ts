import type { ChatConversation, ChatMessage } from './types';

const MAX_TITLE_LENGTH = 52;

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function chatConversationTitle(messages: ChatMessage[]): string {
  const source = messages.find((message) => message.role === 'user' && cleanText(message.content))
    ?? messages.find((message) => cleanText(message.content));
  const text = source ? cleanText(source.content) : '';
  if (!text) return 'Untitled chat';
  if (text.length <= MAX_TITLE_LENGTH) return text;
  return `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

export function chatConversationFromMessages(
  id: string,
  messages: ChatMessage[]
): ChatConversation | null {
  if (!messages.length) return null;
  const createdAt = messages[0]?.createdAt || new Date().toISOString();
  const updatedAt = messages[messages.length - 1]?.createdAt || createdAt;
  return {
    id,
    title: chatConversationTitle(messages),
    messages,
    createdAt,
    updatedAt
  };
}

export function sortChatHistory(conversations: ChatConversation[]): ChatConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
