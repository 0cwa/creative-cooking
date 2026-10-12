// Quiescent-only full-store snapshot helper for the disposable operations spike.
// Not a live-backup or online database-snapshot implementation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const hash = (data) => createHash('sha256').update(data).digest('hex');
export function files(root) {
  if (!existsSync(root)) return [];
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Refuse symlink in persistent store: ' + path);
    if (entry.isDirectory()) return walk(path);
    if (!entry.isFile()) throw new Error('Refuse non-regular persistent file: ' + path);
    return [relative(root, path).split(sep).join('/')];
  });
  return walk(root).sort();
}
function inventory(root) {
  return files(root).filter(f => f !== 'manifest.json').map(path => {
    const content = readFileSync(join(root, path));
    return { path, bytes: content.length, sha256: hash(content) };
  });
}
export function manifest(root) {
  const entries = inventory(root);
  return { schemaVersion: 1, integrity: 'SHA-256 detection only; NOT a signed authenticity guarantee',
    files: entries, totalBytes: entries.reduce((sum, f) => sum + f.bytes, 0) };
}
export function verify(root, { requireIdentity = true } = {}) {
  assert.ok(existsSync(join(root, 'manifest.json')), 'Missing manifest');
  const saved = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(saved.schemaVersion, 1, 'Unsupported backup version');
  const actual = manifest(root);
  assert.deepEqual(actual.files, saved.files, 'Backup corruption, missing/extra file or tampered manifest');
  assert.ok(actual.files.some(f => f.path === 'sedimentree.redb'), 'Missing redb metadata');
  if (requireIdentity) assert.ok(actual.files.some(f => f.path === 'identity.key'), 'Missing server signing seed');
  assert.ok(actual.files.every(f => !f.path.startsWith('../') && !f.path.startsWith('/')));
  return actual;
}
export function snapshot(root, backupDir, { serverStopped } = {}) {
  assert.equal(serverStopped, true, 'Refuse copying a possibly live database');
  assert.ok(!lstatSync(root).isSymbolicLink(), 'Refuse symlinked store root');
  assert.ok(existsSync(join(root, 'sedimentree.redb')), 'No redb metadata');
  assert.ok(existsSync(join(root, 'identity.key')), 'Missing signing identity');
  assert.ok(!existsSync(backupDir), 'Backup destination must not already exist');
  assert.ok(!resolve(backupDir).startsWith(resolve(root) + sep), 'Backup destination must be outside source');
  const staging = backupDir + '.incomplete';
  assert.ok(!existsSync(staging), 'Refuse to overwrite interrupted backup staging area');
  // Reject symlinks and record source hashes BEFORE copying any bytes.
  const baseline = manifest(root);
  assert.ok(baseline.files.some(f => f.path === 'sedimentree.redb'));
  assert.ok(baseline.files.some(f => f.path === 'identity.key'));
  mkdirSync(dirname(backupDir), { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const name of readdirSync(root)) {
      cpSync(join(root, name), join(staging, name), { recursive: true, errorOnExist: true });
    }
    const listing = manifest(staging);
    assert.deepEqual(listing.files, baseline.files, 'Source changed during presumed quiescent backup');
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(listing, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' });
    verify(staging);
    renameSync(staging, backupDir);
    return listing;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
export function restore(backupDir, targetDir, { serverStopped } = {}) {
  assert.equal(serverStopped, true, 'Refuse writing into a live database');
  verify(backupDir);
  assert.ok(!existsSync(targetDir), 'Restore requires a nonexistent destination');
  const staging = targetDir + '.incomplete';
  assert.ok(!existsSync(staging), 'Refuse to overwrite incomplete restore');
  mkdirSync(dirname(targetDir), { recursive: true });
  try {
    cpSync(backupDir, staging, { recursive: true, errorOnExist: true });
    verify(staging);
    rmSync(join(staging, 'manifest.json'));
    renameSync(staging, targetDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  assert.ok(existsSync(join(targetDir, 'sedimentree.redb')));
  return inventory(targetDir);
}
export function directoryBytes(root) {
  return inventory(root).reduce((sum, f) => sum + f.bytes, 0);
}
