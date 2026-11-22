import {openSavedCloudConnections, openHouseholdTools} from './settings-navigation.mjs';
import { expect, test, startLocalWorkspace } from './local-workspace-fixture.mjs';

test('provider and model selection persist and defaults follow the selected provider', async ({ page }) => {
  await startLocalWorkspace(page,'./settings');

  await expect(page.getByText('Settings', { exact: true })).toBeVisible();
  await openSavedCloudConnections(page);
  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');

  await page.getByLabel('Use OpenAI provider').click();
  await expect(page.getByLabel('OpenAI model')).toHaveValue('gpt-5.6-terra');
  await expect(page.getByText('OpenAI connection', { exact: true })).toBeVisible();

  await expect(page.getByTestId('settings-local-persistence-status')).toHaveText('Saved locally');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openSavedCloudConnections(page);
  await expect(page.getByLabel('OpenAI model')).toHaveValue('gpt-5.6-terra');

  await page.getByLabel('Use OpenRouter provider').click();
  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');
  await expect(page.getByText('OpenRouter connection', { exact: true })).toBeVisible();
});


test('OpenRouter friend links activate saved connections that can still be managed', async ({ page, baseURL }) => {
  const external = [];
  page.on('request', request => {
    if (new URL(request.url()).origin !== new URL(baseURL).origin) external.push(request.url());
  });
  await startLocalWorkspace(page,'./settings');
  await openSavedCloudConnections(page);
  await page.getByLabel('Use Anthropic provider').click();
  await expect(page.getByTestId('settings-local-persistence-status')).toHaveText('Saved locally');
  page.on('dialog', (dialog) => void dialog.accept());
  const compactPayload = `x${'A'.repeat(43)}`;
  await page.goto(`./settings?ort=${compactPayload}`);
  await openSavedCloudConnections(page);

  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');
  await expect(page.getByText('OpenRouter connection', { exact: true })).toBeVisible();
  await expect(page.getByText('Key saved', { exact: true })).toBeVisible();
  expect(page.url()).not.toContain('ort=');

  await expect.poll(async () => page.evaluate(() => (
    window.localStorage.getItem('creative-cooking-openrouter-key') ?? ''
  ))).toMatch(/^sk-or-v1-/);
  await page.getByRole('button', {name:/Create friend link/}).click();
  await expect(page.getByLabel('Friend link', {exact:true})).toHaveValue(/\?ort=/);
  await page.getByRole('button', {name:'Disconnect OpenRouter', exact:true}).click();
  await expect(page.getByText('No key saved', {exact:true})).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('creative-cooking-openrouter-key'))).toBeNull();
  expect(external).toEqual([]);
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

  await expect(page.getByText('Browser compatibility', { exact: true })).toBeVisible();
  await expect(page.getByText('Available', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Model cache', { exact: true }).locator('..').getByText('Not downloaded', { exact: true })
  ).toBeVisible();

  const download = page.getByLabel('Download local model');
  await expect(download).toBeEnabled();
  await expect(page.getByLabel('Use experimental local Chef')).toBeDisabled();

  await expect(page.getByText(/will not start a hidden download/i)).toBeVisible();
});


test('everyday settings stay accessible while household tools and unavailable cloud setup are optional', async ({page}) => {
  await startLocalWorkspace(page, './settings');
  const household = page.getByRole('button', {name:'Household and advanced tools', exact:true});
  const cloud = page.getByRole('button', {name:'Saved cloud connections', exact:true});
  await expect(household).toHaveAttribute('aria-expanded', 'false');
  await expect(cloud).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('City')).toBeEditable();
  await expect(page.getByLabel('Download local model')).toBeVisible();
  await expect(page.getByRole('button', {name:'Set up personal recovery', exact:true})).toBeVisible();
  await expect(page.getByRole('button', {name:'Show device identity', exact:true})).toHaveCount(0);
  await expect(page.getByRole('button', {name:'Connect OpenRouter', exact:true})).toHaveCount(0);

  await openHouseholdTools(page);
  await page.getByRole('button', {name:'Show device identity', exact:true}).click();
  const authority = page.getByLabel('Household authority bundle', {exact:true});
  await authority.fill('unfinished household authority draft');
  await household.click();
  await expect(authority).toBeHidden();
  await household.click();
  await expect(authority).toHaveValue('unfinished household authority draft');

  await openSavedCloudConnections(page);
  await expect(page.getByLabel('OpenRouter model')).toHaveValue('openrouter/free');
  await expect(page.getByRole('button', {name:'Connect OpenRouter', exact:true})).toHaveCount(0);
  await expect(page.getByLabel('OpenRouter API key', {exact:true})).toHaveCount(0);
});
