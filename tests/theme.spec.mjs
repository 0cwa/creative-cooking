import {expect,test,startLocalWorkspace} from './local-workspace-fixture.mjs';

async function expectReadableText(locator) {
  await expect(locator).toBeVisible();
  const contrast = await locator.evaluate(element => {
    const rgba = value => {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3) throw new Error(`Unsupported computed color: ${value}`);
      return [...channels.slice(0, 3), channels[3] ?? 1];
    };
    const over = (foreground, background) => foreground.slice(0, 3).map((channel, index) =>
      channel * foreground[3] + background[index] * (1 - foreground[3])
    ).concat(1);
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) ancestors.push(node);
    // Resolve transparent containers against the surfaces actually behind the text.
    const background = ancestors.reverse().reduce((surface, node) =>
      over(rgba(getComputedStyle(node).backgroundColor), surface), [255, 255, 255, 1]);
    const foreground = over(rgba(getComputedStyle(element).color), background);
    const luminance = color => color.slice(0, 3).map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    return {ratio: (light + 0.05) / (dark + 0.05), foreground, background};
  });
  expect(contrast.ratio, `Text contrast against its rendered surface: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
}

test('dark cooking screens keep pantry, recipe ideas and private notes readable', async ({page}) => {
  await page.emulateMedia({colorScheme:'dark'});
  await startLocalWorkspace(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await expectReadableText(page.getByText('Pantry', {exact:true}).first());
  await expectReadableText(page.getByText('What’s in the kitchen?', {exact:true}));
  const ingredient = page.getByLabel('Ingredient and details');
  await ingredient.fill('Contrast carrots');
  await expectReadableText(ingredient);
  await expectReadableText(page.getByLabel('Add ingredient', {exact:true}).getByText('Add', {exact:true}));
  await page.getByLabel('Add ingredient', {exact:true}).click();
  await expectReadableText(page.getByText('Contrast carrots', {exact:true}));
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');

  await page.getByRole('button', {name:'Browse recipe ideas', exact:true}).click();
  await expectReadableText(page.getByRole('heading', {name:'A little inspiration', exact:true}));
  await expectReadableText(page.getByText('Lemony chickpea toast', {exact:true}));
  await expectReadableText(page.getByText('Chickpeas · bread · lemon', {exact:true}));

  await page.goto('./chef');
  await expectReadableText(page.getByRole('heading', {name:'Private cooking notes', exact:true}));
  await expectReadableText(page.getByText(/saving a note does not request an AI reply/));
  await page.getByLabel('Private cooking note').fill('Remember lemon zest next time.');
  const save = page.getByRole('button', {name:'Save note', exact:true});
  await expectReadableText(save.getByText('Save note', {exact:true}));
  await save.click();
  await expectReadableText(page.getByText('Remember lemon zest next time.', {exact:true}));
});

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
