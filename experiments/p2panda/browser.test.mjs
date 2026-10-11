import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './gateway.mjs';
import { seal, open, upload, catchUp, sha256hex } from './browser/interop.mjs';
import { encodeFrame, decodeFrame } from './contract.mjs';

async function start(dir) {
  const server = createGateway(dir);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((resolve, reject) =>
      server.close(e => e ? reject(e) : resolve()))
  };
}

test('browser-compatible encrypted store-and-forward survives producer disappearance and gateway restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-panda-mailbox-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const key = new Uint8Array(randomBytes(32));
  const space = randomBytes(16).toString('hex');
  const fixtureA = encodeFrame({ documentId: 'random/a', bytes: new Uint8Array(randomBytes(8192)) });
  const fixtureB = encodeFrame({ documentId: 'binary/b', bytes: Uint8Array.from([0, 255, 0, 128]) });
  let gateway = await start(dir);
  const cA = await seal(fixtureA, key), cB = await seal(fixtureB, key);
  const idB = await upload(gateway.url, space, cB);
  const idA = await upload(gateway.url, space, cA);
  assert.equal(await upload(gateway.url, space, cA), idA); // duplicate is idempotent
  assert.notEqual(Buffer.from(await readFile(join(dir, space, idA + '.bin'))).includes(Buffer.from(fixtureA)), true);
  assert.deepEqual(await open(cA, key), fixtureA);
  await assert.rejects(open(cA, new Uint8Array(randomBytes(32)))); // third party cannot decrypt
  await gateway.close(); // A and B absent; only durable third-party mailbox remains

  gateway = await start(dir); // simulate replacement/restore of infrastructure
  const frames = await catchUp(gateway.url, space, key);
  assert.deepEqual(frames.map(f => f.id).sort(), [idA, idB].sort());
  const recovered = frames.map(f => decodeFrame(f.bytes));
  assert.deepEqual(recovered.find(x => x.documentId === 'random/a').bytes, decodeFrame(fixtureA).bytes);
  assert.deepEqual(recovered.find(x => x.documentId === 'binary/b').bytes, decodeFrame(fixtureB).bytes);
  await gateway.close();
});

test('gateway rejects tampered hashes and becomes unavailable when stopped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-panda-bad-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const gateway = await start(dir);
  const space = 'ab'.repeat(16);
  const response = await fetch(gateway.url + '/v1/spaces/' + space + '/frames/' + 'cd'.repeat(32),
    { method: 'PUT', body: Uint8Array.of(10) });
  assert.equal(response.status, 422);
  assert.equal(await sha256hex(Uint8Array.of(0, 1)), 'b413f47d13ee2fe6c845b2ee141af81de858df4ec549a58b7970bb96645bc8d2');
  await gateway.close();
  await assert.rejects(catchUp(gateway.url, space, new Uint8Array(randomBytes(32))));
});
