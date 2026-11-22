import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://cooking.example';
const appRoot = `${origin}/creative-cooking/`;
const recipes = `${appRoot}recipes`;

function worker({saved = [], network, precache = async () => {}}) {
  const listeners = new Map();
  const pages = new Map(saved);
  const writes = [];
  const activationRequests = [];
  const urlOf = request => new URL(typeof request === 'string' ? request : request.url, origin).href;
  const cache = {
    addAll(requests) { return precache(Array.from(requests, urlOf)); },
    async put(request, response) {
      const url = urlOf(request);
      writes.push(url);
      pages.set(url, response);
    }
  };
  const caches = {
    async open() { return cache; },
    async match(request) { return pages.get(urlOf(request))?.clone(); }
  };
  const self = {
    registration: {scope: appRoot},
    location: {origin},
    async skipWaiting() { activationRequests.push('skipWaiting'); },
    addEventListener(name, listener) { listeners.set(name, listener); }
  };
  vm.runInNewContext(source, {self, caches, fetch: request => network(request), URL});

  return {
    writes,
    activationRequests,
    cached: url => pages.get(url)?.clone(),
    install() {
      let completion;
      listeners.get('install')({waitUntil(promise) { completion = promise; }});
      return completion;
    },
    async navigate(url) {
      let result;
      listeners.get('fetch')({
        request: {url, method: 'GET', mode: 'navigate'},
        respondWith(response) { result = response; }
      });
      return await result;
    }
  };
}

test('installation waits for startup precaching without forcing an update over open tabs', async () => {
  let beginPrecache, finishPrecache;
  const started = new Promise(resolve => { beginPrecache = resolve; });
  const pending = new Promise(resolve => { finishPrecache = resolve; });
  let requested;
  const app = worker({precache: async urls => {
    requested = urls;
    beginPrecache();
    await pending;
  }});
  let installed = false;
  const installation = app.install().then(() => { installed = true; });

  await started;
  assert.equal(installed, false, 'Installation must remain pending while startup files are being cached.');
  assert.deepEqual(requested, [appRoot, `${appRoot}manifest.json`]);
  assert.deepEqual(app.activationRequests, []);

  finishPrecache();
  await installation;
  assert.equal(installed, true);
  assert.deepEqual(app.activationRequests, [], 'A ready update must wait for tabs using the previous worker.');
});

test('failed startup precaching rejects installation without requesting immediate activation', async () => {
  const app = worker({precache: async () => { throw new Error('Could not cache startup assets'); }});

  await assert.rejects(app.install(), /Could not cache startup assets/);
  assert.deepEqual(app.activationRequests, []);
});

test('a temporary HTTP failure preserves the saved route for this visit and an offline reopen', async () => {
  let offline = false;
  const app = worker({
    saved: [[recipes, new Response('saved recipes')], [appRoot, new Response('saved kitchen')]],
    network: async () => {
      if (offline) throw new TypeError('Failed to fetch');
      return new Response('temporary hosting failure', {status: 503});
    }
  });

  const response = await app.navigate(recipes);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'saved recipes');
  assert.deepEqual(app.writes, []);
  assert.equal(await app.cached(recipes).text(), 'saved recipes');

  offline = true;
  assert.equal(await (await app.navigate(recipes)).text(), 'saved recipes');
});

test('an unavailable route uses the saved app root and skips an old cached error page', async () => {
  const app = worker({
    saved: [[recipes, new Response('old error page', {status: 503})], [appRoot, new Response('saved kitchen')]],
    network: async () => new Response('route unavailable', {status: 404})
  });

  const response = await app.navigate(recipes);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'saved kitchen');
  assert.equal(await app.cached(appRoot).text(), 'saved kitchen');
  assert.deepEqual(app.writes, []);
});

test('an HTTP failure without a usable cached page remains an HTTP failure and is not cached', async () => {
  const app = worker({network: async () => new Response('hosting unavailable', {status: 503})});

  const response = await app.navigate(appRoot);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'hosting unavailable');
  assert.equal(app.cached(appRoot), undefined);
  assert.deepEqual(app.writes, []);
});

test('a successful navigation still returns and caches the updated app document', async () => {
  const app = worker({
    saved: [[appRoot, new Response('previous setup')]],
    network: async () => new Response('updated setup')
  });

  const response = await app.navigate(appRoot);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'updated setup');
  assert.deepEqual(app.writes, [appRoot]);
  assert.equal(await app.cached(appRoot).text(), 'updated setup');
});
