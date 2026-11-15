import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpaqueToken, hashOpaqueToken, normalizeEmail } from '../src/security.js';

test('email normalization is stable across surrounding whitespace and case', () => {
  assert.equal(normalizeEmail('  Owner@Example.COM  '), 'owner@example.com');
});

test('session and invitation credentials are high-entropy opaque values', () => {
  const first = createOpaqueToken();
  const second = createOpaqueToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.notEqual(hashOpaqueToken(first, 'a'.repeat(32)), first);
  assert.notEqual(hashOpaqueToken(first, 'a'.repeat(32)), hashOpaqueToken(first, 'b'.repeat(32)));
  assert.equal(hashOpaqueToken(first, 'a'.repeat(32)), hashOpaqueToken(first, 'a'.repeat(32)));
});
