import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

async function offerInstall(page, outcome = 'accepted') {
  await page.evaluate((choice) => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperties(event, {
      prompt: {
        value: async () => {
          window.__creativeCookingInstallPromptCalled = true;
        }
      },
      userChoice: {
        value: Promise.resolve({ outcome: choice, platform: 'web' })
      }
    });
    window.dispatchEvent(event);
  }, outcome);
}

test('offers installation only after engagement and captures the CTA screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.getByText('Pantry', { exact: true }).first()).toBeVisible();

  await offerInstall(page);
  await expect(page.getByText('Install Creative Cooking', { exact: true })).toHaveCount(0);

  const ingredient = page.getByLabel('Ingredient name');
  await ingredient.fill('fresh tomatoes');
  await ingredient.press('Enter');

  await expect(page.getByText('Install Creative Cooking', { exact: true })).toBeVisible();
  await expect(page.getByText('Your pantry and saved recipes stay available offline.', { exact: false })).toBeVisible();

  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/pwa-install-tip.png', fullPage: true });

  await page.getByRole('button', { name: 'Install Creative Cooking' }).click();
  await expect.poll(() => page.evaluate(() => window.__creativeCookingInstallPromptCalled === true)).toBe(true);
});

test('remembers when the user dismisses the install tip', async ({ page }) => {
  await page.goto('./');
  await offerInstall(page);

  const ingredient = page.getByLabel('Ingredient name');
  await ingredient.fill('lemons');
  await ingredient.press('Enter');
  await expect(page.getByText('Install Creative Cooking', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss install tip' }).click();
  await expect(page.getByText('Install Creative Cooking', { exact: true })).toHaveCount(0);

  await page.reload();
  await offerInstall(page);
  await expect(page.getByText('Install Creative Cooking', { exact: true })).toHaveCount(0);
});
