import { expect, test, startLocalWorkspace } from './local-workspace-fixture.mjs';

const firstIdea = 'Lemony chickpea toast';
const secondIdea = 'Smoky tomato & white bean skillet';

test('a new cook can preview, save and shop from a recipe idea offline without seeding their kitchen', async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 740 });
  const origin = new URL(baseURL).origin;
  const external = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== origin) external.push(url.href);
  });

  await startLocalWorkspace(page);
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(page.getByTestId(/^pantry-item-/)).toHaveCount(0);
  // Visit the routes once, as required by the PWA's offline cache contract.
  await page.goto('./shopping');
  await expect(page.getByRole('button', { name: 'Create shopping list' })).toBeVisible();
  await page.goto('./recipes');
  await expect(page.getByRole('heading', { name: 'A little inspiration' })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);

  await page.getByRole('button', { name: `Preview ${firstIdea}` }).click();
  await expect(page.getByRole('heading', { name: firstIdea })).toBeVisible();
  await expect(page.getByText('Method', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close recipe idea' }).click();
  await expect(page.getByRole('button', { name: /^Open recipe / })).toHaveCount(0);

  await page.getByRole('button', { name: `Preview ${firstIdea}` }).click();
  // Two taps in the same event loop must still submit only one copy.
  await page.getByRole('button', { name: 'Save a copy of this recipe' }).evaluate(button => {
    button.click();
    button.click();
  });
  const savedRecipe = page.getByRole('button', { name: `Open recipe ${firstIdea}` });
  await expect(savedRecipe).toHaveCount(1);
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  await savedRecipe.click();
  await page.getByRole('button', { name: 'Increase portions' }).click();
  await expect(page.getByLabel('3 portions', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add ingredients to shopping list (7)' }).click();
  await page.getByLabel('New shopping list name').fill('Tonight');
  await page.getByRole('button', { name: 'Create shopping list' }).click();
  await expect(page.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
  await page.getByRole('button', { name: 'Add 7 ingredients to list' }).click();
  await expect(page.getByText('7 ingredients added to Tonight.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId(/^shopping-item-/)).toHaveCount(7);
  await page.goto('./');
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(page.getByTestId(/^pantry-item-/)).toHaveCount(0);
  await page.goto('./recipes');
  await expect(savedRecipe).toHaveCount(1);
  await savedRecipe.click();
  await expect(page.getByLabel('3 portions', { exact: true })).toBeVisible();
  expect(external).toEqual([]);
});

test('a failed idea save retains its identity when another idea is previewed and retried', async ({ page }) => {
  test.setTimeout(90_000);
  await startLocalWorkspace(page, './recipes');
  await expect(page.getByRole('button', { name: 'Add recipe', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    const attempts = [];
    IDBObjectStore.prototype.put = function(value, key) {
      if (typeof key === 'string' && key.startsWith('["recipe-catalog",')) {
        attempts.push([key, value.effectId]);
        if (attempts.length === 1) throw Error('Injected recipe publication failure');
      }
      return put.call(this, value, key);
    };
    globalThis.starterRecipeAttempts = () => attempts;
  });
  await page.getByRole('button', { name: `Preview ${firstIdea}` }).click();
  await page.getByRole('button', { name: 'Save a copy of this recipe' }).click();
  await expect(page.getByRole('button', { name: 'Retry saving this recipe' })).toBeEnabled();
  await page.getByRole('button', { name: 'Close recipe idea' }).click();

  await page.getByRole('button', { name: `Preview ${secondIdea}` }).click();
  await expect(page.getByText(`Finish saving ${firstIdea} before adding another recipe.`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save a copy of this recipe' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Finish recipe save' })).toBeEnabled();
  await page.getByRole('button', { name: 'Close recipe idea' }).click();
  await page.getByRole('button', { name: `Preview ${firstIdea}` }).click();
  await page.getByRole('button', { name: 'Retry saving this recipe' }).click();
  await expect(page.getByRole('button', { name: `Open recipe ${firstIdea}` })).toHaveCount(1);
  await expect(page.getByRole('button', { name: `Open recipe ${secondIdea}` })).toHaveCount(0);
  const attempts = await page.evaluate(() => globalThis.starterRecipeAttempts());
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Open recipe / })).toHaveCount(1);
});

test('saving a built-in idea uses the existing configured-allergy validation', async ({ page }) => {
  test.setTimeout(90_000);
  await startLocalWorkspace(page);
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('textbox', { name: 'Add allergies', exact: true }).fill('chickpeas');
  await page.getByRole('textbox', { name: 'Add allergies', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Remove allergy chickpeas' })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByText('Recipes', { exact: true }).last().click();
  await page.getByRole('button', { name: `Preview ${firstIdea}` }).click();
  await page.getByRole('button', { name: 'Save a copy of this recipe' }).click();
  await expect(page.getByRole('alert')).toContainText('Recipe blocked by allergy validation');
  await page.getByRole('button', { name: 'Close recipe idea' }).click();
  await expect(page.getByRole('button', { name: /^Open recipe / })).toHaveCount(0);
});
