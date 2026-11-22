import { expect, test, startLocalWorkspace } from './local-workspace-fixture.mjs';

test('Pantry and Recipes survive an offline reload from the exported PWA', async ({ page, context }) => {
  await startLocalWorkspace(page);
  await expect(page.getByText('Pantry', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Creative Cooking is getting the kitchen ready' })).toHaveCount(0);

  const ingredient = page.getByLabel('Ingredient and details');
  await ingredient.fill('offline carrots');
  await ingredient.press('Enter');
  await expect(page.getByText('offline carrots', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable in this browser');
    await navigator.serviceWorker.ready;
  });

  await page.goto('./recipes');
  await expect(page.getByRole('heading', { name: 'A little inspiration', exact: true })).toBeVisible();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'A little inspiration', exact: true })).toBeVisible();

  await page.goto('./');
  await expect(page.getByText('Pantry', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('offline carrots', { exact: true })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('offline carrots', { exact: true })).toBeVisible();
});
