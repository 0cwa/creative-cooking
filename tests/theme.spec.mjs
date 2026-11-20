import {expect,test,startLocalWorkspace} from './local-workspace-fixture.mjs';

test('system, light, and dark appearance modes update the whole app and persist', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await startLocalWorkspace(page);

  await expect(page.getByText('Pantry', { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByTestId('pantry-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');

  await page.getByLabel('Open settings').click();
  await expect(page.getByText('Appearance', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Follow system theme')).toHaveAttribute('aria-checked', 'true');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(248, 250, 252)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');

  await page.getByLabel('Use light theme').click();
  await expect(page.getByLabel('Use light theme')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(248, 250, 252)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

  await page.getByLabel('Use dark theme').click();
  await expect(page.getByLabel('Use dark theme')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');
  await expect(page.getByTestId('settings-local-persistence-status')).toHaveText('Saved locally');

  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.getByText('Settings', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Use dark theme')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');
  await page.goto('./shopping');
  await expect(page.getByRole('heading',{name:'Shopping list'})).toBeVisible();
  await expect(page.getByTestId('app-screen')).toHaveCSS('background-color', 'rgb(11, 18, 32)');
});
