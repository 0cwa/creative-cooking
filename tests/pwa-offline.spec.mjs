import { expect, test, startLocalWorkspace } from './local-workspace-fixture.mjs';

test('a first kitchen can reopen and keep saving immediately offline after setup', async ({ page, context }) => {
  let onlineDocumentRequests = 0;
  const countDocumentRequest = request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) onlineDocumentRequests += 1;
  };
  page.on('request', countDocumentRequest);

  await startLocalWorkspace(page);
  const ingredient = page.getByLabel('Ingredient and details');
  await expect(ingredient).toBeEditable();
  await ingredient.fill('first visit carrots');
  await ingredient.press('Enter');
  await expect(page.getByText('first visit carrots', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  const workspace = await page.evaluate(() => localStorage.getItem('creative-cooking-local-workspace-v1'));
  expect(workspace).toBeTruthy();

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable in this browser');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  // No second online document request may warm the service worker's runtime cache.
  expect(onlineDocumentRequests).toBe(1);
  page.off('request', countDocumentRequest);
  await context.setOffline(true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pantry-screen')).toBeVisible();
  await expect(page.getByText('first visit carrots', { exact: true })).toBeVisible();
  await expect(ingredient).toBeEditable();
  expect(await page.evaluate(() => localStorage.getItem('creative-cooking-local-workspace-v1'))).toBe(workspace);

  await ingredient.fill('saved offline lentils');
  await ingredient.press('Enter');
  await expect(page.getByText('saved offline lentils', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('first visit carrots', { exact: true })).toBeVisible();
  await expect(page.getByText('saved offline lentils', { exact: true })).toBeVisible();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
});

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
