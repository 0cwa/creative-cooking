import assert from 'node:assert/strict';
import test from 'node:test';
import { freshStateFromDefaults, parseBackupEnvelope, serializeBackupEnvelope } from './backupFormat.ts';

const defaults = {
  pantry: [],
  recipes: [],
  chatMessages: [],
  mealContext: { willingToShop: false, portions: 2, cooks: ['medium'] },
  settings: {
    systemPrompt: 'default prompt',
    allergies: [],
    sendLocalTime: true,
    city: '',
    providerId: 'openrouter',
    model: 'openrouter/free'
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
  assert.deepEqual(defaults.mealContext.cooks, ['medium']);
  assert.deepEqual(defaults.settings.allergies, []);
});
