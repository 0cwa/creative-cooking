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
  await expect(page.getByText(/3\/4 lemon/)).toBeVisible();

  await page.getByLabel('Edit recipe Lentil bowl').click();
  await page.getByLabel('Recipe title').fill('Bright lentil bowl');
  await page.getByLabel('Save recipe changes').click();
  await expect(page.getByText('Bright lentil bowl', { exact: true })).toBeVisible();

  await page.getByLabel('lemon purchased').click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Add checked to Pantry' }).click();

  await page.getByLabel('Close recipe').click();
  await page.goto('./');
  await expect(page.getByText('lemon', { exact: true })).toBeVisible();

  await page.goto('./recipes');
  await expect(page.getByText('Bright lentil bowl', { exact: true })).toBeVisible();
  await page.getByLabel('Open recipe Bright lentil bowl').click();
  await expect(page.getByText('Shopping list', { exact: true })).toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Bright lentil bowl', { exact: true })).toBeVisible();
  await expect(page.getByLabel('3 portions')).toBeVisible();
});
