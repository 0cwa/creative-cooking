import { expect, test } from '@playwright/test';

test('provider and model selection persist and defaults follow the selected provider', async ({ page }) => {
  await page.goto('./settings');

  await expect(page.getByText('Settings', { exact: true })).toBeVisible();
  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');

  await page.getByLabel('Use OpenAI provider').click();
  await expect(page.getByLabel('OpenAI model')).toHaveValue('gpt-5.6-terra');
  await expect(page.getByText('OpenAI connection', { exact: true })).toBeVisible();

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
  })).toContain('"providerId":"openai"');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('OpenAI model')).toHaveValue('gpt-5.6-terra');

  await page.getByLabel('Use OpenRouter provider').click();
  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');
  await expect(page.getByText('OpenRouter connection', { exact: true })).toBeVisible();
});


test('OpenRouter friend links activate OpenRouter after persisted provider settings hydrate', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify({
      settings: {
        providerId: 'anthropic',
        model: 'claude-sonnet-5'
      }
    }));
  });

  page.on('dialog', (dialog) => void dialog.accept());
  const compactPayload = `x${'A'.repeat(43)}`;
  await page.goto(`./settings?ort=${compactPayload}`);

  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');
  await expect(page.getByText('OpenRouter connection', { exact: true })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  expect(page.url()).not.toContain('ort=');

  await expect.poll(async () => page.evaluate(() => (
    window.localStorage.getItem('creative-cooking-openrouter-key') ?? ''
  ))).toMatch(/^sk-or-v1-/);
});
