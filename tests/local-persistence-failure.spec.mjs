import { test, expect, startLocalWorkspace } from './local-workspace-fixture.mjs';

test('interrupted local content write stays visibly unsaved and can be retried after reload', async ({ page }) => {
  await page.addInitScript(() => {
    window.__failNextContentWrite = false;
    window.__contentWriteFailures = 0;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.__failNextContentWrite && typeof args[1]==='string' && args[1].startsWith('["document",')) {
        window.__failNextContentWrite = false;
        window.__contentWriteFailures += 1;
        throw new DOMException('Synthetic browser storage quota exceeded.', 'QuotaExceededError');
      }
      return originalPut.apply(this, args);
    };
  });

  await startLocalWorkspace(page);
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await page.evaluate(() => { window.__failNextContentWrite = true; });

  await page.getByLabel('Ingredient and details').fill('transaction failure fixture');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await expect(page.getByText('transaction failure fixture', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__contentWriteFailures)).toBe(1);
  const persistenceStatus = page.getByTestId('pantry-local-persistence-status');
  await expect(persistenceStatus).toHaveText('Local save failed');
  await expect(page.getByText('transaction failure fixture', { exact: true })).toBeVisible();

  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
  await expect(page.getByText('transaction failure fixture', { exact: true })).toHaveCount(0);

  await page.getByLabel('Ingredient and details').fill('transaction failure fixture');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('transaction failure fixture', { exact: true })).toBeVisible();
});
