import assert from 'node:assert/strict';
import test from 'node:test';
import { chatConversationFromMessages, chatConversationTitle, sortChatHistory } from './conversations.ts';

const message = (id, role, content, createdAt) => ({ id, role, content, createdAt });

test('conversation title prefers the first user message and collapses whitespace', () => {
  const messages = [
    message('a1', 'assistant', 'How can I help?', '2026-09-23T10:00:00.000Z'),
    message('u1', 'user', '  Make   something with tomatoes and basil  ', '2026-09-23T10:01:00.000Z')
  ];
  assert.equal(chatConversationTitle(messages), 'Make something with tomatoes and basil');
});

test('conversation title truncates long prompts without becoming verbose', () => {
  const title = chatConversationTitle([
    message('u1', 'user', 'I want a creative weeknight dinner using the vegetables in my fridge and something crunchy on top', '2026-09-23T10:00:00.000Z')
  ]);
  assert.equal(title.length <= 52, true);
  assert.equal(title.endsWith('…'), true);
});

test('conversation archive preserves messages and timestamps', () => {
  const messages = [
    message('u1', 'user', 'Soup ideas', '2026-09-23T10:00:00.000Z'),
    message('a1', 'assistant', 'Try a roasted tomato soup.', '2026-09-23T10:02:00.000Z')
  ];
  assert.deepEqual(chatConversationFromMessages('chat-1', messages), {
    id: 'chat-1',
    title: 'Soup ideas',
    messages,
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:02:00.000Z'
  });
});

test('history sorts most recently updated first', () => {
  const older = chatConversationFromMessages('older', [
    message('u1', 'user', 'Older', '2026-09-23T09:00:00.000Z')
  ]);
  const newer = chatConversationFromMessages('newer', [
    message('u2', 'user', 'Newer', '2026-09-23T11:00:00.000Z')
  ]);
  assert.deepEqual(sortChatHistory([older, newer]).map((item) => item.id), ['newer', 'older']);
});
