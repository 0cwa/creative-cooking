// Deterministic Automerge change history; fresh AES-GCM test key/IVs on each run.
// The relay receives ONLY individually encrypted binary changes, not JSON snapshots.
// This code is deliberately outside Creative Cooking's app package/build.
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as Automerge from '@automerge/automerge';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node make-fixtures.mjs <output.json>');
const key = randomBytes(32);
const actor = 'cc00cc00cc00cc00cc00cc00cc00cc00';
let document = Automerge.init({ actor });
const fixtureChanges = [];
const steps = [
  {
    kind: 'pantry',
    mutate(d) {
      d.pantry = [{ id: 'p-001', name: 'chickpeas (cooked)', preference: 5 }];
    }
  },
  {
    kind: 'recipe',
    mutate(d) {
      d.recipes = [{
        id: 'r-001',
        title: 'Citrus chickpea skillet',
        portions: 2,
        ingredients: [{ name: 'chickpeas', amount: '1 tin' }],
        steps: ['Warm the chickpeas', 'Finish with lemon']
      }];
    }
  },
  {
    kind: 'chat',
    mutate(d) {
      d.chatMessages = [{
        id: 'm-001',
        role: 'assistant',
        content: 'Try smoky chickpeas with lemon.',
        createdAt: '2026-10-12T00:00:00.000Z'
      }];
    }
  }
];
for (const step of steps) {
  document = Automerge.change(document, step.mutate);
  const plain = Automerge.getLastLocalChange(document);
  assert.ok(plain instanceof Uint8Array && plain.length > 0, 'Expected genuine Automerge change bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  fixtureChanges.push({
    kind: step.kind,
    head: [...createHash('sha256').update(plain).digest()],
    ciphertext: [...envelope],
    plainSha256: createHash('sha256').update(plain).digest('hex'),
    plainLength: plain.length,
    ciphertextLength: envelope.length
  });
}
assert.deepEqual(fixtureChanges.map(c => c.kind), ['pantry', 'recipe', 'chat']);
writeFileSync(destination, JSON.stringify({
  format: 'creative-cooking-subduction-fixture-v1',
  actor,
  key: [...key],
  changes: fixtureChanges,
  expected: Automerge.toJS(document),
  plaintextSentinels: ['chickpeas (cooked)', 'Citrus chickpea skillet', 'Try smoky chickpeas with lemon.']
}, null, 2));
console.log('Created three incremental encrypted Automerge changes in ' + destination);
