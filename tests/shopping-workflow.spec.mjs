import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('Pantry buy-again moves items to the persistent Shopping tab', async ({ page }) => {
  const state = {
    pantry: [
      {
        id: 'pantry-milk',
        name: 'milk',
        preference: 4,
        createdAt: '2026-09-25T08:00:00.000Z',
        updatedAt: '2026-09-25T08:00:00.000Z'
      },
      {
        id: 'pantry-basil',
        name: 'basil (fresh)',
        preference: 5,
        createdAt: '2026-09-25T08:00:00.000Z',
        updatedAt: '2026-09-25T08:00:00.000Z'
      },
      {
        id: 'pantry-rice',
        name: 'jasmine rice',
        preference: 3,
        createdAt: '2026-09-25T08:00:00.000Z',
        updatedAt: '2026-09-25T08:00:00.000Z'
      }
    ],
    shoppingList: [],
    recipes: []
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((seed) => {
    window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify(seed));
    window.localStorage.setItem('creative-cooking-install-prompt-dismissed-v1', '1');
  }, state);

  await mkdir('test-results/screenshots', { recursive: true });
  await page.goto('./');

  await expect(page.getByText('milk', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Buy milk again')).toBeVisible();
  await expect(page.getByText('Cooking up something creative', { exact: true })).toHaveCount(0, { timeout: 10_000 });
  await page.screenshot({
    path: 'test-results/screenshots/pantry-buy-again.png',
    fullPage: true
  });

  await page.getByLabel('Buy milk again').click();
  await expect(page.getByText('milk', { exact: true })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Shop' }).click();
  await expect(page.getByText('Shopping', { exact: true })).toBeVisible();
  await expect(page.getByText('milk', { exact: true })).toBeVisible();

  await page.getByRole('textbox', { name: 'Shopping item' }).fill('lemons');
  await page.getByRole('button', { name: 'Add shopping item' }).click();
  await expect(page.getByText('lemons', { exact: true })).toBeVisible();

  await page.getByLabel('lemons purchased').click();
  await expect(page.getByText('1 item purchased', { exact: true })).toBeVisible();
  await page.screenshot({
    path: 'test-results/screenshots/shopping-list.png',
    fullPage: true
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('milk', { exact: true })).toBeVisible();
  await expect(page.getByText('lemons', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Food preference 4 out of 5')).toBeVisible();
  await expect(page.getByText('1 item purchased', { exact: true })).toBeVisible();

  await page.getByLabel('milk purchased').click();
  await page.getByRole('button', { name: 'Put checked items in Pantry' }).click();
  await expect(page.getByText('Your shopping list is clear', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Pantry' }).click();
  await expect(page.getByText('milk', { exact: true })).toBeVisible();
  await expect(page.getByText('lemons', { exact: true })).toBeVisible();
});
