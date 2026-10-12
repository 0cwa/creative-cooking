import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupKey, deviceKeys, encryptFrame, decryptFrame, Mailbox } from './mailbox.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'creative-cooking-mailbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alice = await deviceKeys(), bob = await deviceKeys(), outsider = await deviceKeys();
  const keyA = await groupKey(), keyB = await groupKey();
  const policies = new Map([
    ['householdA', { epoch: 1, writers: new Map([['alice', alice.publicKey], ['bob', bob.publicKey]]), readers: new Set(['alice', 'bob']) }],
    ['householdB', { epoch: 1, writers: new Map([['bob', bob.publicKey]]), readers: new Set(['bob']) }],
  ]);
  const frame = await encryptFrame({ household: 'householdA', author: 'alice', epoch: 1,
    plaintext: Buffer.from('private shopping list: peanuts'), key: keyA, signer: alice.privateKey });
  return { root, alice, bob, outsider, keyA, keyB, policies, frame, mailbox: new Mailbox(root, policies) };
}

test('opaque bytes survive mailbox restart; exact duplicate receipt is stable', async t => {
  const f = await fixture(t);
  const receipt = await f.mailbox.receive('householdA', f.frame);
  assert.equal(receipt.durable, true);
  const stored = await readFile(join(f.root, 'householdA', `${f.frame.message}.json`), 'utf8');
  assert.equal(stored.includes('peanuts'), false);
  const restarted = new Mailbox(f.root, f.policies);
  const frame = await restarted.read('householdA', 'bob', f.frame.message);
  assert.equal((await decryptFrame(frame, f.keyA, f.alice.publicKey)).toString(), 'private shopping list: peanuts');
  assert.deepEqual(await restarted.receive('householdA', f.frame), receipt);
});

test('cross-household route, reader and wrong group key are denied', async t => {
  const f = await fixture(t);
  await assert.rejects(f.mailbox.receive('householdB', f.frame), /Routing denied/);
  await f.mailbox.receive('householdA', f.frame);
  await assert.rejects(f.mailbox.read('householdA', 'outsider', f.frame.message), /Reader denied/);
  await assert.rejects(f.mailbox.read('householdB', 'bob', f.frame.message), /ENOENT/);
  await assert.rejects(decryptFrame(f.frame, f.keyB, f.alice.publicKey));
});

test('tamper, substituted author, version, epoch and plaintext fields are denied', async t => {
  const f = await fixture(t);
  for (const mutation of [
    { ciphertext: `A${f.frame.ciphertext.slice(1)}` }, { author: 'bob' }, { version: 2 },
    { epoch: 2 }, { plaintext: 'accidentally uploaded' },
  ]) {
    if (mutation.ciphertext === f.frame.ciphertext) mutation.ciphertext = `B${f.frame.ciphertext.slice(1)}`;
    await assert.rejects(f.mailbox.receive('householdA', { ...f.frame, ...mutation }));
  }
  const forged = await encryptFrame({ household: 'householdA', author: 'alice', epoch: 1,
    plaintext: Buffer.from('forged'), key: f.keyA, signer: f.outsider.privateKey });
  await assert.rejects(f.mailbox.receive('householdA', forged), /Signature denied/);
});

test('revocation rotates future epoch; previously decrypted or retained history stays accessible', async t => {
  const f = await fixture(t);
  await f.mailbox.receive('householdA', f.frame);
  const retained = await f.mailbox.read('householdA', 'bob', f.frame.message);
  const policy = f.policies.get('householdA');
  policy.epoch = 2; policy.writers.delete('bob'); policy.readers.delete('bob');
  const futureKey = await groupKey();
  const future = await encryptFrame({ household: 'householdA', author: 'alice', epoch: 2,
    plaintext: Buffer.from('future list'), key: futureKey, signer: f.alice.privateKey });
  await f.mailbox.receive('householdA', future);
  await assert.rejects(decryptFrame(future, f.keyA, f.alice.publicKey));
  await assert.rejects(f.mailbox.read('householdA', 'bob', future.message), /Reader denied/);
  await assert.rejects(f.mailbox.receive('householdA', f.frame), /epoch denied/);
  const revokedWriter = await encryptFrame({ household: 'householdA', author: 'bob', epoch: 2,
    plaintext: Buffer.from('stale update'), key: futureKey, signer: f.bob.privateKey });
  await assert.rejects(f.mailbox.receive('householdA', revokedWriter), /membership or epoch denied/);
  assert.equal((await decryptFrame(retained, f.keyA, f.alice.publicKey)).toString(), 'private shopping list: peanuts');
});

test('sampled nonces are distinct; failure before durable commit emits no success receipt', async t => {
  const f = await fixture(t), nonces = new Set();
  for (let i = 0; i < 100; i++) {
    const frame = await encryptFrame({ household: 'householdA', author: 'alice', epoch: 1,
      plaintext: Buffer.from(String(i)), key: f.keyA, signer: f.alice.privateKey });
    nonces.add(frame.nonce);
  }
  assert.equal(nonces.size, 100); // Sampling, not a proof of nonce safety over deployment lifetime.
  await assert.rejects(f.mailbox.receive('householdA', f.frame, { failBeforeCommit: true }), /Injected storage failure/);
  const restarted = new Mailbox(f.root, f.policies);
  await assert.rejects(restarted.read('householdA', 'alice', f.frame.message), /ENOENT/);
  assert.equal((await restarted.receive('householdA', f.frame)).durable, true);
});
