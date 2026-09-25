import { expect, test } from '@playwright/test';

async function persistedTheme(page) {
  return page.evaluate(async () => {
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
    return raw ? JSON.parse(raw).settings?.theme ?? null : null;
  });
}

test('system, light, and dark appearance modes update the whole app and persist', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./');

  await expect(page.getByText('Pantry', { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');

  await page.getByLabel('Open settings').click();
  await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Follow system theme')).toHaveAttribute('aria-checked', 'true');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(248, 250, 252)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');

  await page.getByLabel('Use light theme').click();
  await expect(page.getByLabel('Use light theme')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(248, 250, 252)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

  await page.getByLabel('Use dark theme').click();
  await expect(page.getByLabel('Use dark theme')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');
  await expect.poll(() => persistedTheme(page)).toBe('dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.getByText('Settings', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Use dark theme')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');
});
