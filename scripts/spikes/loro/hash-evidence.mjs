// Hash each captured native evidence file independently of the Actions ZIP hash.
// This runs even on failed native CI jobs; it never changes the result parser.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.argv[2];
if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('usage: node hash-evidence.mjs <existing-artifact-directory>');
  process.exit(2);
}
const files = [];
function walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const p = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && entry.name !== 'SHA256SUMS.txt') files.push(p);
  }
}
walk(root);
files.sort();
const lines = files.map((p) => {
  const digest = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  return digest + '  ' + path.relative(root, p).replaceAll(path.sep, '/');
});
fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), lines.join('\n') + (lines.length ? '\n' : ''));
console.log(JSON.stringify({
  directory: root, hashedFiles: files.length,
  revision: process.env.GITHUB_SHA ?? null,
  sha256Manifest: createHash('sha256').update(lines.join('\n') + (lines.length ? '\n' : '')).digest('hex')
}));
