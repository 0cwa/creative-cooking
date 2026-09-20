import assert from 'node:assert/strict';
import test from 'node:test';
import { deobfuscateOpenRouterKey, obfuscateOpenRouterKey } from './sharePayload.ts';

test('64-character hexadecimal OpenRouter keys round-trip through compact payloads', () => {
  const key = 'sk-or-v1-' + '0123456789abcdef'.repeat(4);
  const payload = obfuscateOpenRouterKey(key);

  assert.ok(payload.startsWith('x'));
  assert.ok(payload.length < key.length);
  assert.equal(deobfuscateOpenRouterKey(payload), key);
});

test('non-hex standard keys round-trip through reversible payloads', () => {
  const key = 'sk-or-v1-example_key_body';
  const payload = obfuscateOpenRouterKey(key);
  assert.ok(payload.startsWith('r'));
  assert.equal(deobfuscateOpenRouterKey(payload), key);
});

test('share payload rejects empty and malformed compact values', () => {
  assert.throws(() => obfuscateOpenRouterKey('not-openrouter'), /standard OpenRouter keys/);
  assert.throws(() => obfuscateOpenRouterKey('sk-or-v1-'), /empty/);
  assert.throws(() => deobfuscateOpenRouterKey(''), /empty/);
  assert.throws(() => deobfuscateOpenRouterKey('xabc'), /invalid/);
});
