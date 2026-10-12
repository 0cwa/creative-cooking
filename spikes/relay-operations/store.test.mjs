import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, unlinkSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshot, restore, verify, manifest } from './store.mjs';

test('quiescent full store backup/restore, manifest, corruption, missing blob and lost key', t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-ops-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = join(root, 'live'), backup = join(root, 'backup'), restored = join(root, 'restored');
  mkdirSync(join(live, 'blobs', 'ab'), { recursive: true });
  mkdirSync(join(live, '.keyhive'), { recursive: true });
  writeFileSync(join(live, 'sedimentree.redb'), Buffer.from('fake redb for backup-unit-test only'));
  writeFileSync(join(live, 'identity.key'), 'cd'.repeat(32), { mode: 0o600 });
  writeFileSync(join(live, 'blobs', 'ab', 'blob'), Buffer.alloc(4097, 0x80));
  writeFileSync(join(live, '.keyhive', 'state'), 'synthetic auth history');
  assert.throws(() => snapshot(live, backup), /possibly live/);
  const listing = snapshot(live, backup, { serverStopped: true });
  assert.equal(listing.files.length, 4);
  assert.equal(verify(backup).files.length, 4);
  assert.equal(restore(backup, restored, { serverStopped: true }).length, 4);
  assert.deepEqual(readFileSync(join(restored, 'blobs', 'ab', 'blob')), readFileSync(join(live, 'blobs', 'ab', 'blob')));
  const corrupt = join(root, 'corrupt');
  cpSync(backup, corrupt, { recursive: true });
  writeFileSync(join(corrupt, 'blobs', 'ab', 'blob'), 'tampered');
  assert.throws(() => verify(corrupt));
  assert.throws(() => restore(corrupt, join(root, 'must-not-exist'), { serverStopped: true }));
  const missing = join(root, 'missing');
  cpSync(backup, missing, { recursive: true });
  unlinkSync(join(missing, 'blobs', 'ab', 'blob'));
  assert.throws(() => verify(missing));
  const keyless = join(root, 'keyless');
  cpSync(backup, keyless, { recursive: true });
  unlinkSync(join(keyless, 'identity.key'));
  assert.throws(() => verify(keyless));
  const truncated = join(root, 'truncated');
  cpSync(backup, truncated, { recursive: true });
  writeFileSync(join(truncated, 'sedimentree.redb'), Buffer.alloc(4));
  assert.throws(() => verify(truncated));
  assert.ok(!existsSync(join(root, 'must-not-exist')));
});

test('manifest is stable, includes hidden files, and prohibits symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-ops-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.hidden'), 'record');
  assert.deepEqual(manifest(root).files.map(f => f.path), ['.hidden']);
  symlinkSync('.hidden', join(root, 'link-to-hidden'));
  assert.throws(() => manifest(root), /symlink/);
});

test('preflight rejects symlinks without copying their referents or leaving partial backups', t => {
  const root = mkdtempSync(join(tmpdir(), 'cc-ops-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = join(root, 'live'), backup = join(root, 'bad-backup');
  mkdirSync(live);
  writeFileSync(join(live, 'sedimentree.redb'), 'test bytes');
  writeFileSync(join(live, 'identity.key'), 'ab'.repeat(32));
  writeFileSync(join(root, 'external-secret'), 'MUST NOT ENTER SNAPSHOT');
  symlinkSync(join(root, 'external-secret'), join(live, 'unsafe-link'));
  assert.throws(() => snapshot(live, backup, { serverStopped: true }), /symlink/);
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(backup + '.incomplete'), false);
});
