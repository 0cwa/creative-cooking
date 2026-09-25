import assert from 'node:assert/strict';
import test from 'node:test';
import { freshStateFromDefaults, parseBackupEnvelope, serializeBackupEnvelope } from './backupFormat.ts';

const defaults = {
  pantry: [],
  recipes: [],
  chatMessages: [],
  chatHistory: [],
  activeConversationId: null,
  mealContext: { willingToShop: false, portions: 2, cooks: ['medium'] },
  settings: {
    theme: 'system',
    systemPrompt: 'default prompt',
    allergies: [],
    sendLocalTime: true,
    city: '',
    providerId: 'openrouter',
    model: 'openrouter/free',
    dictationEngine: 'browser'
  }
};

test('backup round-trip preserves state and envelope metadata', () => {
  const state = {
    ...defaults,
    pantry: [{ id: 'p1', name: 'carrots', preference: 5, createdAt: 'a', updatedAt: 'b' }],
    settings: { ...defaults.settings, allergies: ['peanuts'], city: 'Stockholm' }
  };

  const serialized = serializeBackupEnvelope(state, '2026-09-20T12:00:00.000Z');
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.exportedAt, '2026-09-20T12:00:00.000Z');
  assert.deepEqual(parseBackupEnvelope(serialized, defaults), state);
});

test('backup parsing migrates missing nested settings and context fields from defaults', () => {
  const raw = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-20T12:00:00.000Z',
    state: {
      pantry: [],
      recipes: [],
      chatMessages: [],
      mealContext: { portions: 6 },
      settings: { city: 'Malmö' }
    }
  });

  const restored = parseBackupEnvelope(raw, defaults);
  assert.equal(restored.mealContext.portions, 6);
  assert.equal(restored.mealContext.willingToShop, false);
  assert.deepEqual(restored.mealContext.cooks, ['medium']);
  assert.equal(restored.settings.city, 'Malmö');
  assert.equal(restored.settings.model, 'openrouter/free');
  assert.deepEqual(restored.settings.allergies, []);
  assert.deepEqual(restored.chatHistory, []);
  assert.equal(restored.activeConversationId, null);
});

test('backup round-trip preserves archived Chef conversations', () => {
  const state = {
    ...defaults,
    chatHistory: [{
      id: 'chat-older',
      title: 'Older dinner idea',
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'Older dinner idea',
        createdAt: '2026-09-22T18:00:00.000Z'
      }],
      createdAt: '2026-09-22T18:00:00.000Z',
      updatedAt: '2026-09-22T18:00:00.000Z'
    }],
    activeConversationId: 'chat-current',
    chatMessages: [{
      id: 'u2',
      role: 'user',
      content: 'Current dinner idea',
      createdAt: '2026-09-23T18:00:00.000Z'
    }]
  };
  const serialized = serializeBackupEnvelope(state, '2026-09-23T18:30:00.000Z');
  assert.deepEqual(parseBackupEnvelope(serialized, defaults), state);
});

test('backup parsing sanitizes unknown provider IDs while preserving known direct providers', () => {
  const unknown = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-21T12:00:00.000Z',
    state: { settings: { providerId: 'future-provider', model: 'future-model' } }
  });
  const unknownRestored = parseBackupEnvelope(unknown, defaults);
  assert.equal(unknownRestored.settings.providerId, 'openrouter');
  assert.equal(unknownRestored.settings.model, 'openrouter/free');

  const known = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-21T12:00:00.000Z',
    state: { settings: { providerId: 'gemini', model: 'gemini-3.8-flash' } }
  });
  const restored = parseBackupEnvelope(known, defaults);
  assert.equal(restored.settings.providerId, 'gemini');
  assert.equal(restored.settings.model, 'gemini-3.8-flash');
});

test('backup parsing sanitizes dictation engine and defaults legacy backups to browser speech', () => {
  const invalid = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-23T12:00:00.000Z',
    state: { settings: { dictationEngine: 'future-engine' } }
  });
  assert.equal(parseBackupEnvelope(invalid, defaults).settings.dictationEngine, 'browser');

  const whisper = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-23T12:00:00.000Z',
    state: { settings: { dictationEngine: 'whisper' } }
  });
  assert.equal(parseBackupEnvelope(whisper, defaults).settings.dictationEngine, 'whisper');
});

test('backup parsing sanitizes theme preference and defaults legacy backups to system', () => {
  const invalid = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-25T00:00:00.000Z',
    state: { settings: { theme: 'future-theme' } }
  });
  assert.equal(parseBackupEnvelope(invalid, defaults).settings.theme, 'system');

  const legacy = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-25T00:00:00.000Z',
    state: { settings: {} }
  });
  assert.equal(parseBackupEnvelope(legacy, defaults).settings.theme, 'system');

  const dark = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-25T00:00:00.000Z',
    state: { settings: { theme: 'dark' } }
  });
  assert.equal(parseBackupEnvelope(dark, defaults).settings.theme, 'dark');
});

test('legacy backups without providerId preserve their OpenRouter model', () => {
  const raw = JSON.stringify({
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: '2026-09-21T12:00:00.000Z',
    state: { settings: { model: 'openai/gpt-oss-120b:free' } }
  });

  const restored = parseBackupEnvelope(raw, defaults);
  assert.equal(restored.settings.providerId, 'openrouter');
  assert.equal(restored.settings.model, 'openai/gpt-oss-120b:free');
});

test('unsupported backup formats fail closed', () => {
  assert.throws(
    () => parseBackupEnvelope(JSON.stringify({ format: 'creative-cooking-backup', version: 99, state: {} }), defaults),
    /not a supported Creative Cooking backup/
  );
});

test('fresh default state does not share mutable nested arrays with defaults', () => {
  const fresh = freshStateFromDefaults(defaults);
  fresh.mealContext.cooks.push('high');
  fresh.settings.allergies.push('sesame');
  fresh.chatHistory.push({
    id: 'chat-1',
    title: 'Test',
    messages: [],
    createdAt: 'a',
    updatedAt: 'b'
  });
  assert.deepEqual(defaults.mealContext.cooks, ['medium']);
  assert.deepEqual(defaults.settings.allergies, []);
  assert.deepEqual(defaults.chatHistory, []);
});
