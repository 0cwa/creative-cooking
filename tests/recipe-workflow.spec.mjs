import { expect, test, startLocalWorkspace } from './local-workspace-fixture.mjs';

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

test('shopping lists work locally without recipes or accounts and retain logical removals', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startLocalWorkspace(page,'./shopping');
  await expect(page.getByText('Saved on this device only.', { exact: true })).toBeVisible();
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
  await expect(page.getByText('Saved on this device only.', { exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Create a list', { exact:true })).toBeVisible();
  await expect(page.getByText('white beans', { exact:true })).toHaveCount(0);
});
