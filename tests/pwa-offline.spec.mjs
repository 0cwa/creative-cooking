import { expect, test } from '@playwright/test';

test('Pantry and Recipes survive an offline reload from the exported PWA', async ({ page, context }) => {
  await page.goto('./');
  await expect(page.getByText('Pantry', { exact: true }).first()).toBeVisible();

  const ingredient = page.getByLabel('Ingredient name');
  await ingredient.fill('offline carrots');
  await ingredient.press('Enter');
  await expect(page.getByText('offline carrots', { exact: true })).toBeVisible();

  await expect.poll(async () => page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('creative-cooking', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const transaction = database.transaction('app-state', 'readonly');
      const request = transaction.objectStore('app-state').get('creative-cooking-state-v1');
      request.onsuccess = () => resolve(request.result ?? '');
      request.onerror = () => reject(request.error);
    });
    database.close();
    return raw;
  })).toContain('offline carrots');

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable in this browser');
    await navigator.serviceWorker.ready;
  });

  await page.goto('./recipes');
  await expect(page.getByText('Saved recipes', { exact: true })).toBeVisible();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Saved recipes', { exact: true })).toBeVisible();

  await page.goto('./');
  await expect(page.getByText('Pantry', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('offline carrots', { exact: true })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('offline carrots', { exact: true })).toBeVisible();
});


test('existing localStorage app state migrates to IndexedDB without losing data', async ({ page }) => {
  const legacyState = {
    pantry: [{
      id: 'legacy-lentils',
      name: 'legacy lentils',
      preference: 4,
      createdAt: '2026-09-20T12:00:00.000Z',
      updatedAt: '2026-09-20T12:00:00.000Z'
    }]
  };

  await page.addInitScript((state) => {
    window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify(state));
  }, legacyState);

  await page.goto('./');
  await expect(page.getByText('legacy lentils', { exact: true })).toBeVisible();

  await expect.poll(async () => page.evaluate(() => (
    window.localStorage.getItem('creative-cooking-state-v1')
  ))).toBeNull();

  await expect.poll(async () => page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('creative-cooking', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const transaction = database.transaction('app-state', 'readonly');
      const request = transaction.objectStore('app-state').get('creative-cooking-state-v1');
      request.onsuccess = () => resolve(request.result ?? '');
      request.onerror = () => reject(request.error);
    });
    database.close();
    return raw;
  })).toContain('legacy lentils');
});
