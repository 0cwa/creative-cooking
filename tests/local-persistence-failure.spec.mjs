import { test, expect } from './legacy-fixture.mjs';
import { readFile } from 'node:fs/promises';

test('interrupted local content write stays visibly unsaved and can be retried after reload', async ({ page }) => {
  await page.addInitScript(() => {
    window.__failNextContentWrite = false;
    window.__contentWriteFailures = 0;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.__failNextContentWrite && this.transaction.db.name.startsWith('creative-cooking-guest-')) {
        window.__failNextContentWrite = false;
        window.__contentWriteFailures += 1;
        throw new DOMException('Synthetic browser storage quota exceeded.', 'QuotaExceededError');
      }
      return originalPut.apply(this, args);
    };
  });

  await page.goto('./');
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await page.evaluate(() => { window.__failNextContentWrite = true; });

  await page.getByLabel('Ingredient and details').fill('transaction failure fixture');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await expect(page.getByText('transaction failure fixture', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__contentWriteFailures)).toBe(1);
  const persistenceStatus = page.getByTestId('pantry-local-persistence-status');
  await expect(persistenceStatus).toHaveText('Saving locally');
  await expect(page.getByText('transaction failure fixture', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Export backup', exact: true }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export backup', exact: true }).click()
  ]);
  const recovery = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(recovery.state.pantry.some((item) => item.name === 'transaction failure fixture')).toBe(true);

  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
  await expect(page.getByText('transaction failure fixture', { exact: true })).toHaveCount(0);

  await page.getByLabel('Ingredient and details').fill('transaction failure fixture');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('transaction failure fixture', { exact: true })).toBeVisible();
});
