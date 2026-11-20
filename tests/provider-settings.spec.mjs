import { expect, test, startLocalWorkspace } from './local-workspace-fixture.mjs';

test('provider and model selection persist and defaults follow the selected provider', async ({ page }) => {
  await startLocalWorkspace(page,'./settings');

  await expect(page.getByText('Settings', { exact: true })).toBeVisible();
  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');

  await page.getByLabel('Use OpenAI provider').click();
  await expect(page.getByLabel('OpenAI model')).toHaveValue('gpt-5.6-terra');
  await expect(page.getByText('OpenAI connection', { exact: true })).toBeVisible();

  await expect(page.getByTestId('settings-local-persistence-status')).toHaveText('Saved locally');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('OpenAI model')).toHaveValue('gpt-5.6-terra');

  await page.getByLabel('Use OpenRouter provider').click();
  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');
  await expect(page.getByText('OpenRouter connection', { exact: true })).toBeVisible();
});


test('OpenRouter friend links activate OpenRouter after persisted provider settings hydrate', async ({ page }) => {
  await startLocalWorkspace(page,'./settings');
  await page.getByLabel('Use Anthropic provider').click();
  await expect(page.getByTestId('settings-local-persistence-status')).toHaveText('Saved locally');
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


test('local Chef requires an explicit cached model before it can be selected', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ({}) }
    });
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage: 0, quota: 3 * 1024 * 1024 * 1024 }),
        persisted: async () => true
      }
    });
  });

  await startLocalWorkspace(page,'./settings');

  await expect(page.getByText('WebGPU', { exact: true })).toBeVisible();
  await expect(page.getByText('Available', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Model cache', { exact: true }).locator('..').getByText('Not downloaded', { exact: true })
  ).toBeVisible();

  const download = page.getByLabel('Download local model');
  await expect(download).toBeEnabled();
  await expect(page.getByLabel('Use experimental local Chef')).toBeDisabled();

  await expect(page.getByText(/will not start a hidden download/i)).toBeVisible();
});
