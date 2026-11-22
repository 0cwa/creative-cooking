import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const root = new URL('../dist/', import.meta.url).pathname;

function read(relativePath) {
  const path = join(root, relativePath);
  assert.ok(existsSync(path), `Missing exported PWA file: ${relativePath}`);
  return readFileSync(path);
}

function pngSize(relativePath) {
  const data = read(relativePath);
  assert.equal(data.subarray(1, 4).toString('ascii'), 'PNG', `${relativePath} must be a PNG`);
  assert.ok(data.length >= 24, `${relativePath} is too small to be a valid PNG`);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20)
  };
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const manifest = JSON.parse(read('manifest.json').toString('utf8'));
assert.equal(manifest.name, 'Creative Cooking');
assert.equal(manifest.start_url, './');
assert.equal(manifest.scope, './');
assert.equal(manifest.display, 'standalone');

const icon192 = manifest.icons?.find((icon) => icon.sizes === '192x192');
const icon512 = manifest.icons?.find((icon) => icon.sizes === '512x512');
assert.ok(icon192, 'Manifest must include a 192x192 icon');
assert.ok(icon512, 'Manifest must include a 512x512 icon');
assert.deepEqual(pngSize(icon192.src.replace(/^\.\//, '')), { width: 192, height: 192 });
assert.deepEqual(pngSize(icon512.src.replace(/^\.\//, '')), { width: 512, height: 512 });

const sw = read('sw.js').toString('utf8');
const precacheMatch = sw.match(/const PRECACHE_ASSETS = (\[[\s\S]*?\]);/);
assert.ok(precacheMatch, 'PWA must include its generated startup asset list');
const precache = JSON.parse(precacheMatch[1]);
assert.ok(precache.length > 0, 'Build the PWA offline cache after exporting');
assert.equal(new Set(precache).size, precache.length, 'Offline assets must not be duplicated');
for (const asset of precache) {
  assert.ok(!asset.startsWith('/') && !asset.includes('..') && !asset.includes('://'), `Offline asset must stay within the app scope: ${asset}`);
  read(asset.split('?')[0]);
}
assert.match(sw, /creative-cooking-v\d+/);
assert.match(sw, /event\.request\.mode === 'navigate'/);
assert.match(sw, /caches\.match\(appRoot\)/);
assert.match(sw, /url\.origin !== self\.location\.origin/);
assert.match(sw, /@huggingface\/transformers@3\.8\.1/);
assert.match(read('whisper-worker.js').toString('utf8'), /onnx-community\/whisper-tiny/);
assert.ok(read('_expo/static/js/web/loro_wasm_bg.wasm').length > 1_000_000, 'PWA must include the Loro runtime');
assert.ok(precache.includes('_expo/static/js/web/loro_wasm_bg.wasm?v=1.17.1'), 'Offline cache must include the exact versioned Loro request');

const index = read('index.html').toString('utf8');
assert.match(index, /\/creative-cooking\/manifest\.json/);
assert.match(index, /\/creative-cooking\/sw\.js/);
assert.match(index, /scope:\s*['"]\/creative-cooking\/['"]/);
for (const [, source] of index.matchAll(/<script[^>]+src="([^"]+)"/g)) {
  assert.ok(source.startsWith('/creative-cooking/'), `PWA bundle must load under its GitHub Pages base path: ${source}`);
  assert.ok(precache.includes(source.slice('/creative-cooking/'.length)), `First-visit offline cache is missing an entry script: ${source}`);
}
for (const path of walk(join(root, '_expo'))) {
  const asset = relative(root, path).replaceAll('\\', '/');
  if (/\.(?:js|css)$/.test(asset)) assert.ok(precache.includes(asset), `Offline cache is missing a runtime chunk: ${asset}`);
}

const htmlFiles = walk(root)
  .filter((path) => path.endsWith('.html'))
  .map((path) => relative(root, path).replaceAll('\\', '/'));
const routeBasenames = new Set(htmlFiles.map((path) => basename(path)));
for (const route of ['index.html', 'chef.html', 'recipes.html', 'settings.html']) {
  assert.ok(routeBasenames.has(route), `Missing exported static route: ${route}; got ${htmlFiles.join(', ')}`);
}

console.log(`PWA artifact smoke passed for ${htmlFiles.length} exported HTML routes.`);
