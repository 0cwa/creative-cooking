import {expect, test, startLocalWorkspace} from './local-workspace-fixture.mjs';

const button = (page, name) => page.getByRole('button', {name, exact:true});

function recordExternalRequests(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const requests = [];
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) requests.push(request.url());
  });
  return requests;
}

test('Chef clearly saves private notes without promising or requesting an AI reply', async ({page, baseURL}) => {
  const externalRequests = recordExternalRequests(page, baseURL);
  await page.setViewportSize({width:390, height:844});
  await startLocalWorkspace(page, './chef');

  await expect(page.getByRole('heading', {name:'Private cooking notes', exact:true})).toBeVisible();
  await expect(page.getByText(/saving a note does not request an AI reply/)).toBeVisible();
  await expect(page.getByText(/Cloud Chef is currently unavailable in this workspace/)).toBeVisible();
  const save = button(page, 'Save private message');
  await expect(save).toHaveText('Save note');
  await expect(save).toBeDisabled();
  await expect(button(page, 'Send message')).toHaveCount(0);
  await expect(page.getByRole('button', {name:/Edit meal context/})).toHaveCount(0);
  await expect(button(page, 'Pantry only')).toHaveCount(0);
  await expect(button(page, 'Shopping allowed')).toHaveCount(0);
  await expect(button(page, 'Why is cloud Chef unavailable?')).toHaveAttribute('aria-expanded', 'false');

  await page.getByLabel('Message Chef').fill('Try lemon zest in the bean soup next time.');
  await save.click();
  await expect(page.getByLabel('Message Chef')).toHaveValue('');
  await expect(page.getByText('Try lemon zest in the bean soup next time.', {exact:true})).toBeVisible();
  await expect(page.getByText('Saved on this device', {exact:true})).toBeVisible();
  await expect(button(page, 'Stop Chef response')).toHaveCount(0);
  await expect(page.getByText('Chef is thinking…', {exact:true})).toHaveCount(0);

  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.getByText('Try lemon zest in the bean soup next time.', {exact:true})).toBeVisible();
  await expect(page.getByText('Saved on this device', {exact:true})).toBeVisible();
  await button(page, 'Browse recipe ideas').click();
  await expect(page).toHaveURL(/\/creative-cooking\/recipes$/);
  await expect(page.getByRole('heading', {name:'A little inspiration', exact:true})).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test('Local Chef settings opens the model setup without downloading or losing a draft', async ({page, baseURL}) => {
  const externalRequests = recordExternalRequests(page, baseURL);
  await page.setViewportSize({width:390, height:844});
  await startLocalWorkspace(page, './chef');
  await page.getByLabel('Message Chef').fill('An idea I have not saved yet.');

  await button(page, 'Local Chef settings').click();
  await expect(page).toHaveURL(/\/creative-cooking\/settings\?focus=local-chef$/);
  await expect(page.getByTestId('local-chef-settings').getByRole('heading', {name:'Local Chef', exact:true})).toBeInViewport();
  await expect(page.getByLabel('Use experimental local Chef')).toBeDisabled();
  await expect(page.getByText(/will not start a hidden download/i)).toBeVisible();
  await expect(page.getByTestId('local-chef-settings').getByRole('heading', {name:'Local Chef', exact:true})).toBeInViewport();
  await expect(page.getByLabel('Cancel local model download')).toHaveCount(0);

  await page.getByLabel('Back', {exact:true}).click();
  await expect(page.getByLabel('Message Chef')).toHaveValue('An idea I have not saved yet.');
  await expect(button(page, 'Save private message')).toBeEnabled();
  expect(externalRequests).toEqual([]);
});
