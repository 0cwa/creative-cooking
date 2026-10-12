import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeFrame, decodeFrame, createMemoryEndpoint } from './contract.mjs';
import { encodeInvitation, decodeInvitation } from './invitation.mjs';

test('opaque frames preserve exact deterministic and random binary payloads', () => {
  for (const bytes of [
    new Uint8Array(), Uint8Array.from([0, 255, 0, 128, 42]),
    new Uint8Array(randomBytes(32768)), new Uint8Array(randomBytes(1024 * 1024))
  ]) {
    const frame = { documentId: 'opaque/document#1', bytes };
    assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
  }
});

test('reject invalid, oversized and corrupted frames', () => {
  assert.throws(() => encodeFrame({ documentId: '', bytes: new Uint8Array() }));
  assert.throws(() => encodeFrame({ documentId: 'x', bytes: new Uint8Array(1024 * 1024 + 1) }));
  const raw = encodeFrame({ documentId: 'ok', bytes: Uint8Array.from([1]) });
  assert.throws(() => decodeFrame(raw.subarray(0, -1)));
  const flipped = raw.slice(); flipped[4] = 77;
  assert.throws(() => decodeFrame(flipped));
});

test('memory contract clones bytes, preserves order and supports unsubscribe', async () => {
  const bus = createMemoryEndpoint(), items = [];
  const stop = bus.subscribe(frame => items.push(frame));
  const first = { documentId: 'a', bytes: Uint8Array.from([0, 255]) };
  await bus.send(first);
  first.bytes[0] = 99;
  await bus.send({ documentId: 'b', bytes: Uint8Array.from([9]) });
  stop();
  await bus.send({ documentId: 'c', bytes: Uint8Array.from([1]) });
  assert.deepEqual(items, [
    { documentId: 'a', bytes: Uint8Array.from([0, 255]) },
    { documentId: 'b', bytes: Uint8Array.from([9]) }
  ]);
});

test('canonical accountless QR invitation validates schema and expiry', () => {
  const now = Date.UTC(2026, 9, 12);
  const example = {
    spaceId: 'ab'.repeat(16), inviterPublicKey: 'cd'.repeat(32), nonce: 'ef'.repeat(16),
    issuedAt: now, expiresAt: now + 5 * 60 * 1000,
    addressHints: ['https://relay.example.test', '192.0.2.7:5540']
  };
  const token = encodeInvitation(example);
  assert.deepEqual(decodeInvitation(token, now + 1000), {
    version: 1, ...example, addressHints: ['192.0.2.7:5540', 'https://relay.example.test']
  });
  assert.equal(encodeInvitation(example), token);
  assert.throws(() => decodeInvitation(token, now + 600000), /expired/);
  assert.throws(() => decodeInvitation(token + '!', now), /Non-canonical|Invalid/);
  assert.throws(() => encodeInvitation({ ...example, expiresAt: now + 86400000 }));
});
