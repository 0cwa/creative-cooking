import { expect, test } from '@playwright/test';

const now = '2026-10-12T12:00:00.000Z';
const recipe = { id: 'recipe-personal', title: 'Private lentils', portions: 2, ingredients: [{ name: 'lentils', needsShopping: true }], steps: ['Cook lentils'], notes: ['private note'], createdAt: now, updatedAt: now };
const household = (id, name) => ({ id, name, shoppingList: [], recipes: [], requirements: { allergies: [], diet: 'none' }, createdAt: now, updatedAt: now });

async function seed(page, state) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((value) => {
    if (!localStorage.getItem('household-test-seeded')) {
      localStorage.setItem('creative-cooking-state-v1', JSON.stringify(value));
      localStorage.setItem('household-test-seeded', '1');
    }
    localStorage.setItem('creative-cooking-install-prompt-dismissed-v1', '1');
  }, state);
}
async function saved(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('creative-cooking', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction('app-state', 'readonly').objectStore('app-state').get('creative-cooking-state-v1');
      request.onsuccess = () => { database.close(); resolve(request.result ? JSON.parse(request.result) : null); };
      request.onerror = () => { database.close(); reject(request.error); };
    };
  }));
}

async function ready(page) {
  await expect(page.getByText('Cooking up something creative', { exact: true })).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => Boolean(await saved(page))).toBe(true);
}

test('household shopping scopes, explicit recipe copies and requirements survive reload and backup', async ({ page }) => {
  await seed(page, { pantry: [], shoppingList: [], recipes: [recipe], households: [household('home', 'Home'), household('parents', 'Parents')], activeHouseholdId: null });
  await page.goto('./shopping');
  await ready(page);
  await expect(page.getByRole('button', { name: 'Choose household shopping list' })).toContainText('Personal list');
  await page.getByRole('textbox', { name: 'Shopping item' }).fill('personal coffee');
  await page.getByRole('button', { name: 'Add shopping item' }).click();
  await page.getByRole('button', { name: 'Choose household shopping list' }).click();
  await page.getByRole('button', { name: 'Use Home shopping list' }).click();
  await page.getByRole('button', { name: 'Copy Private lentils to household' }).click();
  await expect(page.getByRole('button', { name: 'Remove copy of Private lentils' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Household allergies' }).fill('peanuts');
  await page.getByRole('radio', { name: 'vegan', exact: true }).click();
  await page.getByRole('button', { name: 'Save household requirements' }).click();
  await page.getByRole('button', { name: 'Back to Shopping' }).click();
  await expect(page.getByText('personal coffee', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Shopping item' }).fill('home rice');
  await page.getByRole('button', { name: 'Add shopping item' }).click();
  await page.getByRole('button', { name: 'Choose household shopping list' }).click();
  await page.getByRole('button', { name: 'Use Parents shopping list' }).click();
  await expect(page.getByText('No recipe copies yet')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Shopping' }).click();
  await expect(page.getByText('home rice', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Shopping item' }).fill('parents oranges');
  await page.getByRole('button', { name: 'Add shopping item' }).click();
  await page.reload();
  await expect(page.getByText('parents oranges', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose household shopping list' }).click();
  await page.getByRole('button', { name: 'Use Home shopping list' }).click();
  await expect(page.getByRole('textbox', { name: 'Household allergies' })).toHaveValue('peanuts');
  await expect.poll(async () => (await saved(page)).activeHouseholdId).toBe('home');
  const state = await saved(page);
  expect(state.shoppingList.map((entry) => entry.name)).toEqual(['personal coffee']);
  expect(state.households[0].shoppingList.map((entry) => entry.name)).toEqual(['home rice']);
  expect(state.households[1].shoppingList.map((entry) => entry.name)).toEqual(['parents oranges']);
  expect(state.recipes[0].notes).toEqual(['private note']);
  expect(state.households[0].recipes[0].recipe.notes).toBeUndefined();
  expect(state.households[0].recipes[0].recipe.ingredients[0].needsShopping).toBeUndefined();
  await page.goto('./settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  const download = await downloadPromise;
  const fs = await import('node:fs/promises');
  const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(backup.state.shoppingList.map((entry) => entry.name)).toEqual(['personal coffee']);
  expect(backup.state.households).toEqual(state.households);
  expect(backup.state.activeHouseholdId).toBe('home');
});

test('an unavailable selected household falls back to the personal list without data loss', async ({ page }) => {
  await seed(page, { shoppingList: [{ id: 'personal', name: 'personal tea', checked: false, createdAt: now, updatedAt: now }], households: [household('home', 'Home')], activeHouseholdId: 'missing' });
  await page.goto('./shopping');
  await ready(page);
  await expect(page.getByRole('button', { name: 'Choose household shopping list' })).toContainText('Personal list');
  await expect(page.getByRole('checkbox', { name: 'personal tea purchased' })).toBeVisible();
  await expect.poll(async () => (await saved(page)).activeHouseholdId).toBe(null);
  expect((await saved(page)).households).toHaveLength(1);
});

test('creating a household needs no account and starts with a separate empty list', async ({ page }) => {
  await seed(page, { shoppingList: [{ id: 'personal', name: 'personal tea', checked: false, createdAt: now, updatedAt: now }] });
  await page.goto('./households');
  await ready(page);
  await page.getByRole('textbox', { name: 'Household name' }).fill('Weekend home');
  await page.getByRole('button', { name: 'Create household', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use Weekend home shopping list' })).toContainText('Selected');
  await page.getByRole('button', { name: 'Back to Shopping' }).click();
  await expect(page.getByRole('button', { name: 'Choose household shopping list' })).toContainText('Weekend home');
  await expect(page.getByText('personal tea', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose household shopping list' }).click();
  await page.getByRole('button', { name: 'Use personal shopping list' }).click();
  await page.getByRole('button', { name: 'Back to Shopping' }).click();
  await expect(page.getByRole('checkbox', { name: 'personal tea purchased' })).toBeVisible();
});
