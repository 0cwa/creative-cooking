// Cross-checkout composability proof; disposable keys/policy, no production protocol.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mailbox, deviceKeys, groupKey, encryptFrame, decryptFrame } from './mailbox.mjs';

if (!process.argv[2]) throw new Error('Pass the pinned household-replication/index.mjs checkout path');
const { repository, scalar, memoryPersistence } = await import(pathToFileURL(resolve(process.argv[2])).href);
const scope = { householdId: 'house-a', replicationEpoch: 1 };
const authority = { verify: async ({ sender, householdId, replicationEpoch }) =>
  sender === 'device-a' && householdId === scope.householdId && replicationEpoch === 1 };
const a = repository({ scope, authority, persistence: memoryPersistence() });
await a.change(doc => {
  doc.shoppingLists.default = { id: scalar('default'), title: scalar('Groceries'),
    items: { rice: { id: scalar('rice'), name: scalar('rice'), checked: false } }, deletedItems: {} };
}, { sender: 'device-a' });
const initial = a.snapshot();
const update = await a.change(doc => { doc.shoppingLists.default.items.rice.checked = true; }, { sender: 'device-a' });
const wire = { ...update, changes: update.changes.map(bytes => Buffer.from(bytes).toString('base64')) };
const keys = await deviceKeys(), key = await groupKey(), wrongHouseholdKey = await groupKey();
const policies = new Map([['house-a', { epoch: 1, writers: new Map([['device-a', keys.publicKey]]), readers: new Set(['device-b']) }]]);
const directory = await mkdtemp(join(tmpdir(), 'cc-household-interop-'));
try {
  const frame = await encryptFrame({ household: 'house-a', author: 'device-a', epoch: 1,
    plaintext: Buffer.from(JSON.stringify(wire)), key, signer: keys.privateKey });
  const mailbox = new Mailbox(directory, policies);
  const receipt = await mailbox.receive('house-a', frame);
  assert.equal(receipt.durable, true);
  // Fresh mailbox/repository instances model separated client lifetimes and stored bytes.
  const stored = await new Mailbox(directory, policies).read('house-a', 'device-b', frame.message);
  await assert.rejects(decryptFrame(stored, wrongHouseholdKey, keys.publicKey));
  await assert.rejects(new Mailbox(directory, policies).receive('house-b', frame));
  const decoded = JSON.parse(await decryptFrame(stored, key, keys.publicKey));
  decoded.changes = decoded.changes.map(value => new Uint8Array(Buffer.from(value, 'base64')));
  const b = repository({ scope, authority, snapshot: initial, persistence: memoryPersistence() });
  assert.equal((await b.receive(decoded, { sender: 'device-a' })).accepted, true);
  assert.deepEqual(b.projection(), a.projection());
  assert.equal(b.projection().shoppingLists[0].items[0].checked, true);
  const repeated = await mailbox.receive('house-a', frame);
  assert.deepEqual(repeated, receipt);
  assert.equal((await b.receive(decoded, { sender: 'device-a' })).accepted, true);
  console.log(JSON.stringify({ status: 'PASS', engine: 'Automerge 3.5.0',
    assertions: ['real incremental checked-item bytes', 'ciphertext storage/reopen', 'new recipient convergence',
      'wrong household and key denied', 'idempotent receipt/import'],
    nonclaims: ['in-process restart, not OS crash', 'disposable trusted policy, not pairing or distributed ACL',
      'primitive encryption fixture, not maintained group-key protocol', 'Node only, no browser/Expo execution'] }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
