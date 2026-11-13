import { test, expect } from '@playwright/test';

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
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saving locally');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
  await expect(page.getByText('transaction failure fixture', { exact: true })).toHaveCount(0);

  await page.getByLabel('Ingredient and details').fill('transaction failure fixture');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('transaction failure fixture', { exact: true })).toBeVisible();
});
