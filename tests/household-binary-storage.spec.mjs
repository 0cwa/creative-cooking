import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync(new URL('../packages/household-replication/indexeddb.mjs', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

test('household binary adapter completes a real browser transaction and survives page reload', async ({ page }) => {
  await page.goto('./shopping');
  await page.evaluate(async (url) => {
    const { indexedDBPersistence } = await import(url);
    const store = await indexedDBPersistence({ databaseName: 'household-binary-browser-test' });
    await store.write('household/home-a/epoch/1', new Uint8Array([0, 17, 255, 42]));
    await store.write('household/home-b/epoch/1', new Uint8Array([99]));
    store.close();
  }, moduleUrl);
  await page.reload();
  const restored = await page.evaluate(async (url) => {
    const { indexedDBPersistence } = await import(url);
    const store = await indexedDBPersistence({ databaseName: 'household-binary-browser-test' });
    try {
      return { first: [...await store.read('household/home-a/epoch/1')],
        second: [...await store.read('household/home-b/epoch/1')],
        absent: await store.read('household/home-a/epoch/2') };
    } finally { store.close(); }
  }, moduleUrl);
  expect(restored).toEqual({ first: [0, 17, 255, 42], second: [99], absent: undefined });
});
