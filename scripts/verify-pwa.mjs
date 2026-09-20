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
assert.match(sw, /creative-cooking-v\d+/);
assert.match(sw, /event\.request\.mode === 'navigate'/);
assert.match(sw, /caches\.match\(appRoot\)/);
assert.match(sw, /url\.origin !== self\.location\.origin/);

const index = read('index.html').toString('utf8');
assert.match(index, /\/creative-cooking\/manifest\.json/);
assert.match(index, /\/creative-cooking\/sw\.js/);
assert.match(index, /scope:\s*['"]\/creative-cooking\/['"]/);

const htmlFiles = walk(root)
  .filter((path) => path.endsWith('.html'))
  .map((path) => relative(root, path).replaceAll('\\', '/'));
const routeBasenames = new Set(htmlFiles.map((path) => basename(path)));
for (const route of ['index.html', 'chef.html', 'recipes.html', 'settings.html']) {
  assert.ok(routeBasenames.has(route), `Missing exported static route: ${route}; got ${htmlFiles.join(', ')}`);
}

console.log(`PWA artifact smoke passed for ${htmlFiles.length} exported HTML routes.`);
