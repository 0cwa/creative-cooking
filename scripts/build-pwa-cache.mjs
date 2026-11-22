import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'dist');
const loroVersion = JSON.parse(readFileSync(join(root, 'node_modules/loro-crdt/package.json'), 'utf8')).version;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [relative(output, path).replaceAll('\\', '/')];
  });
}

// The worker is installed after the first page has loaded. Its fetch handler
// cannot see those earlier requests, so cache the exported runtime up front,
// including lazy chunks needed to reopen a saved kitchen. This list contains
// only local app files, never remote Chef/speech model downloads.
const assets = walk(output).filter((path) =>
  (path.startsWith('_expo/') && /\.(?:js|css|wasm)$/.test(path)) ||
  /^icon-(?:192|512)\.png$/.test(path)
).map((path) => path.endsWith('/loro_wasm_bg.wasm') ? `${path}?v=${loroVersion}` : path).sort();

assert.ok(assets.some((path) => /\/entry-[^/]+\.js$/.test(path)), 'The exported application entry is missing.');
assert.ok(assets.includes(`_expo/static/js/web/loro_wasm_bg.wasm?v=${loroVersion}`), 'Copy the Loro runtime before building the offline cache.');

const template = readFileSync(join(root, 'public/sw.js'), 'utf8');
const marker = 'const PRECACHE_ASSETS = [];';
assert.equal(template.split(marker).length, 2, 'The service-worker precache placeholder must appear exactly once.');
writeFileSync(join(output, 'sw.js'), template.replace(marker, `const PRECACHE_ASSETS = ${JSON.stringify(assets, null, 2)};`));
console.log(`Prepared ${assets.length} local runtime assets for first-visit offline reopening.`);
