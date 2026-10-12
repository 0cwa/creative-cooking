// Genuine incremental Automerge 3.5.0 cooking-domain edits in disposable AES-GCM
// envelopes. Fixtures are not Keyhive/ARK crypto; the relay must not see keys.
import assert from 'node:assert/strict';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as A from '@automerge/automerge';

const sha = x => createHash('sha256').update(x).digest('hex');
function noise(label, characters) {
  let result = '';
  for (let i = 0; result.length < characters; i++)
    result += createHash('sha256').update(label + '/' + i).digest('base64url');
  return result.slice(0, characters);
}
function encrypt(key, plain) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}
function decrypt(key, value) {
  const bytes = Buffer.from(value);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}
function makeChanges() {
  let doc = A.init({ actor: 'abababababababababababababababab' });
  const changes = [];
  function edit(label, fn) {
    doc = A.change(doc, { message: label }, fn);
    const change = A.getLastLocalChange(doc);
    assert.ok(change && change.length > 0, 'Must generate actual incremental engine change');
    changes.push({ label, plain: Buffer.from(change) });
  }
  edit('pantry', d => {
    d.pantry = [{ id: 'pantry-1', name: 'chickpeas (cooked)', preference: 5 }];
    d.recipes = [];
    d.chats = [];
  });
  edit('recipe', d => {
    d.recipes.push({ id: 'recipe-1', title: 'Tomato toast', portions: 2, instructions: 'Toast bread, add tomatoes.' });
  });
  edit('chat', d => { d.chats.push({ id: 'chat-1', text: 'What can I cook tonight?' }); });
  edit('external-blob-sized-recipe-edit', d => {
    d.recipes[0].instructions = 'Synthetic long recipe edit ' + noise('external-blob', 60000);
  });
  for (let i = 0; i < 24; i++) {
    edit('bounded-load-' + (i + 1), d => {
      d.chats.push({ id: 'chat-' + (i + 2), text: 'Synthetic cooking conversation ' + i + ' ' + noise('chat-' + i, 1100) });
    });
  }
  return changes;
}
export function generate(path) {
  const key = randomBytes(32), generated = makeChanges(), commits = [];
  for (const [index, change] of generated.entries()) {
    const ciphertext = encrypt(key, change.plain);
    commits.push({
      index, label: change.label, id: sha(ciphertext),
      dependencies: index === 0 ? [] : [commits[index-1].id],
      ciphertextBase64: ciphertext.toString('base64'),
      ciphertextSha256: sha(ciphertext),
      bytes: ciphertext.length, plainBytes: change.plain.length, plainSha256: sha(change.plain)
    });
  }
  assert.ok(commits[3].bytes > 16384, 'Must cross external blob size threshold');
  const output = { schemaVersion:1, generatedAt:new Date().toISOString(), engine:'automerge',
    engineVersion:'3.5.0', workload:'28 exact incremental cooking-domain edits, incl >16KiB incompressible blob',
    encryption:'DISPOSABLE AES-256-GCM TEST ONLY, not Keyhive/ARK E2EE',
    ephemeralFixtureKeyHex:key.toString('hex'), commits, knownPlaintext:['chickpeas (cooked)','Tomato toast'] };
  mkdirSync(dirname(path), { recursive:true });
  writeFileSync(path, JSON.stringify(output, null, 2), {mode:0o600});
  console.log(JSON.stringify({ file:path, count:commits.length, sizes:commits.map(c=>c.bytes), externalBlobSize:commits[3].bytes }));
  verify(output, commits.map(c=>c.ciphertextBase64));
}
export function verify(fixture, observedBase64) {
  assert.equal(observedBase64.length, fixture.commits.length, 'Missing or surplus changes');
  const key = Buffer.from(fixture.ephemeralFixtureKeyHex, 'hex');
  let doc = A.init({actor:'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'});
  for (const change of fixture.commits) {
    const ciphertext = Buffer.from(change.ciphertextBase64, 'base64');
    assert.equal(sha(ciphertext), change.ciphertextSha256, 'Fixture ciphertext checksum mismatch');
    assert.ok(observedBase64.includes(change.ciphertextBase64), 'Missing original exact encrypted engine change: ' + change.label);
    const plain = decrypt(key, ciphertext);
    assert.equal(sha(plain), change.plainSha256);
    [doc] = A.applyChanges(doc, [new Uint8Array(plain)]);
  }
  const js = A.toJS(doc);
  assert.equal(js.pantry[0].name, 'chickpeas (cooked)');
  assert.equal(js.recipes[0].title, 'Tomato toast');
  assert.equal(js.chats.length, 25);
  assert.ok(js.recipes[0].instructions.length > 50000);
  return {verified:true,changeCount:fixture.commits.length,recipeTitle:js.recipes[0].title,
    finalChatCount:js.chats.length,wireBytes:fixture.commits.reduce((sum,c)=>sum+c.bytes,0)};
}
const [,,command,...args] = process.argv;
if (command === 'generate') generate(args[0] || 'artifacts/fixtures.json');
else if (command === 'verify') {
  const [fixtureFile,observedFile] = args;
  assert.ok(fixtureFile && observedFile);
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
  const received = JSON.parse(readFileSync(observedFile, 'utf8'));
  console.log(JSON.stringify(verify(fixture, received)));
} else if (command !== undefined) {
  throw new Error('Usage: fixtures.mjs generate FILE | verify FIXTURE OBSERVED');
}
