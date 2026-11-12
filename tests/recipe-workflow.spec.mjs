import { expect, test } from '@playwright/test';

async function readPersistedState(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('creative-cooking', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const transaction = database.transaction('app-state', 'readonly');
      const request = transaction.objectStore('app-state').get('creative-cooking-state-v1');
      request.onsuccess = () => resolve(request.result ?? '');
      request.onerror = () => reject(request.error);
    });
    database.close();
    return raw ? JSON.parse(raw) : null;
  });
}

function contrastRatio(foreground, background) {
  const channels = (value) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
  const luminance = (color) => {
    const [red, green, blue] = channels(color).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('shopping records migrate, persist, and purchase independently from recipe edits', async ({ page }) => {
  const state = {
    pantry: [{
      id: 'pantry-lentils',
      name: 'lentils',
      preference: 4,
      createdAt: '2026-09-21T10:00:00.000Z',
      updatedAt: '2026-09-21T10:00:00.000Z'
    }],
    recipes: [{
      id: 'recipe-lentils',
      title: 'Lentil bowl',
      description: 'A bright pantry dinner.',
      portions: 2,
      ingredients: [
        { name: 'lentils', amount: '1 cup' },
        { name: 'lemon', amount: '1/2', needsShopping: true, note: 'first lemon line' },
        { name: 'lemon', amount: '1 tsp zest', needsShopping: true, note: 'second lemon line' }
      ],
      steps: ['Warm the lentils.', 'Finish with lemon.'],
      notes: ['Taste before salting.'],
      createdAt: '2026-09-21T10:00:00.000Z',
      updatedAt: '2026-09-21T10:00:00.000Z'
    }]
  };

  await page.addInitScript((seed) => {
    window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify(seed));
  }, state);

  await page.goto('./recipes');
  await expect(page.getByText('Lentil bowl', { exact: true })).toBeVisible();
  await expect.poll(async () => (await readPersistedState(page))?.shopping?.items?.length).toBe(2);
  const migratedIds = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('creative-cooking', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const transaction = database.transaction('app-state', 'readonly');
      const request = transaction.objectStore('app-state').get('creative-cooking-state-v1');
      request.onsuccess = () => resolve(request.result ?? '');
      request.onerror = () => reject(request.error);
    });
    database.close();
    return JSON.parse(raw).shopping.items.map((item) => item.id);
  });

  await page.getByLabel('Open recipe Lentil bowl').click();
  await expect(page.getByLabel('2 portions')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add ingredients to shopping list (2)' })).toBeVisible();
  await page.getByLabel('Increase portions').click();
  await expect(page.getByLabel('3 portions')).toBeVisible();
  await expect(page.getByText(/1 1\/2 cup lentils/)).toBeVisible();
  await expect(page.getByText(/3\/4 lemon/).first()).toBeVisible();

  await page.getByLabel('Edit recipe Lentil bowl').click();
  await expect(page.getByText('Edit it like a recipe', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Recipe ingredients')).toHaveValue('1 1/2 cup lentils\n3/4 lemon\n1 1/2 tsp zest lemon');
  await page.getByLabel('Recipe title').fill('Bright lentil bowl');
  await page.getByLabel('Recipe ingredients').fill('1 1/2 cup lentils\n3/4 lemon\n1 tbsp olive oil');
  await page.getByLabel('Recipe method').fill('1. Warm the lentils.\n2. Finish with lemon.\n3. Drizzle with olive oil.');
  await page.getByLabel('Recipe notes').fill('Taste before salting.\nBest served warm.');
  await page.getByLabel('Save recipe changes').click();
  await expect(page.getByRole('dialog').getByText('Bright lentil bowl', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 tbsp olive oil/).first()).toBeVisible();

  const afterRecipeEdit = await readPersistedState(page);
  expect(afterRecipeEdit.recipes[0].ingredients).toHaveLength(3);
  expect(afterRecipeEdit.recipes[0].ingredients.find((ingredient) => ingredient.name === 'lemon')?.needsShopping).toBe(true);
  expect(afterRecipeEdit.shopping.items.map((item) => item.id)).toEqual(migratedIds);
  expect(afterRecipeEdit.shopping.items).toHaveLength(2);

  await page.getByRole('button', { name: 'Add ingredients to shopping list (2)' }).click();
  await expect(page.getByText('Saved on this device only. Shopping lists are not synced.')).toBeVisible();
  await page.getByLabel('New shopping list name').fill('Dinner');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dinner', exact: true })).toBeVisible();
  await expect(page.getByText(/2 selected ingredients will be added to Dinner\./)).toBeVisible();
  await page.getByRole('button', { name: 'Add 2 ingredients to list' }).click();
  await expect(page.getByText('lemon', { exact: true })).toBeVisible();
  await expect(page.getByText('olive oil', { exact: true })).toBeVisible();

  await page.getByLabel('Check lemon').click();
  await page.getByLabel('Check olive oil').click();
  await page.getByRole('button', { name: 'Add checked to Pantry (2)' }).click();
  await expect(page.getByText('2 checked items recorded for this purchase. Pantry entries are added only once.')).toBeVisible();
  await expect(page.getByText('Purchased', { exact: true })).toHaveCount(2);

  await page.goto('./recipes');
  await expect(page.getByText('Bright lentil bowl', { exact: true })).toBeVisible();
  await page.getByLabel('Open recipe Bright lentil bowl').click();
  await expect(page.getByRole('button', { name: /Add ingredients to shopping list/ })).toHaveCount(0);
  await page.getByLabel('Close recipe').click();
  await page.goto('./shopping');
  await expect(page.getByText('Saved on this device only. Shopping lists are not synced.')).toBeVisible();

  await page.getByLabel('New shopping list name').fill('Kitchen extras');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kitchen extras', exact: true })).toBeVisible();
  await page.getByLabel('Shopping item name').fill('paper towels');
  await page.getByLabel('Shopping quantity').fill('1');
  await page.getByLabel('Shopping unit').fill('roll');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('1 roll', { exact: true })).toBeVisible();
  await page.getByLabel('Edit paper towels').click();
  await page.getByLabel('Edit item name').fill('kitchen paper');
  await page.getByLabel('Edit item quantity').fill('2');
  await page.getByLabel('Edit item unit').fill('rolls');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('2 rolls', { exact: true })).toBeVisible();
  await page.getByLabel('Remove kitchen paper').click();
  await expect(page.getByText('kitchen paper', { exact: true })).toHaveCount(0);

  const beforeReload = await readPersistedState(page);
  expect(beforeReload.shopping.items.filter((item) => item.listId === 'shopping-list-legacy')).toHaveLength(2);
  expect(beforeReload.shopping.items.filter((item) => item.listId !== 'shopping-list-legacy' && !item.removedAt)).toHaveLength(2);
  expect(beforeReload.shopping.items.some((item) => item.name === 'kitchen paper' && item.removedAt)).toBe(true);
  expect(beforeReload.shopping.purchases).toHaveLength(1);
  expect(beforeReload.pantry.map((item) => item.name)).toEqual(expect.arrayContaining(['lemon', 'olive oil']));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Shopping list' })).toBeVisible();
  const afterReload = await readPersistedState(page);
  expect(afterReload.shopping.items.map((item) => item.id)).toEqual(beforeReload.shopping.items.map((item) => item.id));
  expect(afterReload.shopping.items.filter((item) => item.listId === 'shopping-list-legacy')).toHaveLength(2);
  expect(afterReload.shopping.purchases).toHaveLength(1);

  await page.getByRole('button', { name: 'Dinner', exact: true }).click();
  await expect(page.getByText('Purchased', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Start new purchase cycle' }).click();
  await expect(page.getByText('Purchased', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Check lemon')).toHaveAttribute('aria-checked', 'false');
});

test('shopping lists work locally without recipes or accounts and retain logical removals', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./shopping');
  await expect(page.getByText('Saved on this device only. Shopping lists are not synced.')).toBeVisible();
  await expect(page.getByLabel('New shopping list name')).toHaveCount(1);
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth
  }));
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
  const contrast = await page.evaluate(() => {
    const input = document.querySelector('[aria-label="New shopping list name"]');
    return {
      placeholder: getComputedStyle(input, '::placeholder').color,
      background: getComputedStyle(input).backgroundColor
    };
  });
  expect(contrastRatio(contrast.placeholder, contrast.background)).toBeGreaterThanOrEqual(4.5);
  await page.getByLabel('New shopping list name').focus();
  await expect.poll(async () => page.getByLabel('New shopping list name').evaluate((input) => getComputedStyle(input).borderTopWidth)).toBe('2px');
  await page.getByLabel('New shopping list name').fill('Quick shop');
  await page.getByRole('button', { name: 'Create shopping list' }).click();
  await expect(page.getByText('Quick shop', { exact: true })).toBeVisible();

  await page.getByLabel('Shopping item name').fill('beans');
  await page.getByLabel('Shopping quantity').fill('2');
  await page.getByLabel('Shopping unit').fill('cans');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('2 cans', { exact: true })).toBeVisible();
  await page.getByLabel('Edit beans').click();
  await page.getByLabel('Edit item name').fill('white beans');
  await page.getByLabel('Edit item quantity').fill('3');
  await page.getByLabel('Edit item unit').fill('cans');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('3 cans', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopWidth = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(desktopWidth.document).toBeLessThanOrEqual(desktopWidth.viewport);

  await page.getByRole('button', { name: 'Remove list' }).click();
  await page.getByRole('button', { name: 'Confirm remove list' }).click();
  await expect(page.getByText('Create a list', { exact: true })).toBeVisible();
  await expect.poll(async () => (await readPersistedState(page))?.shopping?.lists?.find((list) => list.name === 'Quick shop')?.removedAt ?? null).toBeTruthy();
  const removedState = await readPersistedState(page);
  const removedList = removedState.shopping.lists.find((list) => list.name === 'Quick shop');
  const removedItem = removedState.shopping.items.find((item) => item.name === 'white beans');
  expect(removedList.removedAt).toBeTruthy();
  expect(removedItem.removedAt).toBeTruthy();
  expect(removedItem.displayQuantity).toBe('3');
  expect(removedItem.displayUnit).toBe('cans');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Create a list', { exact: true })).toBeVisible();
  const restoredState = await readPersistedState(page);
  expect(restoredState.shopping.lists.find((list) => list.id === removedList.id)).toEqual(removedList);
  expect(restoredState.shopping.items.find((item) => item.id === removedItem.id)).toEqual(removedItem);
});
