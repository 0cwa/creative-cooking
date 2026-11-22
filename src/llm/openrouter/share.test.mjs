import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { obfuscateOpenRouterKey } from './sharePayload.ts';

// Exercise the real share importer and credential vault with browser storage.
// Only native platform modules are substituted; no source code is rewritten.
const platform = `data:text/javascript,${encodeURIComponent('export const Platform = { OS: "web" };')}`;
const secureStore = `data:text/javascript,${encodeURIComponent('export {};')}`;
const vault = new URL('../../storage/credentialVault.ts', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (specifier === 'react-native') return { url: ${JSON.stringify(platform)}, shortCircuit: true };
    if (specifier === 'expo-secure-store') return { url: ${JSON.stringify(secureStore)}, shortCircuit: true };
    if (specifier === '@/storage/credentialVault') return nextResolve(${JSON.stringify(vault)}, context);
    if (specifier === './sharePayload') return nextResolve(new URL('./sharePayload.ts', context.parentURL).href, context);
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { importSharedOpenRouterKey } = await import('./share.ts');

const captureKey = 'creative-cooking-openrouter-share-v1';
const credentialKey = 'creative-cooking-openrouter-key';

function browserStorage(t) {
  const storage = () => {
    const values = new Map();
    return {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    };
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = { sessionStorage: storage(), localStorage: storage() };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  return browser;
}

test('a failed shared-key save retains its captured link and a retry saves the same key', async t => {
  const browser = browserStorage(t);
  const key = `sk-or-v1-${'01'.repeat(32)}`;
  const payload = obfuscateOpenRouterKey(key);
  browser.sessionStorage.setItem(captureKey, payload);
  const save = browser.localStorage.setItem;
  let denied = true;
  let attempts = 0;
  browser.localStorage.setItem = (name, value) => {
    attempts += 1;
    if (denied) throw new Error('Injected credential storage failure');
    save(name, value);
  };

  await assert.rejects(importSharedOpenRouterKey(), /Injected credential storage failure/);
  assert.equal(browser.sessionStorage.getItem(captureKey), payload);
  assert.equal(browser.localStorage.getItem(credentialKey), null);

  denied = false;
  assert.equal(await importSharedOpenRouterKey(), true);
  assert.equal(browser.localStorage.getItem(credentialKey), key);
  assert.equal(browser.sessionStorage.getItem(captureKey), null);
  assert.equal(await importSharedOpenRouterKey(), false);
  assert.equal(attempts, 2);
});

test('a successful shared-key save consumes the captured link', async t => {
  const browser = browserStorage(t);
  const key = `sk-or-v1-${'23'.repeat(32)}`;
  browser.sessionStorage.setItem(captureKey, obfuscateOpenRouterKey(key));

  assert.equal(await importSharedOpenRouterKey(), true);
  assert.equal(browser.localStorage.getItem(credentialKey), key);
  assert.equal(browser.sessionStorage.getItem(captureKey), null);
});

test('a malformed shared link is consumed and reported only once', async t => {
  const browser = browserStorage(t);
  browser.sessionStorage.setItem(captureKey, 'xabc');

  await assert.rejects(importSharedOpenRouterKey(), /invalid/);
  assert.equal(browser.sessionStorage.getItem(captureKey), null);
  assert.equal(browser.localStorage.getItem(credentialKey), null);
  assert.equal(await importSharedOpenRouterKey(), false);
});

test('finishing a shared-key import leaves a newer captured link available', async t => {
  const browser = browserStorage(t);
  const firstKey = `sk-or-v1-${'45'.repeat(32)}`;
  const secondKey = `sk-or-v1-${'67'.repeat(32)}`;
  const secondPayload = obfuscateOpenRouterKey(secondKey);
  browser.sessionStorage.setItem(captureKey, obfuscateOpenRouterKey(firstKey));
  const save = browser.localStorage.setItem;
  browser.localStorage.setItem = (name, value) => {
    save(name, value);
    browser.sessionStorage.setItem(captureKey, secondPayload);
    browser.localStorage.setItem = save;
  };

  assert.equal(await importSharedOpenRouterKey(), true);
  assert.equal(browser.localStorage.getItem(credentialKey), firstKey);
  assert.equal(browser.sessionStorage.getItem(captureKey), secondPayload);
  assert.equal(await importSharedOpenRouterKey(), true);
  assert.equal(browser.localStorage.getItem(credentialKey), secondKey);
  assert.equal(browser.sessionStorage.getItem(captureKey), null);
});
