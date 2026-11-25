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

// A kitchen whose creation finished but whose privacy policy was never accepted,
// as after a reload between creating the kitchen and finishing setup.
async function openUnacceptedKitchen(page) {
  await page.goto('./');
  await page.evaluate(key => localStorage.setItem(key, 'pending:' + JSON.stringify({
    version:1, name:`cooking-${crypto.randomUUID()}`, policy:{kind:'allMinusOne', fixedCount:null}
  })), choiceKey);
  await page.reload();
  await expect(page.getByTestId('privacy-summary')).toContainText('Your kitchen is already here');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), choiceKey)).toMatch(/^local:/);
  await expect(button(page, 'Start cooking')).toBeEnabled();
}

test('welcome is one screen with the start button on screen and recovery optional', async ({page}, testInfo) => {
  await page.setViewportSize({width:320, height:740});
  await page.goto('./');

  await expect(page.getByRole('heading', {name:'Welcome to Creative Cooking', exact:true})).toBeVisible();
  await expect(button(page, 'Start cooking')).toBeEnabled();
  await expect(button(page, 'Start cooking')).toBeInViewport({ratio:1});
  await expect(page.getByTestId('privacy-summary')).toContainText('Everything stays on this device');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(button(page, 'Recover an existing kitchen')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Recovery code', {exact:true})).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await testInfo.attach('Welcome on a small phone', {
    body: await page.screenshot({type:'png', fullPage:false}),
    contentType:'image/png'
  });

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
  await expect(button(page, 'Start cooking')).toBeEnabled();
});

test('one Start tap creates the kitchen and signs the on-device policy without network requests', async ({page, baseURL}, testInfo) => {
  const externalRequests = recordExternalRequests(page, baseURL);
  await page.setViewportSize({width:390, height:844});
  await page.goto('./');
  await button(page, 'Start cooking').click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(page.getByLabel('Ingredient and details')).toBeEditable();
  await testInfo.attach('Pantry ready to use', {
    body: await page.screenshot({type:'png', fullPage:false}),
    contentType:'image/png'
  });
  const records = await acceptedPolicies(page);
  expect(records).toHaveLength(1);
  expect(records[0].policy.version).toBe(2);
  expect(records[0].policy.access.flatMap(access => access.destinations)).not.toContain('external');
  expect(records[0].policy.rules[0].enforcement).toBe('preference');
  expect(records[0].approvals).toHaveLength(1);
  expect(records[0].approvals[0].signature).toMatch(/^[0-9a-f]{128}$/);
  expect(externalRequests).toEqual([]);
});

test('an unfinished kitchen is not signed until Start is pressed, including after reload', async ({page}) => {
  await openUnacceptedKitchen(page);
  const namespace = await page.evaluate(key => localStorage.getItem(key), workspaceKey);
  expect(await acceptedPolicies(page)).toEqual([]);
  await page.reload();
  await expect(button(page, 'Start cooking')).toBeEnabled();
  await expect(page.getByTestId('pantry-screen')).toHaveCount(0);
  expect(await acceptedPolicies(page)).toEqual([]);

  await button(page, 'Start cooking').click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  expect(await acceptedPolicies(page)).toHaveLength(1);
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
});

test('opening kitchen content never presents a new cook as a read-only viewer', async ({page}) => {
  await openUnacceptedKitchen(page);
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
  await button(page, 'Start cooking').click();
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
  await openUnacceptedKitchen(page);
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
  await button(page, 'Start cooking').click();
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

test('persistent content read failures keep personal recovery available without replacing the kitchen', async ({page}, testInfo) => {
  await page.setViewportSize({width:390, height:844});
  await openUnacceptedKitchen(page);
  const namespace = await page.evaluate(key => localStorage.getItem(key), workspaceKey);
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.get;
    window.__failedCookingReads = 0;
    IDBObjectStore.prototype.get = function (key) {
      if (typeof key === 'string' && key.startsWith('["document",')) {
        window.__failedCookingReads++;
        throw new DOMException('Synthetic persistent cooking read failure.', 'UnknownError');
      }
      return get.call(this, key);
    };
  });
  await button(page, 'Start cooking').click();
  await expect(page.getByRole('heading', {name:'Your kitchen could not finish opening', exact:true})).toBeVisible();
  const policies = await acceptedPolicies(page);
  expect(policies).toHaveLength(1);
  await expect(button(page, 'Recover an existing kitchen')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Recovery code', {exact:true})).toHaveCount(0);

  for (let attempts = 2; attempts <= 3; attempts++) {
    await button(page, 'Try again').click();
    await expect.poll(() => page.evaluate(() => window.__failedCookingReads)).toBe(attempts);
    await expect(page.getByRole('heading', {name:'Your kitchen could not finish opening', exact:true})).toBeVisible();
  }
  await expect(page.getByTestId('pantry-screen')).toHaveCount(0);
  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toBeVisible();
  await expect(button(page, 'Restore personal archive')).toBeVisible();
  await page.getByLabel('Recovery code', {exact:true}).fill('unfinished-recovery-code');
  await button(page, 'Recover an existing kitchen').click();
  await button(page, 'Recover an existing kitchen').click();
  await expect(page.getByLabel('Recovery code', {exact:true})).toHaveValue('unfinished-recovery-code');
  await expectNoHorizontalOverflow(page);
  await testInfo.attach('Recovery after a persistent opening failure', {
    body: await page.screenshot({type:'png', fullPage:true}),
    contentType:'image/png'
  });
  expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
  expect(await page.evaluate(key => localStorage.getItem(key), choiceKey)).toBe(`local:${namespace}`);
  expect(await acceptedPolicies(page)).toEqual(policies);
});

test('a stale content runtime can reopen current saved content after in-place retries fail', async ({page, context}) => {
  await openUnacceptedKitchen(page);
  const namespace = await page.evaluate(key => localStorage.getItem(key), workspaceKey);
  // A workspace keeps the selection it opened with. Reproduce its persistent
  // stale-selection error at the shared read boundary until the page reopens.
  await page.evaluate(() => {
    const request = navigator.locks.request.bind(navigator.locks);
    window.__staleCookingReads = 0;
    navigator.locks.request = (name, ...args) => {
      if (String(name).startsWith('creative-cooking/bootstrap/v1/') && args[0]?.mode === 'shared') {
        window.__staleCookingReads++;
        return Promise.reject(new Error('HOUSEHOLD_SELECTION_CHANGED'));
      }
      return request(name, ...args);
    };
  });
  await button(page, 'Start cooking').click();
  await expect(page.getByRole('alert')).toContainText('Your kitchen changed while it was opening');
  const policies = await acceptedPolicies(page);
  expect(policies).toHaveLength(1);
  await button(page, 'Try again').click();
  await expect.poll(() => page.evaluate(() => window.__staleCookingReads)).toBe(2);
  await expect(button(page, 'Open kitchen again')).toBeVisible();

  const other = await context.newPage();
  try {
    await other.goto(page.url());
    await expect(other.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    await other.getByLabel('Ingredient and details').fill('Other tab tomatoes');
    await other.getByLabel('Add ingredient', {exact:true}).click();
    await expect(other.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');

    await button(page, 'Open kitchen again').click();
    await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    await expect(page.getByText('Other tab tomatoes', {exact:true})).toBeVisible();
    await expect(page.getByLabel('Ingredient and details')).toBeEditable();
    expect(await page.evaluate(() => window.__staleCookingReads)).toBeUndefined();
    expect(await page.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
    expect(await page.evaluate(key => localStorage.getItem(key), choiceKey)).toBe(`local:${namespace}`);
    expect(await acceptedPolicies(page)).toEqual(policies);
  } finally {
    await other.close();
  }
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
  await expect(button(page, 'Start cooking')).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});

test('a second setup tab opens a kitchen whose privacy was already accepted elsewhere without signing again', async ({page, context}) => {
  await openUnacceptedKitchen(page);
  const namespace = await page.evaluate(key => localStorage.getItem(key), workspaceKey);
  const other = await context.newPage();
  try {
    await other.goto(page.url());
    await expect(button(other, 'Start cooking')).toBeEnabled();

    await button(page, 'Start cooking').click();
    await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    const accepted = await acceptedPolicies(page);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].policy.rules[0].enforcement).toBe('preference');

    // The other tab either opens directly or offers to reopen; it never adds a second policy.
    await button(other, 'Start cooking').click();
    const reopen = button(other, 'Open kitchen again');
    const saved = other.getByTestId('pantry-local-persistence-status');
    await expect(reopen.or(saved)).toBeVisible();
    if (await reopen.isVisible()) await reopen.click();
    await expect(saved).toHaveText('Saved locally');
    await expect(other.getByLabel('Ingredient and details')).toBeEditable();
    expect(await other.evaluate(key => localStorage.getItem(key), workspaceKey)).toBe(namespace);
    expect(await acceptedPolicies(other)).toEqual(accepted);
  } finally {
    await other.close();
  }
});

test('a browser missing workspace locks receives useful guidance without creating a kitchen', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', {configurable:true, value:undefined});
  });
  await page.goto('./');
  await button(page, 'Start cooking').click();
  await expect(page.getByRole('alert')).toContainText('browser is missing a feature');
  await expect(page.getByRole('alert')).toContainText('updated browser');
  await expect(button(page, 'Start cooking')).toBeEnabled();
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
