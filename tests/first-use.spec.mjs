import {expect, test, startLocalWorkspace} from './local-workspace-fixture.mjs';

const button = (page, name) => page.getByRole('button', {name, exact:true});
const choiceKey = 'creative-cooking-storage-choice-v1';
const workspaceKey = 'creative-cooking-local-workspace-v1';

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

async function acceptedPolicies(page) {
  return page.evaluate(async () => {
    const name = localStorage.getItem('creative-cooking-local-workspace-v1');
    const read = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await read(indexedDB.open(`${name}-records`));
    try {
      const records = db.transaction('records').objectStore('records');
      const keys = await read(records.getAllKeys());
      return await Promise.all(keys.filter(key => String(key).startsWith('["disclosure-policy",'))
        .map(key => read(records.get(key))));
    } finally {
      db.close();
    }
  });
}

async function openPrivacyStep(page) {
  await page.goto('./');
  await button(page, 'Set up my kitchen').click();
  await expect(page.getByTestId('privacy-summary')).toBeVisible();
  await expect(button(page, 'Accept settings and open my kitchen')).toBeEnabled();
}

test('welcome puts the start button on screen and keeps technical setup optional', async ({page}, testInfo) => {
  await page.setViewportSize({width:320, height:740});
  await page.goto('./');

  await expect(page.getByRole('heading', {name:'Welcome to Creative Cooking', exact:true})).toBeVisible();
  await expect(button(page, 'Set up my kitchen')).toBeEnabled();
  await expect(button(page, 'Set up my kitchen')).toBeInViewport({ratio:1});
  await expect(button(page, 'More setup options')).toHaveAttribute('aria-expanded', 'false');
  await expect(button(page, 'Household options')).toHaveCount(0);
  await expect(button(page, 'Recover an existing kitchen')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('radio', {name:/Every adult/})).toHaveCount(0);
  await expect(page.getByLabel('Recovery code', {exact:true})).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await testInfo.attach('Welcome on a small phone', {
    body: await page.screenshot({type:'png', fullPage:false}),
    contentType:'image/png'
  });

  await button(page, 'More setup options').click();
  await button(page, 'Household options').click();
  await expect(button(page, 'Household options')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('radio', {name:/Every adult/})).toBeVisible();
  await button(page, 'Household options').click();
  await expect(page.getByRole('radio', {name:/Every adult/})).toBeHidden();

  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toBeVisible();
  await page.getByLabel('Recovery code', {exact:true}).fill('unfinished-recovery-code');
  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toBeHidden();
  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toHaveValue('unfinished-recovery-code');
  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toBeHidden();
  expect(await page.evaluate(key => localStorage.getItem(key), choiceKey)).toBeNull();
  await expect(button(page, 'Set up my kitchen')).toBeEnabled();
});

test('privacy prepares automatically but is signed only after explicit acceptance, including after reload', async ({page, baseURL}, testInfo) => {
  const externalRequests = recordExternalRequests(page, baseURL);
  await page.setViewportSize({width:390, height:844});
  await openPrivacyStep(page);

  await expect(button(page, 'Review privacy settings')).toHaveCount(0);
  await expect(page.getByTestId('pantry-screen')).toHaveCount(0);
  await expect(button(page, 'Advanced privacy options')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Optional permitted recipient endpoint')).toHaveCount(0);
  expect(await acceptedPolicies(page)).toEqual([]);
  const reserved = await page.evaluate(key => localStorage.getItem(key), workspaceKey);
  await expectNoHorizontalOverflow(page);
  await testInfo.attach('Privacy review on a phone', {
    body: await page.screenshot({type:'png', fullPage:false}),
    contentType:'image/png'
  });

  await page.reload();
  await expect(page.getByTestId('privacy-summary')).toBeVisible();
  await expect(button(page, 'Accept settings and open my kitchen')).toBeEnabled();
  await expect(button(page, 'Set up my kitchen')).toHaveCount(0);
  await expect(button(page, 'Review privacy settings')).toHaveCount(0);
  expect(await acceptedPolicies(page)).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(reserved);

  await button(page, 'Advanced privacy options').click();
  await expect(page.getByLabel('Optional permitted recipient endpoint')).toBeVisible();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await button(page, 'Advanced privacy options').click();
  await expect(button(page, 'Show policy details')).toBeVisible();
  await expect(page.getByText(/"version":\s*2/)).toHaveCount(0);
  await expect(page.getByTestId('pantry-screen')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await button(page, 'Accept settings and open my kitchen').click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(page.getByLabel('Ingredient and details')).toBeEditable();
  await testInfo.attach('Pantry ready to use', {
    body: await page.screenshot({type:'png', fullPage:false}),
    contentType:'image/png'
  });
  const records = await acceptedPolicies(page);
  expect(records).toHaveLength(1);
  expect(records[0].policy.version).toBe(2);
  expect(records[0].approvals).toHaveLength(1);
  expect(records[0].approvals[0].signature).toMatch(/^[0-9a-f]{128}$/);
  expect(externalRequests).toEqual([]);
});


test('back to welcome resumes the same kitchen and still requires privacy acceptance', async ({page}) => {
  await openPrivacyStep(page);
  const namespace = await page.evaluate(key => localStorage.getItem(key), workspaceKey);
  await button(page, 'Back to welcome').click();
  await expect(page.getByRole('heading', {name:'Welcome to Creative Cooking', exact:true})).toBeVisible();
  await expect(button(page, 'Household options')).toHaveCount(0);
  expect(await acceptedPolicies(page)).toEqual([]);
  await button(page, 'Set up my kitchen').click();
  await expect(page.getByTestId('privacy-summary')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
  expect(await acceptedPolicies(page)).toEqual([]);
  await button(page, 'Accept settings and open my kitchen').click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  expect(await acceptedPolicies(page)).toHaveLength(1);
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
});

test('privacy edits refresh the displayed policy and cannot accept an invalid recipient', async ({page}) => {
  await openPrivacyStep(page);
  await button(page, 'Advanced privacy options').click();
  const endpoint = page.getByLabel('Optional permitted recipient endpoint');
  await endpoint.fill('not a recipient URL');
  await expect(page.getByRole('alert')).toContainText('complete http:// or https://');
  await expect(button(page, 'Accept settings and open my kitchen')).toHaveCount(0);
  expect(await acceptedPolicies(page)).toEqual([]);

  await endpoint.fill('');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('privacy-summary')).toContainText('blocked');
  await expect(button(page, 'Accept settings and open my kitchen')).toBeEnabled();
  await button(page, 'Accept settings and open my kitchen').click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  const [record] = await acceptedPolicies(page);
  expect(record.policy.access.flatMap(access => access.destinations)).not.toContain('external');
  expect(record.policy.rules[0].enforcement).toBe('block');
});

test('opening kitchen content never presents a new cook as a read-only viewer', async ({page}) => {
  await openPrivacyStep(page);
  await page.evaluate(() => {
    const request = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, ...args) => {
      if (String(name).startsWith('creative-cooking/bootstrap/v1/') && args[0]?.mode === 'shared') {
        navigator.locks.request = request;
        return new Promise((resolve, reject) => {
          window.__releaseFirstCookingRead = () => request(name, ...args).then(resolve, reject);
        });
      }
      return request(name, ...args);
    };
  });
  await button(page, 'Accept settings and open my kitchen').click();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseFirstCookingRead)).toBe('function');
  await expect(page.getByRole('heading', {name:'Opening your kitchen…', exact:true})).toBeVisible();
  await expect(page.getByTestId('pantry-screen')).toHaveCount(0);
  await expect(page.getByText(/read-only for viewers/)).toHaveCount(0);
  await expect(button(page, 'Open settings')).toHaveCount(0);

  await page.evaluate(() => window.__releaseFirstCookingRead());
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(page.getByLabel('Ingredient and details')).toBeEditable();
});

test('an initial content read failure can retry in place without replacing the kitchen', async ({page}) => {
  await openPrivacyStep(page);
  const namespace = await page.evaluate(key => localStorage.getItem(key), workspaceKey);
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (typeof key === 'string' && key.startsWith('["document",')) {
        IDBObjectStore.prototype.get = get;
        window.__firstCookingReadFailed = true;
        throw new DOMException('Synthetic first cooking read failure.', 'UnknownError');
      }
      return get.call(this, key);
    };
  });
  await button(page, 'Accept settings and open my kitchen').click();
  await expect(page.getByRole('heading', {name:'Your kitchen could not finish opening', exact:true})).toBeVisible();
  expect(await page.evaluate(() => window.__firstCookingReadFailed)).toBe(true);
  await expect(page.getByTestId('pantry-screen')).toHaveCount(0);
  await expect(page.getByText(/read-only for viewers/)).toHaveCount(0);
  await expect(button(page, 'Try again')).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
  expect(await acceptedPolicies(page)).toHaveLength(1);

  await button(page, 'Try again').click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(page.getByLabel('Ingredient and details')).toBeEditable();
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
  expect(await acceptedPolicies(page)).toHaveLength(1);
  await page.getByLabel('Ingredient and details').fill('Recovered kitchen carrots');
  await page.getByLabel('Add ingredient', {exact:true}).click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByText('Recovered kitchen carrots', {exact:true})).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
});

test('a first pantry ingredient stays saved when a new cook returns without an account or provider', async ({page, baseURL}) => {
  const externalRequests = recordExternalRequests(page, baseURL);
  await page.setViewportSize({width:390, height:844});
  await startLocalWorkspace(page);

  await button(page, 'Use example rice').click();
  await expect(page.getByLabel('Ingredient and details')).toHaveValue('rice');
  await expect(page.getByTestId(/^pantry-item-/)).toHaveCount(0);
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

test('a second setup tab can reopen a kitchen whose privacy was already accepted elsewhere', async ({page, context}) => {
  await openPrivacyStep(page);
  const namespace = await page.evaluate(key => localStorage.getItem(key), workspaceKey);
  const other = await context.newPage();
  try {
    await other.goto(page.url());
    await expect(other.getByTestId('privacy-summary')).toBeVisible();
    await button(other, 'Advanced privacy options').click();
    await other.getByRole('checkbox').check();
    await expect(other.getByTestId('privacy-summary')).toContainText('blocked');
    await expect(button(other, 'Accept settings and open my kitchen')).toBeEnabled();

    await button(page, 'Accept settings and open my kitchen').click();
    await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    await button(other, 'Accept settings and open my kitchen').click();
    await expect(button(other, 'Open kitchen again')).toBeVisible();
    const beforeReopen = await acceptedPolicies(other);
    expect(beforeReopen).toHaveLength(1);
    expect(beforeReopen[0].policy.rules[0].enforcement).toBe('preference');

    await button(other, 'Open kitchen again').click();
    await expect(other.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    await expect(other.getByLabel('Ingredient and details')).toBeEditable();
    expect(await other.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
    expect(await acceptedPolicies(other)).toEqual(beforeReopen);
  } finally {
    await other.close();
  }
});

test('a browser missing workspace locks receives useful guidance without creating a kitchen', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', {configurable:true, value:undefined});
  });
  await page.goto('./');
  await button(page, 'Set up my kitchen').click();
  await expect(page.getByRole('alert')).toContainText('browser is missing a feature');
  await expect(page.getByRole('alert')).toContainText('updated browser');
  await expect(button(page, 'Set up my kitchen')).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), choiceKey)).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBeNull();
});

test('blocked site storage explains the problem and can retry without resetting data', async ({page}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (this === localStorage && key === 'creative-cooking-storage-choice-v1' &&
        !get.call(sessionStorage, 'test-kitchen-storage-allowed')) {
        throw new DOMException('Site storage access denied.', 'SecurityError');
      }
      return get.call(this, key);
    };
  });
  await page.goto('./');
  await expect(page.getByRole('heading', {name:'Could not open your kitchen', exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('browser is blocking the storage');
  await expect(page.getByRole('alert')).toContainText('Allow site storage');
  await expect(button(page, 'Try again')).toBeEnabled();
  await page.evaluate(() => {
    localStorage.setItem('creative-cooking-state-v1', 'archived kitchen marker');
    sessionStorage.setItem('test-kitchen-storage-allowed', '1');
  });
  await button(page, 'Try again').click();
  await expect(page.getByRole('heading', {name:'Welcome to Creative Cooking', exact:true})).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('creative-cooking-state-v1'))).toBe('archived kitchen marker');
  expect(await page.evaluate(key => localStorage.getItem(key), choiceKey)).toBeNull();
});
