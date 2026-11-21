import {expect, test, startLocalWorkspace} from './local-workspace-fixture.mjs';

const button = (page, name) => page.getByRole('button', {name, exact:true});

async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
}

function recordExternalRequests(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const requests = [];
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) requests.push(request.url());
  });
  return requests;
}

test('welcome gives new cooks a clear start and keeps household and recovery options optional', async ({page}) => {
  await page.setViewportSize({width:320, height:740});
  await page.goto('./');

  await expect(page.getByRole('heading', {name:'Welcome to Creative Cooking', exact:true})).toBeVisible();
  await expect(button(page, 'Set up my kitchen')).toBeEnabled();
  await expect(button(page, 'Household options')).toHaveAttribute('aria-expanded', 'false');
  await expect(button(page, 'Recover an existing kitchen')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('radio', {name:/Every adult/})).toHaveCount(0);
  await expect(page.getByLabel('Recovery code', {exact:true})).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await button(page, 'Household options').click();
  await expect(button(page, 'Household options')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('radio', {name:/Every adult/})).toBeVisible();
  await button(page, 'Household options').click();
  await expect(page.getByRole('radio', {name:/Every adult/})).toHaveCount(0);

  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toBeVisible();
  await page.getByLabel('Recovery code', {exact:true}).fill('unfinished-recovery-code');
  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toBeHidden();
  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toHaveValue('unfinished-recovery-code');
  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('creative-cooking-storage-choice-v1'))).toBeNull();
  await expect(button(page, 'Set up my kitchen')).toBeEnabled();
});

test('starting a kitchen requires an explicit privacy review and acceptance, including after a reload', async ({page, baseURL}) => {
  const externalRequests = recordExternalRequests(page, baseURL);
  await page.setViewportSize({width:390, height:844});
  await page.goto('./');
  await button(page, 'Set up my kitchen').click();

  await expect(page.getByRole('heading', {name:'Your kitchen, your privacy', exact:true})).toBeVisible();
  await expect(button(page, 'Review privacy settings')).toBeVisible();
  await expect(button(page, 'Accept settings and open my kitchen')).toHaveCount(0);
  await expect(page.getByTestId('pantry-screen')).toHaveCount(0);
  await expect(button(page, 'Advanced privacy options')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Optional permitted recipient endpoint')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await page.reload();
  await expect(button(page, 'Review privacy settings')).toBeVisible();
  await expect(button(page, 'Set up my kitchen')).toHaveCount(0);
  await expect(button(page, 'Accept settings and open my kitchen')).toHaveCount(0);

  await button(page, 'Advanced privacy options').click();
  await expect(page.getByLabel('Optional permitted recipient endpoint')).toBeVisible();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await button(page, 'Advanced privacy options').click();
  await button(page, 'Review privacy settings').click();
  await expect(button(page, 'Accept settings and open my kitchen')).toBeEnabled();
  await expect(page.getByTestId('privacy-summary')).toBeVisible();
  await expect(button(page, 'Show policy details')).toBeVisible();
  await expect(page.getByText(/"version":\s*2/)).toHaveCount(0);
  await expect(page.getByTestId('pantry-screen')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await button(page, 'Accept settings and open my kitchen').click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(page.getByLabel('Ingredient and details')).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test('a first pantry ingredient stays saved when a new cook returns without an account or provider', async ({page, baseURL}) => {
  const externalRequests = recordExternalRequests(page, baseURL);
  await page.setViewportSize({width:390, height:844});
  await startLocalWorkspace(page);

  await page.getByLabel('Ingredient and details').fill('First kitchen carrots');
  await page.getByLabel('Add ingredient', {exact:true}).click();
  await expect(page.getByText('First kitchen carrots', {exact:true})).toBeVisible();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expectNoHorizontalOverflow(page);

  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.getByText('First kitchen carrots', {exact:true})).toBeVisible();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(button(page, 'Set up my kitchen')).toHaveCount(0);
  await expect(button(page, 'Review privacy settings')).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
