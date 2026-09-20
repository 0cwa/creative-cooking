import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_DEFAULT_SYSTEM_PROMPT,
  migrateLegacySystemPrompt
} from './defaults.ts';

test('legacy untouched Chef prompt migrates to user-facing master instructions', () => {
  assert.equal(migrateLegacySystemPrompt(LEGACY_DEFAULT_SYSTEM_PROMPT), DEFAULT_SYSTEM_PROMPT);
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /ask_user|recipe_save|provided tools|listed allergen/i);
});

test('customized master instructions are preserved', () => {
  assert.equal(migrateLegacySystemPrompt('Make everything extra spicy.'), 'Make everything extra spicy.');
});
