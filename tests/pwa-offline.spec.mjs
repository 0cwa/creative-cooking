import { expect, test } from '@playwright/test';

test('Pantry and Recipes survive an offline reload from the exported PWA', async ({ page, context }) => {
  await page.goto('./');
  await expect(page.getByText('Pantry', { exact: true }).first()).toBeVisible();

  const ingredient = page.getByLabel('Ingredient name');
  await ingredient.fill('offline carrots');
  await ingredient.press('Enter');
  await expect(page.getByText('offline carrots', { exact: true })).toBeVisible();

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
