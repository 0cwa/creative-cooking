import { expect, test } from '@playwright/test';

test('saved recipe can be scaled, edited, shopped, added to Pantry, and persisted', async ({ page }) => {
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
        { name: 'lemon', amount: '1/2' }
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

  await page.getByLabel('Open recipe Lentil bowl').click();
  await expect(page.getByLabel('2 portions')).toBeVisible();
  await expect(page.getByText('Shopping list', { exact: true })).toBeVisible();
  await expect(page.getByLabel('lemon purchased')).toBeVisible();
  await expect(page.getByLabel('lentils purchased')).toHaveCount(0);

  await page.getByLabel('Increase portions').click();
  await expect(page.getByLabel('3 portions')).toBeVisible();
  await expect(page.getByText(/1 1\/2 cup lentils/)).toBeVisible();
  await expect(page.getByText(/3\/4 lemon/).first()).toBeVisible();

  await page.getByLabel('Edit recipe Lentil bowl').click();
  await expect(page.getByText('Edit it like a recipe', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Amount for ingredient 1')).toHaveCount(0);
  await expect(page.getByLabel('Recipe ingredients')).toHaveValue('1 1/2 cup lentils\n3/4 lemon');
  await page.getByLabel('Recipe title').fill('Bright lentil bowl');
  await page.getByLabel('Recipe ingredients').fill('1 1/2 cup lentils\n3/4 lemon\n1 tbsp olive oil');
  await page.getByLabel('Recipe method').fill('1. Warm the lentils.\n2. Finish with lemon.\n3. Drizzle with olive oil.');
  await page.getByLabel('Recipe notes').fill('Taste before salting.\nBest served warm.');
  await page.getByLabel('Save recipe changes').click();
  await expect(page.getByRole('dialog').getByText('Bright lentil bowl', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 tbsp olive oil/).first()).toBeVisible();
  await expect(page.getByText(/3\. Drizzle with olive oil\./)).toBeVisible();

  await page.getByLabel('lemon purchased').click();
  await page.getByLabel('olive oil purchased').click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Add checked to Pantry' }).click();

  await expect.poll(async () => page.evaluate(async () => {
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
    return raw;
  })).toContain('Bright lentil bowl');

  await expect.poll(async () => page.evaluate(async () => {
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
    const persisted = JSON.parse(raw);
    return persisted.recipes[0].ingredients.find((ingredient) => ingredient.name === 'olive oil')?.amount ?? null;
  })).toBe('1 tbsp');

  await page.getByLabel('Close recipe').click();
  await page.goto('./');
  await expect(page.getByText('lemon', { exact: true })).toBeVisible();
  await expect(page.getByText('olive oil', { exact: true })).toBeVisible();

  await page.goto('./recipes');
  await expect(page.getByText('Bright lentil bowl', { exact: true })).toBeVisible();
  await page.getByLabel('Open recipe Bright lentil bowl').click();
  await expect(page.getByText('Shopping list', { exact: true })).toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Bright lentil bowl', { exact: true })).toBeVisible();
  await page.getByLabel('Open recipe Bright lentil bowl').click();
  await expect(page.getByLabel('3 portions')).toBeVisible();
});
