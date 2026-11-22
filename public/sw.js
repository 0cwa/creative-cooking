const CACHE = 'creative-cooking-v3';
// Replaced with this export's local runtime assets by scripts/build-pwa-cache.mjs.
const PRECACHE_ASSETS = [];
const scopePath = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const appRoot = `${scopePath}/`;
const TRANSFORMERS_RUNTIME = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([
    appRoot,
    `${scopePath}/manifest.json`,
    ...PRECACHE_ASSETS.map((path) => `${scopePath}/${path}`)
  ])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && /^creative-cooking-v[0-9]+$/.test(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (url.href === TRANSFORMERS_RUNTIME) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    })));
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    const savedPage = async () => {
      const page = await caches.match(event.request);
      if (page?.ok) return page;
      const home = await caches.match(appRoot);
      return home?.ok ? home : undefined;
    };
    event.respondWith(fetch(event.request).then(async (response) => {
      // A temporary host error must not replace the last working app page.
      if (!response.ok) return (await savedPage()) || response;
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(savedPage));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
