import { expect, test } from '@playwright/test';

test('Loro web engine persists and reopens recipe updates across a page restart', async ({ page }) => {
  await page.goto('./loro-runtime-spike');
  const result = page.getByTestId('loro-result');
  await expect(result).toContainText('PASS');
  await expect(result).toContainText('offline update bytes=');
  await expect(result).toContainText('portable snapshot import/export=true');

  await page.reload();
  await expect(result).toContainText('reopen=restored prior bytes');
  await expect(result).toContainText('PASS');
});
