// Deliberately isolated compatibility correction for the published
// loro-react-native@1.10.3 JavaScript adapter, NOT its Rust/UniFFI core.
// The pristine official adapter treats false, 0 and '' as Loro null.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const operation = process.argv[2];
if (!['--check', '--apply'].includes(operation)) {
  console.error('usage: node patch-published-falsy-adapter.mjs --check|--apply [manifest.json]');
  process.exit(2);
}
const base = path.resolve('node_modules/loro-react-native');
const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'loro-react-native');
assert.equal(pkg.version, '1.10.3', 'Refuse unreviewed native binding upgrades');
const marker = 'const jsValueToLoroValue';
const original = 'if (!value) {';
const fixed = 'if (value === null || value === undefined) {';
const candidates = [
  'src/extension.ts',
  'lib/module/extension.js',
  'lib/commonjs/extension.js'
];
const staged = [];
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
for (const relative of candidates) {
  const file = path.join(base, relative);
  if (!fs.existsSync(file)) {
    if (relative === 'src/extension.ts') throw new Error('Published RN source adapter missing');
    continue;
  }
  const before = fs.readFileSync(file, 'utf8');
  const start = before.indexOf(marker);
  if (start < 0) {
    if (relative === 'src/extension.ts') throw new Error('Published converter marker missing');
    continue;
  }
  if (before.indexOf(marker, start + 1) !== -1) {
    throw new Error('Ambiguous converter location in ' + relative);
  }
  // Fix only the first guard inside the published converter's immediate
  // function body. Do not change container types, FFI or Rust algorithms.
  const window = before.slice(start, start + 280);
  if (window.split(original).length !== 2 || window.includes(fixed)) {
    throw new Error('Unrecognized/unpatched converter in ' + relative);
  }
  const after = before.slice(0, start) + window.replace(original, fixed)
    + before.slice(start + 280);
  staged.push({ path: relative, file, before, after,
    originalSha256: sha256(before), patchedSha256: sha256(after) });
}
assert.ok(staged.some((entry) => entry.path === 'src/extension.ts'));
if (operation === '--apply') {
  for (const entry of staged) fs.writeFileSync(entry.file, entry.after);
}
const result = {
  status: operation === '--apply' ? 'patched' : 'confirmed-unpatched',
  publishedVersion: pkg.version,
  pinnedUpstreamReleaseCommit: '509d436255fe21e89ba36bd1ee5fb5873a7e7ae0',
  scope: 'published RN JavaScript adapter only; official compiled Rust/UniFFI unchanged',
  change: original + '  ->  ' + fixed,
  affectedFiles: staged.map(({path,originalSha256,patchedSha256}) => ({
    path, originalSha256, patchedSha256
  }))
};
if (process.argv[3]) {
  const output = path.resolve(process.argv[3]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
