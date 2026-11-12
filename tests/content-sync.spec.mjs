import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

const enabled = process.env.CONTENT_SYNC_E2E === '1';
const baseUrl = process.env.CONTENT_SYNC_BASE_URL ?? 'http://127.0.0.1:8081/creative-cooking/';
const apiUrl = process.env.CONTENT_SYNC_API_URL ?? 'http://127.0.0.1:8788';
const serviceUrl = process.env.CONTENT_SYNC_SERVICE_URL ?? 'http://127.0.0.1:8092';
const privateChatCanary = 'PRIVATE_CHAT_CANARY_DO_NOT_UPLOAD';
const privateAllergyCanary = 'Private allergy canary';
const offlinePersonalChatCanary = 'OFFLINE_PERSONAL_CHAT_APPEND_CANARY';
const providerKeyCanary = 'device-local-provider-key-canary-do-not-upload';

function routeUrl(route) {
  return new URL(route, baseUrl).toString();
}

function redactFixtureSecrets(value) {
  return String(value)
    .replaceAll(privateChatCanary, '[private chat canary redacted]')
    .replaceAll(offlinePersonalChatCanary, '[offline private chat canary redacted]')
    .replaceAll(providerKeyCanary, '[provider key canary redacted]')
    .replaceAll(privateAllergyCanary, '[private allergy canary redacted]');
}

function auditPage(page, audit, privateTargets = {}) {
  page.on('pageerror', (error) => {
    audit.pageErrors += 1;
    audit.pageErrorMessages.push(redactFixtureSecrets(error.message));
  });
  page.on('dialog', async (dialog) => {
    const safeMessage = dialog.message()
      .replaceAll(privateChatCanary, '[private chat canary redacted]')
      .replaceAll(providerKeyCanary, '[provider key canary redacted]')
      .replaceAll(privateAllergyCanary, '[private allergy canary redacted]');
    audit.dialogMessages.push(safeMessage);
    await dialog.accept();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      audit.consoleErrors += 1;
      audit.consoleErrorMessages.push(redactFixtureSecrets(message.text()).slice(0, 500));
    }
  });
  page.on('request', (request) => {
    if (!request.url().includes('/content/mutations')) return;
    audit.contentRequests += 1;
    const body = request.postData() ?? '';
    let parsedBody;
    try { parsedBody = JSON.parse(body); } catch { parsedBody = null; }
    const operationTypes = Array.isArray(parsedBody?.operations)
      ? parsedBody.operations.map((operation) => operation?.type).filter((type) => typeof type === 'string')
      : [];
    const spaceId = new URL(request.url()).pathname.match(/^\/v1\/spaces\/([^/]+)\/content\/mutations$/)?.[1] ?? null;
    audit.mutationRequests.push({
      mutationId: typeof parsedBody?.mutationId === 'string' ? parsedBody.mutationId : null,
      spaceId,
      operationTypes,
      personalPreferenceFields: Array.isArray(parsedBody?.operations)
        ? parsedBody.operations.filter((operation) => operation?.type === 'personal.preference.set').map((operation) => operation.field)
        : [],
      recipeSaves: Array.isArray(parsedBody?.operations)
        ? parsedBody.operations.filter((operation) => operation?.type === 'recipe.save').map((operation) => ({
            opId: operation.opId,
            recipeId: operation.recipe?.id ?? null,
            baseVersion: operation.baseVersion ?? null
          }))
        : [],
      shoppingItemOperations: Array.isArray(parsedBody?.operations)
        ? parsedBody.operations.filter((operation) => typeof operation?.type === 'string'
          && operation.type.startsWith('shopping.item.')).map((operation) => ({
            type: operation.type,
            id: operation.item?.id ?? operation.id ?? null,
            name: operation.item?.name ?? null,
            removedAt: operation.item?.removedAt ?? operation.removedAt ?? null,
            purchaseCycleId: operation.item?.purchaseCycleId ?? operation.purchaseCycleId ?? null
          }))
        : [],
      pantryUpserts: Array.isArray(parsedBody?.operations)
        ? parsedBody.operations.filter((operation) => operation?.type === 'pantry.upsert').map(({ id, name, opId }) => ({ id, name, opId }))
        : []
    });
    const operations = Array.isArray(parsedBody?.operations) ? parsedBody.operations : [];
    if (privateTargets.offlineChat && operations.some((operation) => (
      operation?.type === 'personal.chat.message.append'
        && operation.message?.content === privateTargets.offlineChat
    ))) {
      if (spaceId === audit.personalSpaceId) {
        audit.offlinePersonalChatUploaded = true;
        audit.offlinePersonalChatMutationId = typeof parsedBody?.mutationId === 'string' ? parsedBody.mutationId : null;
      }
      else audit.privateDataLeaked = true;
    }
    if (privateTargets.offlineAllergy && operations.some((operation) => (
      operation?.type === 'personal.allergy.set'
        && operation.name === privateTargets.offlineAllergy.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
        && operation.enabled === true
    ))) {
      if (spaceId === audit.personalSpaceId) audit.offlinePersonalAllergyUploaded = true;
      else audit.privateDataLeaked = true;
    }
    if (body.includes(providerKeyCanary)) {
      audit.providerDataLeaked = true;
      audit.providerLeakRequests.push({
        mutationId: typeof parsedBody?.mutationId === 'string' ? parsedBody.mutationId : null,
        operationTypes: Array.isArray(parsedBody?.operations)
          ? parsedBody.operations.map((operation) => operation?.type).filter((type) => typeof type === 'string')
          : []
      });
    }
    const containsPersonalData = body.includes(privateChatCanary)
      || body.toLocaleLowerCase().includes(privateAllergyCanary.toLocaleLowerCase());
    if (containsPersonalData) {
      const path = new URL(request.url()).pathname;
      const match = path.match(/^\/v1\/spaces\/([^/]+)\/content\/mutations$/);
      const spaceId = match?.[1] ?? null;
      if (!spaceId || spaceId !== audit.personalSpaceId) audit.privateDataLeaked = true;
      else audit.personalDataUploaded = true;
    }
  });
  page.on('requestfailed', (request) => {
    audit.requestFailures.push({
      path: new URL(request.url()).pathname,
      method: request.method(),
      error: request.failure()?.errorText ?? 'unknown'
    });
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path === '/v1/me') {
      audit.meStatuses ??= [];
      audit.meStatuses.push(response.status());
    }
    if (response.status() >= 400 && /(auth|spaces|invitations)/.test(path)) {
      void response.json().then((body) => {
        audit.accountFailures.push({
          path,
          status: response.status(),
          code: typeof body?.error?.code === 'string' ? body.error.code : null,
          message: redactFixtureSecrets(body?.error?.message ?? '').slice(0, 300)
        });
      }).catch(() => undefined);
    }
    if (path.endsWith('/content/mutations')) {
      audit.mutationStatuses.push(response.status());
      const requestBody = (() => { try { return JSON.parse(response.request().postData() ?? ''); } catch { return null; } })();
      audit.mutationResponses.push({
        mutationId: typeof requestBody?.mutationId === 'string' ? requestBody.mutationId : null,
        spaceId: path.match(/^\/v1\/spaces\/([^/]+)\/content\/mutations$/)?.[1] ?? null,
        status: response.status()
      });
    }
    if (path.endsWith('/content/mutations') && response.status() >= 400) {
      const request = response.request();
      let requestBody;
      try { requestBody = JSON.parse(request.postData() ?? ''); } catch { requestBody = null; }
      void response.json().then((body) => {
        audit.mutationFailures.push({
          status: response.status(),
          mutationId: typeof requestBody?.mutationId === 'string' ? requestBody.mutationId : null,
          operationTypes: Array.isArray(requestBody?.operations)
            ? requestBody.operations.map((operation) => operation?.type).filter((type) => typeof type === 'string')
            : [],
          errorCode: typeof body?.error?.code === 'string' ? body.error.code : null,
          errorMessage: redactFixtureSecrets(body?.error?.message ?? '').slice(0, 300)
        });
      }).catch(() => undefined);
    }
    if (path.endsWith('/sync/credentials')) audit.credentialStatuses.push(response.status());
    if (path.endsWith('/v1/me') || path.endsWith('/auth/register') || path.endsWith('/auth/login')) {
      void response.json().then((body) => {
        const personal = body?.spaces?.find((space) => space?.kind === 'personal');
        if (typeof personal?.id === 'string') audit.personalSpaceId = personal.id;
      }).catch(() => undefined);
    }
  });
}

async function register(page, email, password) {
  await page.getByRole('button', { name: 'Create account mode' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  try {
    await page.getByText(`Signed in as ${email}`, { exact: true }).waitFor({ timeout: 20_000 });
  } catch {
    const visibleText = (await page.locator('body').innerText())
      .replaceAll(privateChatCanary, '[private chat canary redacted]')
      .replaceAll(providerKeyCanary, '[provider key canary redacted]')
      .replaceAll('Private allergy canary', '[private allergy canary redacted]');
    throw new Error(`The account status did not update after registration. Visible page text: ${visibleText}`);
  }
}

async function login(page, email, password) {
  await page.getByRole('button', { name: 'Sign in mode' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText(`Signed in as ${email}`, { exact: true }).waitFor({ timeout: 30_000 });
}

async function configureApi(page) {
  await page.getByLabel('API base URL').fill(apiUrl);
  await page.getByRole('button', { name: 'Save API URL' }).click();
  await page.getByRole('textbox', { name: 'PowerSync Service URL' }).fill(serviceUrl);
  await page.getByRole('button', { name: 'Save PowerSync Service URL' }).click();
}

async function storedSessionToken(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('creative-cooking-account', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const session = await new Promise((resolve, reject) => {
      const request = database.transaction('session', 'readonly').objectStore('session').get('current');
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return session?.token ?? null;
  });
}

async function openCookingWorkspace(page, expectedWorkspaceName = null) {
  const homePath = new URL(baseUrl).pathname;
  if (new URL(page.url()).pathname !== homePath) await page.goto(routeUrl(''));
  if (expectedWorkspaceName) {
    const workspaceStatus = page.getByTestId('pantry-workspace-status');
    await expect(workspaceStatus).toContainText(expectedWorkspaceName, { timeout: 60_000 });
    await expect(workspaceStatus).not.toContainText(/opening|switching/, { timeout: 60_000 });
  }
  const pantryTab = page.getByRole('tab', { name: /Pantry/ });
  if (await pantryTab.getAttribute('aria-selected') !== 'true') await pantryTab.click();
  await expect(pantryTab).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Ingredient and details').waitFor();
}

async function openChefWorkspace(page) {
  const chefTab = page.getByRole('tab', { name: /Chef/ });
  if (await chefTab.count()) await chefTab.click();
  else await page.goto(routeUrl('chef'));
  await expect(page.getByRole('textbox', { name: 'Message Chef' })).toBeVisible();
}

async function openSettings(page, signedIn = false, expectedWorkspaceName = null) {
  for (const testId of ['pantry-local-persistence-status', 'chef-local-persistence-status']) {
    const visibleStatus = page.getByTestId(testId).filter({ visible: true }).first();
    if (await visibleStatus.count()) await expect(visibleStatus).toHaveText('Saved locally', { timeout: 30_000 });
  }
  await page.goto(routeUrl('settings'));
  await page.getByLabel('API base URL').waitFor();
  if (signedIn) {
    await expect(page.getByRole('button', { name: /^Sign out(?: from saved session)?$/ })).toBeVisible({ timeout: 30_000 });
    const workspaceStatus = page.getByTestId('cooking-workspace-status');
    await expect(workspaceStatus).toBeVisible({ timeout: 30_000 });
    if (expectedWorkspaceName) await expect(workspaceStatus).toContainText(expectedWorkspaceName, { timeout: 30_000 });
    await expect(workspaceStatus).not.toContainText(/opening|switching/, { timeout: 30_000 });
  }
}

async function restoreAccountConnection(page, email) {
  await page.goto(routeUrl('settings'));
  const sessionStatus = page.getByTestId('account-session-status');
  const checkConnection = page.getByRole('button', { name: 'Check account connection' });
  await expect.poll(async () => {
    const label = (await sessionStatus.textContent())?.replace(/\s+/gu, ' ').trim() ?? '';
    return label === `Signed in as ${email}`
      || (label === 'Account could not be checked offline'
        && await checkConnection.count() > 0
        && await checkConnection.isEnabled());
  }, { timeout: 30_000 }).toBe(true);
  if ((await sessionStatus.textContent())?.replace(/\s+/gu, ' ').trim() !== `Signed in as ${email}`) await checkConnection.click();
  await expect(page.getByText(`Signed in as ${email}`, { exact: true })).toBeVisible({ timeout: 30_000 });
}

function hasAcceptedMutationWith(audit, spaceId, matches) {
  return audit.mutationRequests.some((request) => request.spaceId === spaceId
    && request.mutationId
    && matches(request)
    && audit.mutationResponses.some((response) => response.spaceId === spaceId
      && response.mutationId === request.mutationId
      && response.status === 200));
}

async function selectShoppingList(page, name) {
  const listChoice = page.getByRole('button', { name, exact: true });
  if (await listChoice.count()) await listChoice.click();
  await expect(page.getByText(/purchase cycle active/)).toBeVisible({ timeout: 30_000 });
}

async function addShoppingItem(page, name, listName) {
  await selectShoppingList(page, listName);
  const input = page.getByLabel('Shopping item name');
  await input.fill(name);
  await expect(input).toHaveValue(name);
  const addButton = page.getByRole('button', { name: 'Add', exact: true });
  await expect(addButton).toBeVisible();
  await expect(addButton).toBeEnabled();
  await addButton.click({ timeout: 30_000 });
  await expect(page.getByText(name, { exact: true })).toHaveCount(1);
}

function proposalCard(page, proposalText) {
  return page.getByText(proposalText, { exact: true })
    .locator('xpath=ancestor::*[starts-with(@data-testid, "chef-proposal-")][1]');
}

function markStage(message) {
  console.log(`[content-sync] ${message}`);
}

test('built PWA migrates guest history and synchronizes household records between accounts', async ({ browser }) => {
  test.skip(!enabled, 'Set CONTENT_SYNC_E2E=1 and start the local API and PowerSync Service to run this acceptance path.');
  test.setTimeout(900_000);

  const runId = process.env.CONTENT_SYNC_RUN_ID ?? `cc-content-${Date.now()}-${randomBytes(5).toString('hex')}`;
  const ownerEmail = `${runId}-owner@example.test`;
  const memberEmail = `${runId}-member@example.test`;
  const viewerEmail = `${runId}-viewer@example.test`;
  const outsiderEmail = `${runId}-outsider@example.test`;
  const password = randomBytes(24).toString('base64url');
  const householdName = `Sync Kitchen ${runId.slice(-8)}`;
  const sharedItem = `Shared Pantry ${runId.slice(-8)}`;
  const memberItem = `Member Pantry ${runId.slice(-8)}`;
  const offlineMemberItem = `Offline Pantry ${runId.slice(-8)}`;
  const concurrentOwnerPantryItem = `Offline owner pantry ${runId.slice(-8)}`;
  const concurrentMemberPantryItem = `Offline editor pantry ${runId.slice(-8)}`;
  const concurrentOwnerShoppingItem = `Offline owner shopping ${runId.slice(-8)}`;
  const concurrentMemberShoppingItem = `Offline editor shopping ${runId.slice(-8)}`;
  const concurrentShoppingListName = `Offline shared shopping ${runId.slice(-8)}`;
  const viewerOnlyItem = `Viewer must not add ${runId.slice(-8)}`;
  const historicalEffectName = `Historical effect must not run ${runId.slice(-8)}`;
  const householdEffectName = `Household proposal effect ${runId.slice(-8)}`;
  const deniedEffectName = `Denied proposal remains pending ${runId.slice(-8)}`;
  const offlinePersonalCity = `Offline City ${runId.slice(-8)}`;
  const offlinePersonalAllergy = `Offline allergy ${runId.slice(-8)}`;
  const offlinePersonalChat = `${offlinePersonalChatCanary} ${runId.slice(-8)}`;
  const offlineMealPortions = 6;
  const at = '2026-10-01T12:00:00.000Z';
  const legacy = {
    pantry: [],
    recipes: [{
      id: 'legacy-recipe', title: 'Legacy beans', description: 'Keep the legacy description.', portions: 2,
      ingredients: [
        { id: 'legacy-duplicate-one', name: 'Beans', amount: '1 cup', needsShopping: true, note: 'first line metadata' },
        { id: 'legacy-duplicate-two', name: 'Beans', amount: '2 cups', needsShopping: true, note: 'second line metadata' }
      ],
      steps: ['Mix.', 'Cook.'], stepIds: ['legacy-step-one', 'legacy-step-two'], notes: ['Private recipe note'],
      createdAt: at, updatedAt: at
    }],
    chatMessages: [
      { id: 'private-chat-message', role: 'user', content: privateChatCanary, createdAt: at },
      {
        id: 'private-assistant-message', role: 'assistant', content: 'I have three saved pantry suggestions.', createdAt: '2026-10-01T12:01:00.000Z',
        proposals: [
          { id: 'historical-applied-proposal', toolName: 'pantry_add', arguments: JSON.stringify({ names: [historicalEffectName] }), status: 'applied' },
          { id: 'household-effect-proposal', toolName: 'pantry_add', arguments: JSON.stringify({ names: [householdEffectName] }), status: 'pending' },
          { id: 'denied-effect-proposal', toolName: 'pantry_add', arguments: JSON.stringify({ names: [deniedEffectName] }), status: 'pending' }
        ]
      }
    ],
    chatHistory: [], activeConversationId: 'private-chat',
    mealContext: { willingToShop: true, portions: 4, cooks: ['medium'] },
    settings: {
      allergies: [privateAllergyCanary], sendLocalTime: true, city: '',
      providerId: 'openrouter', model: 'openrouter/free', dictationEngine: 'browser'
    }
  };
  const ownerAudit = {
    contentRequests: 0, mutationStatuses: [], mutationResponses: [], credentialStatuses: [], pageErrors: 0, consoleErrors: 0,
    personalSpaceId: null, personalDataUploaded: false, privateDataLeaked: false, providerDataLeaked: false, accountFailures: [],
    providerLeakRequests: [], dialogMessages: [], mutationFailures: [], mutationRequests: [], pageErrorMessages: [], consoleErrorMessages: [], requestFailures: []
  };
  const ownerSecondAudit = {
    contentRequests: 0, mutationStatuses: [], mutationResponses: [], credentialStatuses: [], pageErrors: 0, consoleErrors: 0,
    personalSpaceId: null, personalDataUploaded: false, privateDataLeaked: false, providerDataLeaked: false, accountFailures: [],
    providerLeakRequests: [], dialogMessages: [], mutationFailures: [], mutationRequests: [], pageErrorMessages: [], consoleErrorMessages: [], requestFailures: []
  };
  const memberAudit = {
    contentRequests: 0, mutationStatuses: [], mutationResponses: [], credentialStatuses: [], pageErrors: 0, consoleErrors: 0,
    personalSpaceId: null, personalDataUploaded: false, privateDataLeaked: false, providerDataLeaked: false, accountFailures: [],
    providerLeakRequests: [], dialogMessages: [], mutationFailures: [], mutationRequests: [], pageErrorMessages: [], consoleErrorMessages: [], requestFailures: []
  };
  const viewerAudit = {
    contentRequests: 0, mutationStatuses: [], mutationResponses: [], credentialStatuses: [], pageErrors: 0, consoleErrors: 0,
    personalSpaceId: null, personalDataUploaded: false, privateDataLeaked: false, providerDataLeaked: false, accountFailures: [],
    providerLeakRequests: [], dialogMessages: [], mutationFailures: [], mutationRequests: [], pageErrorMessages: [], consoleErrorMessages: [], requestFailures: []
  };
  const outsiderAudit = {
    contentRequests: 0, mutationStatuses: [], mutationResponses: [], credentialStatuses: [], pageErrors: 0, consoleErrors: 0,
    personalSpaceId: null, personalDataUploaded: false, privateDataLeaked: false, providerDataLeaked: false, accountFailures: [],
    providerLeakRequests: [], dialogMessages: [], mutationFailures: [], mutationRequests: [], pageErrorMessages: [], consoleErrorMessages: [], requestFailures: []
  };
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let ownerSecondContext;
  let memberContext;
  let viewerContext;
  let outsiderContext;

  try {
    markStage('checking local migration and shopping persistence');
    await ownerContext.addInitScript((legacyState) => {
      if (window.localStorage.getItem('creative-cooking-state-v1') === null) {
        window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify(legacyState));
      }
    }, legacy);
    const owner = await ownerContext.newPage();
    auditPage(owner, ownerAudit, {
      offlineChat: offlinePersonalChat,
      offlineAllergy: offlinePersonalAllergy
    });
    await owner.goto(routeUrl('shopping'));
    await expect(owner.getByText('Shopping list', { exact: true })).toBeVisible();
    await expect(owner.getByText(/Saved on this device only\.|Saved locally in Local on this device;/)).toBeVisible();
    try {
      await expect(owner.getByRole('checkbox', { name: 'Check Beans' })).toHaveCount(2, { timeout: 15_000 });
    } catch {
      const localProbe = await owner.evaluate(() => {
        const raw = localStorage.getItem('creative-cooking-state-v1');
        if (!raw) return { legacyStatePresent: false };
        const state = JSON.parse(raw);
        return {
          legacyStatePresent: true,
          legacyStateLength: raw.length,
          recipeCount: Array.isArray(state.recipes) ? state.recipes.length : null,
          flaggedIngredients: Array.isArray(state.recipes)
            ? state.recipes.reduce((count, recipe) => count + (Array.isArray(recipe.ingredients)
              ? recipe.ingredients.filter((ingredient) => ingredient.needsShopping === true).length : 0), 0)
            : null
        };
      });
      const visibleText = (await owner.locator('body').innerText())
        .replaceAll(privateChatCanary, '[private chat canary redacted]')
        .replaceAll(providerKeyCanary, '[provider key canary redacted]')
        .replaceAll('Private allergy canary', '[private allergy canary redacted]');
      throw new Error(`Legacy shopping migration did not render its rows. ${JSON.stringify({ localProbe, visibleText, pageErrors: ownerAudit.pageErrors })}`);
    }
    await owner.reload();
    await expect(owner.getByRole('checkbox', { name: 'Check Beans' })).toHaveCount(2);
    await owner.getByRole('checkbox', { name: 'Check Beans' }).first().click();
    await owner.getByRole('button', { name: /Add checked to Pantry/ }).click();
    await expect(owner.getByText('1 checked item recorded for this purchase. Pantry entries are added only once.')).toBeVisible();
    await expect(owner.getByText('Saved on this device only.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await owner.getByRole('button', { name: 'Start new purchase cycle' }).click();
    await expect(owner.getByText('A new purchase cycle has started.')).toBeVisible();
    await expect(owner.getByText('Saved on this device only.', { exact: true })).toBeVisible({ timeout: 30_000 });

    // Remove current rows while retaining the immutable purchase snapshots.
    await expect(owner.getByRole('button', { name: 'Remove Beans' })).toHaveCount(2);
    const firstLegacyItem = owner.getByTestId('shopping-item-legacy-item:legacy-recipe:legacy-duplicate-one');
    const secondLegacyItem = owner.getByTestId('shopping-item-legacy-item:legacy-recipe:legacy-duplicate-two');
    await firstLegacyItem.getByRole('button', { name: 'Remove Beans' }).click();
    await expect(firstLegacyItem).toHaveCount(0);
    await secondLegacyItem.getByRole('button', { name: 'Remove Beans' }).click();
    await expect(secondLegacyItem).toHaveCount(0);
    await expect(owner.getByRole('button', { name: 'Remove Beans' })).toHaveCount(0);
    await expect(owner.getByText('Saved on this device only.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await openCookingWorkspace(owner);
    await expect(owner.getByRole('button', { name: 'Remove Beans' })).toHaveCount(1);
    for (let removed = 0; removed < 10; removed += 1) {
      const removePantryButtons = owner.getByRole('button', { name: 'Remove Beans' });
      if (await removePantryButtons.count() === 0) break;
      await removePantryButtons.first().click();
    }
    await expect(owner.getByRole('button', { name: 'Remove Beans' })).toHaveCount(0);
    await openSettings(owner);
    await expect(owner.getByText('Local cooking changes are saved on this device.', { exact: true })).toBeVisible({ timeout: 30_000 });
    const [preReloadBackupDownload] = await Promise.all([
      owner.waitForEvent('download'),
      owner.getByRole('button', { name: 'Export backup' }).click()
    ]);
    const preReloadBackupPath = await preReloadBackupDownload.path();
    expect(preReloadBackupPath).toBeTruthy();
    const preReloadBackup = JSON.parse(await readFile(preReloadBackupPath, 'utf8'));
    expect(preReloadBackup.state.pantry).toHaveLength(0);
    const persistedGuestProbe = await owner.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('creative-cooking');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const raw = await new Promise((resolve, reject) => {
        const transaction = database.transaction('app-state', 'readonly');
        const request = transaction.objectStore('app-state').get('creative-cooking-state-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      const state = typeof raw === 'string' ? JSON.parse(raw) : null;
      return {
        exists: !!state,
        pantryCount: Array.isArray(state?.pantry) ? state.pantry.length : null,
        shoppingItems: Array.isArray(state?.shopping?.items)
          ? state.shopping.items.map(({ id, removedAt }) => ({ id, removedAt: removedAt ?? null }))
          : null
      };
    });
    expect(persistedGuestProbe, 'guest backup persistence should be committed before reload').toMatchObject({
      exists: true,
      pantryCount: 0
    });
    expect(persistedGuestProbe.shoppingItems, 'both removed rows should be committed before reload')
      .toHaveLength(2);
    expect(persistedGuestProbe.shoppingItems.every((item) => item.removedAt), JSON.stringify(persistedGuestProbe.shoppingItems))
      .toBe(true);
    expect(preReloadBackup.state.shopping.items.every((item) => item.removedAt), JSON.stringify(
      preReloadBackup.state.shopping.items.map(({ id, removedAt }) => ({ id, removedAt: removedAt ?? null }))
    )).toBe(true);
    await owner.reload();
    await expect(owner.getByRole('button', { name: `Remove allergy ${privateAllergyCanary}` })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByText('Local cooking changes are saved on this device.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByRole('button', { name: `Remove allergy ${privateAllergyCanary}` })).toBeVisible();
    const [guestBackupDownload] = await Promise.all([
      owner.waitForEvent('download'),
      owner.getByRole('button', { name: 'Export backup' }).click()
    ]);
    const guestBackupPath = await guestBackupDownload.path();
    expect(guestBackupPath).toBeTruthy();
    const guestBackup = JSON.parse(await readFile(guestBackupPath, 'utf8'));
    expect(guestBackup.state.pantry).toHaveLength(0);
    expect(guestBackup.state.shopping.purchases, JSON.stringify({
      pantryCount: guestBackup.state.pantry.length,
      listCount: guestBackup.state.shopping.lists.length,
      cycleCount: guestBackup.state.shopping.cycles.length,
      itemCount: guestBackup.state.shopping.items.length,
      purchaseCount: guestBackup.state.shopping.purchases.length,
      checkedItems: guestBackup.state.shopping.items.filter((item) => item.checked).length,
      purchasedCycleItems: guestBackup.state.shopping.items.filter((item) => item.purchasedCycleId).length
    })).toHaveLength(1);
    expect(guestBackup.state.shopping.purchases[0].pantryItemIds).toHaveLength(1);
    expect(guestBackup.state.shopping.items).toHaveLength(2);
    expect(guestBackup.state.shopping.items.every((item) => Boolean(item.removedAt)), JSON.stringify(
      guestBackup.state.shopping.items.map(({ id, purchaseCycleId, purchasedCycleId, checked, removedAt }) => ({ id, purchaseCycleId, purchasedCycleId, checked, removedAt }))
    )).toBe(true);
    await expect(owner.getByLabel('API base URL')).toBeVisible();
    await expect(owner.getByText('Local on this device', { exact: true })).toBeVisible();
    await owner.getByRole('textbox', { name: 'OpenRouter API key' }).fill(providerKeyCanary);
    await owner.getByRole('button', { name: 'Save OpenRouter API key' }).click();
    await configureApi(owner);
    await register(owner, ownerEmail, password);
    await owner.reload();
    await expect(owner.getByText(`Signed in as ${ownerEmail}`, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => ownerAudit.personalSpaceId).toBeTruthy();
    markStage('owner account is registered and personal workspace is ready');

    let historyProcessedButUnacknowledged = false;
    let pauseRetries = false;
    const mutationAttempts = new Map();
    const historyMutationIds = new Set();
    const historySnapshots = [];
    const adoptedShoppingItemIds = new Set();
    const adoptedItemOperations = [];
    const adoptedPantryIds = new Set();
    const adoptedPantryNames = new Set();
    const adoptedProposalCreates = [];
    const proposalStatusOperations = [];
    let historyResponseStatus = null;
    let householdEffectMutationId = null;
    const householdEffectMutationIds = new Set();
    let householdEffectSpaceId = null;
    let householdEffectOperationId = null;
    let householdEffectRequestCount = 0;
    let householdEffectResponseStatus = null;
    let allowEffectRetryAfterRestart = false;
    let statusMutationId = null;
    let statusRequestCount = 0;
    let statusResponseStatus = null;
    let statusResponseLost = false;
    let statusMode = 'block';
    let deniedEffectMutationId = null;
    let deniedEffectResponseStatus = null;
    const deniedEffectMutationIds = new Set();
    await ownerContext.route('**/content/mutations', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const body = route.request().postData() ?? '';
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        request = null;
      }
      if (typeof request?.mutationId === 'string') {
        const attempts = mutationAttempts.get(request.mutationId) ?? [];
        attempts.push(createHash('sha256').update(body).digest('hex'));
        mutationAttempts.set(request.mutationId, attempts);
      }
      const historyOperations = Array.isArray(request?.operations)
        ? request.operations.filter((operation) => operation?.type === 'shopping.history.import')
        : [];
      const operations = Array.isArray(request?.operations) ? request.operations : [];
      if (String(request?.mutationId ?? '').startsWith('guest-adoption-v2-')) {
        for (const operation of operations) {
          if (operation?.type === 'pantry.upsert') {
            if (typeof operation.id === 'string') adoptedPantryIds.add(operation.id);
            if (typeof operation.name === 'string') adoptedPantryNames.add(operation.name);
          }
          if (operation?.type === 'shopping.item.upsert' && typeof operation.item?.id === 'string') adoptedShoppingItemIds.add(operation.item.id);
          if (operation?.type === 'shopping.item.upsert' || operation?.type === 'shopping.item.remove') {
            adoptedItemOperations.push({
              type: operation.type,
              id: operation.item?.id ?? operation.id ?? null,
              removedAt: operation.item?.removedAt ?? operation.removedAt ?? null
            });
          }
          if (operation?.type === 'personal.chat.proposal.create') adoptedProposalCreates.push(operation);
        }
      }
      proposalStatusOperations.push(...operations.filter((operation) => operation?.type === 'personal.chat.proposal.setStatus'));
      for (const operation of historyOperations) {
        if (typeof request.mutationId === 'string') historyMutationIds.add(request.mutationId);
        for (const purchase of operation.purchases ?? []) {
          historySnapshots.push({ itemIds: purchase.itemIds, pantryItemIds: purchase.pantryItemIds });
        }
      }
      if (historyOperations.length > 0 && !historyProcessedButUnacknowledged) {
        const response = await route.fetch();
        historyResponseStatus = response.status();
        if (!response.ok()) {
          await route.fulfill({ response });
          return;
        }
        historyProcessedButUnacknowledged = true;
        pauseRetries = true;
        await route.abort('failed');
        return;
      }
      if (pauseRetries) {
        await route.abort('failed');
        return;
      }

      const effectOperation = operations.find((operation) => operation?.type === 'pantry.upsert' && operation.name === householdEffectName);
      if (effectOperation) {
        householdEffectMutationId = request.mutationId;
        if (typeof request.mutationId === 'string') householdEffectMutationIds.add(request.mutationId);
        householdEffectSpaceId = new URL(route.request().url()).pathname.match(/^\/v1\/spaces\/([^/]+)\/content\/mutations$/)?.[1] ?? null;
        householdEffectOperationId = effectOperation.opId;
        householdEffectRequestCount += 1;
        if (householdEffectRequestCount === 1) {
          const response = await route.fetch();
          householdEffectResponseStatus = response.status();
          if (!response.ok()) {
            await route.fulfill({ response });
            return;
          }
          await route.abort('failed');
          return;
        }
        if (!allowEffectRetryAfterRestart) {
          await route.abort('failed');
          return;
        }
      }

      const statusOperation = operations.find((operation) => operation?.type === 'personal.chat.proposal.setStatus');
      if (statusOperation) {
        statusMutationId = request.mutationId;
        statusRequestCount += 1;
        if (statusMode === 'block') {
          await route.abort('failed');
          return;
        }
        if (statusMode === 'accept-then-lose') {
          if (statusResponseLost) {
            await route.abort('failed');
            return;
          }
          const response = await route.fetch();
          statusResponseStatus = response.status();
          if (!response.ok()) {
            await route.fulfill({ response });
            return;
          }
          statusResponseLost = true;
          await route.abort('failed');
          return;
        }
        if (statusMode === 'hold-after-loss') {
          await route.abort('failed');
          return;
        }
      }

      const deniedOperation = operations.find((operation) => operation?.type === 'pantry.upsert' && operation.name === deniedEffectName);
      if (deniedOperation) {
        deniedEffectMutationId = request.mutationId;
        deniedEffectMutationIds.add(request.mutationId);
        deniedEffectResponseStatus = 403;
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'ROLE_REQUIRED', message: 'This workspace role cannot edit shared cooking records.' } })
        });
        return;
      }
      await route.continue();
    });

    const mergeButton = owner.getByRole('button', { name: /Merge local cooking into/ });
    await expect(mergeButton).toBeVisible({ timeout: 20_000 });
    await mergeButton.click();
    await expect(owner.getByText(/server has not accepted every workspace upload yet/)).toBeVisible({ timeout: 30_000 });
    await owner.reload();
    await expect(owner.getByText(`Signed in as ${ownerEmail}`, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByText(/server has not accepted every workspace upload yet/)).toBeVisible({ timeout: 30_000 });
    await owner.getByRole('button', { name: /Continue local cooking import into/ }).click();
    pauseRetries = false;
    try {
      await expect(owner.getByText('Local cooking records were merged into this workspace. The original local copy remains saved.', { exact: true }))
        .toBeVisible({ timeout: 90_000 });
    } catch {
      const visibleText = (await owner.locator('body').innerText())
        .replaceAll(privateChatCanary, '[private chat canary redacted]')
        .replaceAll(providerKeyCanary, '[provider key canary redacted]')
        .replaceAll('Private allergy canary', '[private allergy canary redacted]');
      const attemptCounts = [...mutationAttempts.values()].map((attempts) => attempts.length);
      throw new Error(`Guest adoption did not complete. ${JSON.stringify({ visibleText, historyProcessedButUnacknowledged, historyResponseStatus, historySnapshotCount: historySnapshots.length, mutationAttemptCounts: attemptCounts, mutationStatuses: ownerAudit.mutationStatuses, credentialStatuses: ownerAudit.credentialStatuses })}`);
    }
    expect(historyProcessedButUnacknowledged).toBe(true);
    expect(historyResponseStatus).toBe(200);
    expect(historySnapshots.length).toBeGreaterThan(0);
    const [adoptionRecoveryDownload] = await Promise.all([
      owner.waitForEvent('download'),
      owner.getByRole('button', { name: 'Export workspace recovery file' }).click()
    ]);
    const adoptionRecoveryPath = await adoptionRecoveryDownload.path();
    const adoptionRecovery = JSON.parse(await readFile(adoptionRecoveryPath, 'utf8'));
    const guestSourceArchive = adoptionRecovery.archives.find((archive) => archive.kind === 'guest-adoption-source');
    const archivedGuestState = guestSourceArchive ? JSON.parse(guestSourceArchive.data_json) : null;
    expect(historySnapshots.every((snapshot) => snapshot.itemIds.length > 0 && snapshot.pantryItemIds.length > 0)).toBe(true);
    expect(historySnapshots.some((snapshot) => snapshot.itemIds.some((id) => !adoptedShoppingItemIds.has(id)))).toBe(true);
    const missingLivePantrySnapshots = historySnapshots.flatMap((snapshot) => snapshot.pantryItemIds.filter((id) => !adoptedPantryIds.has(id)));
    expect(missingLivePantrySnapshots.length, JSON.stringify({
      guestPantryCount: guestBackup.state.pantry.length,
      archivedGuestPantryCount: archivedGuestState?.pantry?.length ?? null,
      adoptedStatePantryCount: adoptionRecovery.state.pantry.length,
      snapshotPantryIds: historySnapshots.flatMap((snapshot) => snapshot.pantryItemIds),
      adoptedPantryIds: [...adoptedPantryIds],
      adoptedPantryNames: [...adoptedPantryNames]
    })).toBeGreaterThan(0);
    expect(adoptedProposalCreates.some((operation) => operation.proposal?.status === 'applied'
      && operation.proposal?.toolName === 'pantry_add'
      && operation.proposal?.arguments?.includes(historicalEffectName))).toBe(true);
    const householdProposalCreate = adoptedProposalCreates.find((operation) => operation.proposal?.status === 'pending'
      && operation.proposal?.toolName === 'pantry_add'
      && operation.proposal?.arguments?.includes(householdEffectName));
    expect(householdProposalCreate).toBeTruthy();
    expect(adoptedPantryNames.has(historicalEffectName)).toBe(false);
    expect(ownerAudit.personalDataUploaded).toBe(true);
    expect(ownerAudit.privateDataLeaked).toBe(false);
    expect(ownerAudit.providerDataLeaked).toBe(false);
    markStage('guest cooking and personal history adoption is acknowledged');
    const repeatedHistoryId = [...historyMutationIds].find((mutationId) => (mutationAttempts.get(mutationId)?.length ?? 0) > 1);
    expect(repeatedHistoryId).toBeTruthy();
    for (const attempts of mutationAttempts.values()) expect(new Set(attempts).size).toBe(1);

    await owner.goto(routeUrl('shopping'));
    try {
      await expect(owner.getByText(/server has confirmed the current upload and download queue/)).toBeVisible({ timeout: 90_000 });
    } catch {
      const visibleText = (await owner.locator('body').innerText())
        .replaceAll(privateChatCanary, '[private chat canary redacted]')
        .replaceAll(providerKeyCanary, '[provider key canary redacted]')
        .replaceAll('Private allergy canary', '[private allergy canary redacted]');
      throw new Error(`Workspace did not reach confirmed sync after guest adoption. ${JSON.stringify({ visibleText, dialogMessages: ownerAudit.dialogMessages, mutationStatuses: ownerAudit.mutationStatuses, mutationFailures: ownerAudit.mutationFailures, mutationRequests: ownerAudit.mutationRequests, credentialStatuses: ownerAudit.credentialStatuses, pageErrors: ownerAudit.pageErrors, pageErrorMessages: ownerAudit.pageErrorMessages, consoleErrors: ownerAudit.consoleErrors, consoleErrorMessages: ownerAudit.consoleErrorMessages })}`);
    }
    const remainingBeanCheckboxes = await owner.getByRole('checkbox', { name: /Check Beans/ }).evaluateAll((nodes) => nodes.map((node) => ({
      label: node.getAttribute('aria-label'),
      checked: node.getAttribute('aria-checked')
    })));
    expect(remainingBeanCheckboxes, JSON.stringify({ adoptedItemOperations, adoptedShoppingItemIds: [...adoptedShoppingItemIds] })).toHaveLength(0);

    await owner.goto(routeUrl('settings'));
    await owner.getByLabel('Household name').fill(householdName);
    await owner.getByRole('button', { name: 'Create household' }).click();
    await expect(owner.getByRole('button', { name: `Use ${householdName} for cooking` })).toBeVisible({ timeout: 20_000 });
    const householdWorkspaceChoice = owner.getByRole('button', { name: `Use ${householdName} for cooking` });
    await householdWorkspaceChoice.click();
    await expect(owner.getByTestId('cooking-workspace-status')).toContainText(householdName, { timeout: 30_000 });
    await expect(owner.getByText('Your role here is owner')).toBeVisible();
    markStage('household is selected as the cooking workspace');
    await openCookingWorkspace(owner, householdName);
    await owner.getByLabel('Ingredient and details').fill(sharedItem);
    await owner.getByRole('button', { name: 'Add ingredient' }).click();
    await expect(owner.getByText(sharedItem, { exact: true })).toBeVisible();
    await expect(owner.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
    try {
      await expect.poll(() => ownerAudit.mutationResponses.some((response) => (
        response.status === 200 && ownerAudit.mutationRequests.some((request) => (
          request.mutationId === response.mutationId
            && request.pantryUpserts.some((operation) => operation.name === sharedItem)
        ))
      )), { timeout: 90_000 }).toBe(true);
    } catch {
      throw new Error(`Household pantry save was not acknowledged. ${JSON.stringify({
        workspaceStatus: await owner.getByTestId('pantry-workspace-status').textContent().catch(() => null),
        localPersistence: await owner.getByTestId('pantry-local-persistence-status').textContent().catch(() => null),
        requests: ownerAudit.mutationRequests,
        responses: ownerAudit.mutationResponses,
        failures: ownerAudit.mutationFailures,
        accountFailures: ownerAudit.accountFailures,
        pageErrors: ownerAudit.pageErrorMessages,
        consoleErrors: ownerAudit.consoleErrorMessages
      })}`);
    }
    await expect(owner.getByTestId('pantry-workspace-status')).toContainText('synced', { timeout: 30_000 });
    markStage('owner added the first household pantry record');

    const syncedHouseholdSpaceId = ownerAudit.mutationRequests.find((request) => (
      request.pantryUpserts.some((operation) => operation.name === sharedItem)
    ))?.spaceId;
    expect(syncedHouseholdSpaceId).toBeTruthy();
    await owner.getByRole('tab', { name: /Recipes/ }).click();
    await owner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(owner.getByTestId('shopping-local-persistence-status')).toContainText(householdName);
    await owner.getByLabel('New shopping list name').fill(concurrentShoppingListName);
    await owner.getByRole('button', { name: 'Create shopping list' }).click();
    await selectShoppingList(owner, concurrentShoppingListName);
    const shoppingSaveStatus = owner.getByTestId('shopping-local-persistence-status');
    await expect(shoppingSaveStatus).toHaveText('Saving changes on this device…', { timeout: 10_000 });
    await expect(shoppingSaveStatus).toContainText(householdName, { timeout: 30_000 });
    await expect(shoppingSaveStatus).not.toContainText('Local on this device');
    await expect.poll(() => {
      const request = ownerAudit.mutationRequests.find((entry) => (
        entry.spaceId === syncedHouseholdSpaceId && entry.operationTypes.includes('shopping.list.create')
      ));
      return request && ownerAudit.mutationResponses.some((response) => response.mutationId === request.mutationId);
    }, { timeout: 30_000 }).toBeTruthy();
    const createListRequest = ownerAudit.mutationRequests.find((request) => (
      request.spaceId === syncedHouseholdSpaceId && request.operationTypes.includes('shopping.list.create')
    ));
    const createListResponse = ownerAudit.mutationResponses.find((response) => (
      response.mutationId === createListRequest?.mutationId
    ));
    expect(createListResponse?.status, JSON.stringify({
      spaceId: createListRequest?.spaceId,
      mutationId: createListRequest?.mutationId,
      operationTypes: createListRequest?.operationTypes,
      response: createListResponse,
      failures: ownerAudit.mutationFailures.filter((failure) => failure.mutationId === createListRequest?.mutationId)
    })).toBe(200);
    markStage('household shopping list upload received an accepted server response');

    await openSettings(owner, true, householdName);
    await owner.getByRole('button', { name: `View members of ${householdName}` }).click();
    await owner.getByLabel(`Invitation email for ${householdName}`).fill(viewerEmail);
    await owner.getByRole('button', { name: 'Invite as viewer' }).click();
    await owner.getByRole('button', { name: `Invite member to ${householdName}` }).click();
    const viewerInviteToken = await owner.getByLabel('One-time invitation token').inputValue();
    expect(viewerInviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const viewer = await viewerContext.newPage();
    auditPage(viewer, viewerAudit);
    await viewer.goto(routeUrl('settings'));
    await configureApi(viewer);
    await register(viewer, viewerEmail, password);
    await viewer.getByLabel('Invitation token').fill(viewerInviteToken);
    await viewer.getByRole('button', { name: 'Accept invitation' }).click();
    const viewerWorkspaceChoice = viewer.getByRole('button', { name: `Use ${householdName} for cooking` });
    await expect(viewerWorkspaceChoice).toBeVisible({ timeout: 20_000 });
    await viewerWorkspaceChoice.click();
    await expect(viewer.getByText(/^Your role here is viewer/)).toBeVisible({ timeout: 30_000 });
    await openCookingWorkspace(viewer, householdName);
    await expect(viewer.getByText(sharedItem, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(viewer.getByLabel('Ingredient and details')).toHaveAttribute('readonly');
    await expect(viewer.getByRole('button', { name: 'Add ingredient' })).toBeDisabled();
    await expect(viewer.getByText(/read-only for viewers/)).toBeVisible();
    await expect(viewer.getByText(viewerOnlyItem, { exact: true })).toHaveCount(0);
    await openSettings(viewer, true, householdName);
    await expect(viewer.getByText('Your role here is viewer (read only).', { exact: true })).toBeVisible();
    expect(viewerAudit.mutationRequests.some((request) => request.pantryUpserts.some((operation) => operation.name === viewerOnlyItem))).toBe(false);
    markStage('viewer downloaded shared records and the app disabled pantry edits with a read-only explanation');

    outsiderContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const outsider = await outsiderContext.newPage();
    auditPage(outsider, outsiderAudit);
    await outsider.goto(routeUrl('settings'));
    await configureApi(outsider);
    await register(outsider, outsiderEmail, password);
    await openCookingWorkspace(outsider);
    await expect(outsider.getByText(sharedItem, { exact: true })).toHaveCount(0);
    await openSettings(outsider, true);
    await expect(outsider.getByRole('button', { name: `Use ${householdName} for cooking` })).toHaveCount(0);
    markStage('unrelated account had no household choice or downloaded pantry row');

    await openChefWorkspace(owner);
    const chefWorkspaceStatus = owner.getByTestId('chef-workspace-status');
    await expect(chefWorkspaceStatus).toContainText(householdName, { timeout: 30_000 });
    await expect(chefWorkspaceStatus).toContainText('owner');
    await expect(chefWorkspaceStatus).not.toContainText(/opening|switching/, { timeout: 30_000 });
    await expect(owner.getByText(historicalEffectName, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByRole('button', { name: 'Add applied', exact: true })).toBeDisabled();
    await expect(owner.getByText(householdEffectName, { exact: true })).toBeVisible();
    await expect(owner.getByRole('button', { name: 'Add', exact: true })).toHaveCount(2);
    const householdEffectCard = proposalCard(owner, householdEffectName);
    await expect(householdEffectCard.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    await householdEffectCard.getByRole('button', { name: 'Add', exact: true }).click();
    markStage('household Chef effect was started');
    try {
      await expect.poll(() => householdEffectResponseStatus, { timeout: 30_000 }).toBe(200);
    } catch {
      const visibleText = redactFixtureSecrets(await owner.locator('body').innerText());
      let recoverySummary = null;
      try {
        await owner.goto(routeUrl('settings'));
        const [recoveryDownload] = await Promise.all([
          owner.waitForEvent('download'),
          owner.getByRole('button', { name: 'Export workspace recovery file' }).click()
        ]);
        const recovery = JSON.parse(await readFile(await recoveryDownload.path(), 'utf8'));
        recoverySummary = {
          signedIn: await owner.getByText(`Signed in as ${ownerEmail}`, { exact: true }).count() > 0,
          workspaceStatus: await owner.getByTestId('cooking-workspace-status').textContent().catch(() => null),
          ownerRoleVisible: await owner.getByText('Your role here is owner', { exact: true }).count() > 0,
          pending: (recovery.pending ?? []).map(({ mutation_id, payload_json }) => ({
            mutationId: mutation_id,
            operationTypes: JSON.parse(payload_json).operations?.map((operation) => operation.type) ?? []
          })),
          blocked: (recovery.blocked ?? []).map(({ mutation_id, error_json }) => ({ mutationId: mutation_id, error: error_json })),
          proposalActions: (recovery.proposalActions ?? []).map(({ stage, effect_mutation_id, effect_op_id, status_mutation_id }) => ({
            stage, effectMutationId: effect_mutation_id, effectOpId: effect_op_id, statusMutationId: status_mutation_id
          })),
          issueTypes: (recovery.issues ?? []).map(({ issue_type }) => issue_type)
        };
      } catch (error) {
        recoverySummary = { error: error instanceof Error ? error.message : String(error) };
      }
      throw new Error(`Household Chef effect was not uploaded. ${JSON.stringify({ visibleText, recoverySummary, dialogMessages: ownerAudit.dialogMessages, mutationStatuses: ownerAudit.mutationStatuses, mutationFailures: ownerAudit.mutationFailures, mutationRequests: ownerAudit.mutationRequests, credentialStatuses: ownerAudit.credentialStatuses, householdEffectRequestCount, pageErrors: ownerAudit.pageErrors, pageErrorMessages: ownerAudit.pageErrorMessages, consoleErrors: ownerAudit.consoleErrors, consoleErrorMessages: ownerAudit.consoleErrorMessages })}`);
    }
    await expect.poll(() => householdEffectMutationId).toBeTruthy();

    // The server accepted the household effect, but its first response was lost.
    // Keep retries blocked until a real page reload has reopened the same IndexedDB profile.
    const effectRetryReload = owner.reload();
    allowEffectRetryAfterRestart = true;
    await effectRetryReload;
    await expect(owner.getByText(householdEffectName, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => householdEffectRequestCount).toBeGreaterThanOrEqual(2);
    await expect.poll(() => statusRequestCount).toBeGreaterThan(0);

    // Restart again with status upload blocked, then let the exact durable status request reach the server.
    await owner.reload();
    await expect(owner.getByText(householdEffectName, { exact: true })).toBeVisible({ timeout: 30_000 });
    const lostStatusReload = owner.reload();
    statusMode = 'accept-then-lose';
    await lostStatusReload;
    await expect.poll(() => statusResponseLost, { timeout: 60_000 }).toBe(true);
    expect(statusResponseStatus).toBe(200);

    // The server accepted the personal status mutation too, but that response is lost.
    // Reopen the app once more while retries are held, then acknowledge the cached replay.
    statusMode = 'hold-after-loss';
    await owner.reload();
    await expect(owner.getByText(householdEffectName, { exact: true })).toBeVisible({ timeout: 30_000 });
    const finalStatusReload = owner.reload();
    statusMode = 'final-ack';
    await finalStatusReload;
    await expect(owner.getByText(householdEffectName, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByRole('button', { name: 'Add applied', exact: true })).toHaveCount(2, { timeout: 60_000 });
    expect(householdEffectRequestCount).toBeGreaterThanOrEqual(2);
    expect([...householdEffectMutationIds]).toEqual([householdEffectMutationId]);
    expect(new Set(mutationAttempts.get(householdEffectMutationId)).size).toBe(1);
    expect(statusRequestCount).toBeGreaterThanOrEqual(2);
    expect(new Set(mutationAttempts.get(statusMutationId)).size).toBe(1);
    const linkedStatus = proposalStatusOperations.find((operation) => operation.proposalId === householdProposalCreate.proposal.id);
    expect(linkedStatus).toMatchObject({
      status: 'applied',
      effectSpaceId: householdEffectSpaceId,
      effectMutationId: householdEffectMutationId,
      effectOpId: householdEffectOperationId
    });
    expect(householdEffectSpaceId).toBeTruthy();
    markStage('effect receipt and linked personal proposal status survived restarts');

    ownerSecondContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const ownerSecond = await ownerSecondContext.newPage();
    auditPage(ownerSecond, ownerSecondAudit, {
      offlineChat: offlinePersonalChat,
      offlineAllergy: offlinePersonalAllergy
    });
    await ownerSecond.goto(routeUrl('settings'));
    await configureApi(ownerSecond);
    await login(ownerSecond, ownerEmail, password);
    await expect.poll(() => ownerSecondAudit.personalSpaceId).toBe(ownerAudit.personalSpaceId);
    await openChefWorkspace(ownerSecond);
    await ownerSecond.getByLabel('Open previous chats').click();
    await ownerSecond.getByRole('button', { name: `Open conversation ${privateChatCanary}` }).click();
    await expect(ownerSecond.getByText(privateChatCanary, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(ownerSecond.getByRole('button', { name: 'Edit meal context, 4 portions, 1 cooks' })).toBeVisible();
    await openSettings(ownerSecond, true, 'Personal');
    await expect(ownerSecond.getByRole('button', { name: `Remove allergy ${privateAllergyCanary}` })).toBeVisible();
    markStage('second browser context restored the same personal conversation and preferences');

    await openSettings(owner, true, householdName);
    await ownerContext.route('https://openrouter.ai/**', (route) => route.abort('failed'));
    await ownerContext.setOffline(true);
    await owner.reload();
    await expect(owner.getByText('Account could not be checked offline', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByTestId('cooking-workspace-status')).toContainText('Saved workspace (membership unverified)', { timeout: 30_000 });
    await expect(owner.getByTestId('cooking-workspace-status')).not.toContainText(/opening|switching/, { timeout: 30_000 });
    const cityInput = owner.getByRole('textbox', { name: 'City', exact: true });
    await expect(cityInput).toBeVisible();
    await cityInput.fill(offlinePersonalCity);
    await expect(cityInput).toHaveValue(offlinePersonalCity);
    await expect(owner.getByTestId('offline-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });

    const allergyInput = owner.getByRole('textbox', { name: 'Add allergies' });
    await allergyInput.fill(offlinePersonalAllergy);
    await owner.getByRole('button', { name: 'Add allergies' }).click();
    await expect(owner.getByRole('button', { name: `Remove allergy ${offlinePersonalAllergy}` })).toBeVisible();
    await expect(owner.getByTestId('offline-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });

    await openChefWorkspace(owner);
    await expect(owner.getByRole('button', { name: 'Edit meal context, 4 portions, 1 cooks' })).toBeVisible();
    await owner.getByRole('button', { name: 'Edit meal context, 4 portions, 1 cooks' }).click();
    await owner.getByRole('button', { name: 'Increase Portions' }).click();
    await owner.getByRole('button', { name: 'Increase Portions' }).click();
    await owner.getByRole('button', { name: 'Increase People cooking' }).click();
    await owner.getByRole('radio', { name: 'Cook 2 energy: high' }).click();
    await owner.getByRole('button', { name: 'Close meal context' }).click();
    await expect(owner.getByRole('button', { name: `Edit meal context, ${offlineMealPortions} portions, 2 cooks` })).toBeVisible();
    await owner.getByLabel('Message Chef').fill(offlinePersonalChat);
    await owner.getByRole('button', { name: 'Send message' }).click();
    await expect(owner.getByText(offlinePersonalChat, { exact: true })).toBeVisible();
    await expect(owner.getByTestId('chef-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });

    await owner.reload();
    await expect(owner.getByText(offlinePersonalChat, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByRole('button', { name: `Edit meal context, ${offlineMealPortions} portions, 2 cooks` })).toBeVisible();
    await owner.goto(routeUrl('settings'));
    await expect(owner.getByText('Account could not be checked offline', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByTestId('cooking-workspace-status')).toContainText('Saved workspace (membership unverified)', { timeout: 30_000 });
    await expect(owner.getByRole('textbox', { name: 'City', exact: true })).toHaveValue(offlinePersonalCity, { timeout: 30_000 });
    await expect(owner.getByRole('button', { name: `Remove allergy ${offlinePersonalAllergy}` })).toBeVisible();
    markStage('offline city, allergy, meal context, and chat edits survived a network-disabled browser reload');
    await ownerContext.setOffline(false);
    const signedInStatus = owner.getByText(`Signed in as ${ownerEmail}`, { exact: true });
    await owner.reload();
    await expect(signedInStatus).toBeVisible({ timeout: 60_000 });
    markStage('account membership was revalidated after connectivity returned');
    await expect(owner.getByTestId('cooking-workspace-status')).not.toContainText(/opening|switching/, { timeout: 30_000 });
    await expect.poll(() => ownerAudit.mutationResponses.some((response) => (
      response.status === 200 && ownerAudit.mutationRequests.some((request) => (
        request.mutationId === response.mutationId
          && request.spaceId === ownerAudit.personalSpaceId
          && request.personalPreferenceFields.includes('city')
      ))
    )), { timeout: 90_000 }).toBe(true);
    await expect(ownerSecond.getByRole('textbox', { name: 'City', exact: true })).toHaveValue(offlinePersonalCity, { timeout: 90_000 });
    await expect(ownerSecond.getByRole('button', { name: `Remove allergy ${offlinePersonalAllergy}` })).toBeVisible({ timeout: 90_000 });
    expect(ownerAudit.offlinePersonalAllergyUploaded).toBe(true);
    const acceptedOfflineChatUpload = [ownerAudit, ownerSecondAudit].some((audit) => (
      audit.offlinePersonalChatUploaded === true
        && hasAcceptedMutationWith(audit, ownerAudit.personalSpaceId, (request) => (
          request.mutationId === audit.offlinePersonalChatMutationId
        ))
    ));
    expect(acceptedOfflineChatUpload, JSON.stringify({
      ownerChatObserved: ownerAudit.offlinePersonalChatUploaded === true,
      ownerSecondChatObserved: ownerSecondAudit.offlinePersonalChatUploaded === true,
      ownerPersonalMutations: ownerAudit.mutationRequests
        .filter((request) => request.spaceId === ownerAudit.personalSpaceId)
        .map(({ mutationId, operationTypes }) => ({ mutationId, operationTypes })),
      ownerSecondPersonalMutations: ownerSecondAudit.mutationRequests
        .filter((request) => request.spaceId === ownerSecondAudit.personalSpaceId)
        .map(({ mutationId, operationTypes }) => ({ mutationId, operationTypes })),
      ownerPersonalResponses: ownerAudit.mutationResponses
        .filter((response) => response.spaceId === ownerAudit.personalSpaceId),
      ownerSecondPersonalResponses: ownerSecondAudit.mutationResponses
        .filter((response) => response.spaceId === ownerSecondAudit.personalSpaceId)
    })).toBe(true);
    const personalMealContextFields = new Set(ownerAudit.mutationRequests
      .filter((request) => request.spaceId === ownerAudit.personalSpaceId)
      .flatMap((request) => request.personalPreferenceFields));
    expect(personalMealContextFields.has('mealContext.portions')).toBe(true);
    expect(personalMealContextFields.has('mealContext.cooksCount')).toBe(true);
    expect(personalMealContextFields.has('mealContext.cooks.1')).toBe(true);
    await openChefWorkspace(ownerSecond);
    await expect(ownerSecond.getByRole('button', { name: `Edit meal context, ${offlineMealPortions} portions, 2 cooks` })).toBeVisible({ timeout: 90_000 });
    await expect(ownerSecond.getByText(privateChatCanary, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(ownerSecond.getByText(offlinePersonalChat, { exact: true })).toBeVisible({ timeout: 90_000 });
    markStage('offline personal preferences, allergy, meal context, and chat reached the second owner context only through personal-space records');

    await openCookingWorkspace(owner, householdName);
    await expect(owner.getByTestId('pantry-screen').getByText(householdEffectName, { exact: true })).toHaveCount(1);

    await openChefWorkspace(owner);
    await expect(owner.getByText(deniedEffectName, { exact: true })).toBeVisible();
    const deniedEffectCard = proposalCard(owner, deniedEffectName);
    await deniedEffectCard.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => deniedEffectResponseStatus).toBe(403);
    expect(deniedEffectMutationId).toBeTruthy();
    await expect.poll(() => ownerAudit.mutationFailures.some((failure) => (
      failure.mutationId === deniedEffectMutationId && failure.status === 403
    )), { timeout: 30_000 }).toBe(true);
    await expect(owner.getByTestId('chef-workspace-status')).toContainText(/attention|error/, { timeout: 30_000 });

    await openSettings(owner, true, householdName);
    const [recoveryDownload] = await Promise.all([
      owner.waitForEvent('download'),
      owner.getByRole('button', { name: 'Export workspace recovery file' }).click()
    ]);
    const recoveryPath = await recoveryDownload.path();
    expect(recoveryPath).toBeTruthy();
    const recovery = JSON.parse(await readFile(recoveryPath, 'utf8'));
    const deniedAction = recovery.proposalActions.find((action) => action.effect_mutation_id === deniedEffectMutationId);
    expect(deniedAction?.stage, JSON.stringify({
      deniedEffectMutationId,
      deniedEffectMutationIds: [...deniedEffectMutationIds],
      deniedRequests: ownerAudit.mutationRequests.flatMap((request) => request.pantryUpserts
        .filter((item) => item.name === deniedEffectName)
        .map((item) => ({ mutationId: request.mutationId, spaceId: request.spaceId, operationId: item.opId, entityId: item.id }))),
      responseFailures: ownerAudit.mutationFailures.filter((failure) => failure.mutationId === deniedEffectMutationId),
      proposalActions: recovery.proposalActions.map((action) => ({
        proposalId: action.proposal_id,
        effectMutationId: action.effect_mutation_id,
        payloadMutationId: JSON.parse(action.effect_payload_json).mutationId,
        effectOperationId: action.effect_op_id,
        stage: action.stage
      })),
      workspaceStatus: await owner.getByTestId('cooking-workspace-status').textContent().catch(() => null),
      pending: recovery.pending.map((row) => ({
        mutationId: row.mutation_id,
        spaceId: row.space_id,
        operations: JSON.parse(row.payload_json).operations
      })),
      blocked: recovery.blocked.map((row) => ({
        mutationId: row.mutation_id,
        spaceId: row.space_id,
        operations: JSON.parse(row.payload_json).operations
      }))
    })).toBe('effect-blocked');
    expect(deniedAction?.effect_mutation_id).toBe(deniedEffectMutationId);
    expect(new Set(ownerAudit.mutationRequests.flatMap((request) => request.pantryUpserts
      .filter((item) => item.name === deniedEffectName)
      .map((item) => request.mutationId))).size).toBe(1);
    expect(recovery.blocked.some((row) => row.mutation_id === deniedEffectMutationId)).toBe(true);
    const deniedProposal = recovery.state.chatMessages.flatMap((message) => message.proposals ?? [])
      .find((proposal) => proposal.id === deniedAction.proposal_id);
    expect(deniedProposal?.status).toBe('pending');
    expect(JSON.stringify(recovery).includes(providerKeyCanary)).toBe(false);
    markStage('denied household effect remains pending and exportable');

    await openSettings(owner, true, householdName);
    await owner.getByRole('button', { name: `View members of ${householdName}` }).click();
    await owner.getByLabel(`Invitation email for ${householdName}`).fill(memberEmail);
    await owner.getByRole('button', { name: 'Invite as editor' }).click();
    await owner.getByRole('button', { name: `Invite member to ${householdName}` }).click();
    const invitationTokenField = owner.getByLabel('One-time invitation token');
    try {
      await expect(invitationTokenField).toBeVisible({ timeout: 15_000 });
    } catch {
      const visibleText = redactFixtureSecrets(await owner.locator('body').innerText());
      throw new Error(`The editor invitation was not created. ${JSON.stringify({ visibleText, accountFailures: ownerAudit.accountFailures })}`);
    }
    const inviteToken = await invitationTokenField.inputValue();
    expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    markStage('owner created a one-use editor invitation');

    memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const member = await memberContext.newPage();
    auditPage(member, memberAudit);
    await member.goto(routeUrl('settings'));
    await configureApi(member);
    await register(member, memberEmail, password);
    markStage('second account registered independently');
    await member.getByLabel('Invitation token').fill(inviteToken);
    await member.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(member.getByRole('button', { name: `Use ${householdName} for cooking` })).toBeVisible({ timeout: 20_000 });
    await member.getByRole('button', { name: `Use ${householdName} for cooking` }).click();
    await expect(member.getByText('Your role here is editor')).toBeVisible();
    markStage('second account accepted the invitation with editor role');
    await openCookingWorkspace(member, householdName);
    try {
      await expect(member.getByText(sharedItem, { exact: true })).toBeVisible({ timeout: 90_000 });
      await expect(member.getByText(householdEffectName, { exact: true })).toBeVisible({ timeout: 90_000 });
    } catch {
      throw new Error(`Editor did not download household rows. ${JSON.stringify({
        visibleText: redactFixtureSecrets(await member.locator('body').innerText()),
        workspaceStatus: await member.getByTestId('cooking-workspace-status').textContent().catch(() => null),
        credentialStatuses: memberAudit.credentialStatuses,
        accountFailures: memberAudit.accountFailures,
        contentRequests: memberAudit.contentRequests,
        mutationResponses: memberAudit.mutationResponses,
        mutationRequests: memberAudit.mutationRequests,
        mutationStatuses: memberAudit.mutationStatuses,
        mutationFailures: memberAudit.mutationFailures,
        pageErrors: memberAudit.pageErrorMessages,
        consoleErrors: memberAudit.consoleErrorMessages
      })}`);
    }
    markStage('editor downloaded existing household pantry records');
    await member.goto(routeUrl('shopping'));
    await expect(member.getByText(/server has confirmed the current upload and download queue/)).toBeVisible({ timeout: 90_000 });

    await openCookingWorkspace(member, householdName);
    await member.getByLabel('Ingredient and details').fill(memberItem);
    await member.getByRole('button', { name: 'Add ingredient' }).click();
    await expect(member.getByText(memberItem, { exact: true })).toBeVisible();
    markStage('editor added a household pantry record');
    await openSettings(member, true, householdName);
    await expect(member.getByText('Local cooking changes are saved on this device.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await owner.goto(routeUrl(''));
    await expect(owner.getByText(memberItem, { exact: true })).toBeVisible({ timeout: 90_000 });
    markStage('owner downloaded editor pantry change');

    await openChefWorkspace(member);
    await expect(member.getByText('What sounds good?', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(member.getByText(privateChatCanary, { exact: true })).toHaveCount(0);
    await expect(member.getByText(offlinePersonalChat, { exact: true })).toHaveCount(0);
    await expect(member.getByText(historicalEffectName, { exact: true })).toHaveCount(0);
    await openCookingWorkspace(member, householdName);

    // Both members edit separate pantry and shopping records while disconnected.
    // Reconnect the owner first, then the editor, and require each device to
    // converge without duplicate rows.
    await owner.getByRole('tab', { name: /Recipes/ }).click();
    await owner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await selectShoppingList(owner, concurrentShoppingListName);
    await member.getByRole('tab', { name: /Recipes/ }).click();
    await member.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(member.getByText(concurrentShoppingListName, { exact: true })).toBeVisible({ timeout: 90_000 });
    await selectShoppingList(member, concurrentShoppingListName);

    await ownerContext.setOffline(true);
    await memberContext.setOffline(true);
    await owner.reload();
    await member.reload();
    await owner.goto(routeUrl('settings'));
    await expect(owner.getByText('Account could not be checked offline', { exact: true })).toBeVisible({ timeout: 30_000 });
    await openCookingWorkspace(owner);
    await expect(owner.getByTestId('pantry-workspace-status')).toContainText('membership unverified');
    await member.goto(routeUrl('settings'));
    await expect(member.getByText('Account could not be checked offline', { exact: true })).toBeVisible({ timeout: 30_000 });
    await openCookingWorkspace(member);
    await expect(member.getByTestId('pantry-workspace-status')).toContainText('membership unverified');

    await owner.getByLabel('Ingredient and details').fill(concurrentOwnerPantryItem);
    await owner.getByRole('button', { name: 'Add ingredient' }).click();
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentOwnerPantryItem, { exact: true })).toBeVisible();
    await expect(owner.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
    await owner.getByRole('tab', { name: /Recipes/ }).click();
    await owner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await addShoppingItem(owner, concurrentOwnerShoppingItem, concurrentShoppingListName);
    await expect(owner.getByTestId('shopping-local-persistence-status')).toContainText('Saved on this device.', { timeout: 30_000 });

    await member.getByLabel('Ingredient and details').fill(concurrentMemberPantryItem);
    await member.getByRole('button', { name: 'Add ingredient' }).click();
    await expect(member.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toBeVisible();
    await expect(member.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
    await member.getByRole('tab', { name: /Recipes/ }).click();
    await member.getByRole('button', { name: 'Shopping', exact: true }).click();
    await addShoppingItem(member, concurrentMemberShoppingItem, concurrentShoppingListName);
    await expect(member.getByTestId('shopping-local-persistence-status')).toContainText('Saved on this device.', { timeout: 30_000 });

    await owner.reload();
    await member.reload();
    await openCookingWorkspace(owner);
    await expect(owner.getByTestId('pantry-workspace-status')).toContainText('membership unverified');
    await openCookingWorkspace(member);
    await expect(member.getByTestId('pantry-workspace-status')).toContainText('membership unverified');
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentOwnerPantryItem, { exact: true })).toHaveCount(1);
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toHaveCount(0);
    await expect(member.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toHaveCount(1);
    await expect(member.getByTestId('pantry-screen').getByText(concurrentOwnerPantryItem, { exact: true })).toHaveCount(0);
    await owner.getByRole('tab', { name: /Recipes/ }).click();
    await owner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(owner.getByText(concurrentOwnerShoppingItem, { exact: true })).toHaveCount(1);
    await expect(owner.getByText(concurrentMemberShoppingItem, { exact: true })).toHaveCount(0);
    await member.getByRole('tab', { name: /Recipes/ }).click();
    await member.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(member.getByText(concurrentMemberShoppingItem, { exact: true })).toHaveCount(1);
    await expect(member.getByText(concurrentOwnerShoppingItem, { exact: true })).toHaveCount(0);
    markStage('owner and editor kept independent pantry and shopping edits through offline reloads');

    await ownerContext.setOffline(false);
    await restoreAccountConnection(owner, ownerEmail);
    await openCookingWorkspace(owner, householdName);
    await expect.poll(() => (
      hasAcceptedMutationWith(ownerAudit, syncedHouseholdSpaceId, (request) => (
        request.pantryUpserts.some((operation) => operation.name === concurrentOwnerPantryItem)
      ))
      && hasAcceptedMutationWith(ownerAudit, syncedHouseholdSpaceId, (request) => (
        request.shoppingItemOperations.some((operation) => operation.name === concurrentOwnerShoppingItem)
      ))
    ), { timeout: 90_000 }).toBe(true);
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentOwnerPantryItem, { exact: true })).toHaveCount(1);
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toHaveCount(0);

    await memberContext.setOffline(false);
    await restoreAccountConnection(member, memberEmail);
    await openCookingWorkspace(member, householdName);
    await expect.poll(() => (
      hasAcceptedMutationWith(memberAudit, syncedHouseholdSpaceId, (request) => (
        request.pantryUpserts.some((operation) => operation.name === concurrentMemberPantryItem)
      ))
      && hasAcceptedMutationWith(memberAudit, syncedHouseholdSpaceId, (request) => (
        request.shoppingItemOperations.some((operation) => operation.name === concurrentMemberShoppingItem)
      ))
    ), { timeout: 90_000 }).toBe(true);
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentOwnerPantryItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await expect(member.getByTestId('pantry-screen').getByText(concurrentOwnerPantryItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await expect(member.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });

    await owner.getByRole('tab', { name: /Recipes/ }).click();
    await owner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(owner.getByText(concurrentOwnerShoppingItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await expect(owner.getByText(concurrentMemberShoppingItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await member.getByRole('tab', { name: /Recipes/ }).click();
    await member.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(member.getByText(concurrentOwnerShoppingItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await expect(member.getByText(concurrentMemberShoppingItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    markStage('owner-first offline reconnect converged without duplicate pantry or shopping records on both clients');

    await memberContext.setOffline(true);
    await openCookingWorkspace(member);
    await expect(member.getByTestId('pantry-workspace-status')).toContainText('membership unverified');
    await member.getByLabel('Ingredient and details').fill(offlineMemberItem);
    await member.getByRole('button', { name: 'Add ingredient' }).click();
    await expect(member.getByText(offlineMemberItem, { exact: true })).toBeVisible();
    await expect(member.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
    markStage('offline household record was written locally');
    await openSettings(member);
    await expect(member.getByRole('button', { name: 'Sign out from saved session', exact: true })).toBeVisible();
    await expect(member.getByText('Your role here is editor', { exact: true })).toHaveCount(0);
    await expect(member.getByText('Local cooking changes are saved on this device.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await member.reload();
    await openCookingWorkspace(member);
    const offlinePantryStatus = member.getByTestId('pantry-workspace-status');
    await expect(offlinePantryStatus).toContainText('membership unverified');
    await expect(offlinePantryStatus).toContainText('offline unverified');
    await expect(offlinePantryStatus).not.toContainText(/· editor|· owner|· viewer/);
    await expect(member.getByText(offlineMemberItem, { exact: true })).toBeVisible({ timeout: 30_000 });
    await openSettings(owner, true, householdName);
    await owner.getByRole('button', { name: `View members of ${householdName}` }).click();
    await expect(owner.getByText(memberEmail, { exact: false })).toBeVisible();
    await owner.getByLabel(`Remove ${memberEmail} from ${householdName}`).click();
    await owner.getByLabel(`Confirm remove ${memberEmail}`).click();
    await expect(owner.getByText(memberEmail, { exact: false })).toHaveCount(0);
    const householdSpaceId = syncedHouseholdSpaceId;
    expect(householdSpaceId).toBeTruthy();
    await memberContext.setOffline(false);
    await member.goto(routeUrl('settings'));
    const connectionCheck = member.getByRole('button', { name: 'Check account connection' });
    if (await connectionCheck.count()) await connectionCheck.click();
    await expect(member.getByText(`Signed in as ${memberEmail}`, { exact: true })).toBeVisible({ timeout: 60_000 });
    const revokedWorkspaceChoice = member.getByRole('button', { name: `Use ${householdName} for cooking` });
    if (await revokedWorkspaceChoice.count()) {
      await member.getByRole('button', { name: 'Check account and household access' }).click();
      await expect(revokedWorkspaceChoice).toHaveCount(0, { timeout: 30_000 });
    }
    await expect(member.getByTestId('cooking-workspace-status')).toContainText('Personal', { timeout: 30_000 });
    const originalMemberToken = await storedSessionToken(member);
    expect(originalMemberToken).toBeTruthy();
    const revokedWrite = await member.evaluate(async ({ api, token, spaceId, itemName, uniqueId }) => {
      const response = await fetch(`${api}/v1/spaces/${spaceId}/content/mutations`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'omit',
        body: JSON.stringify({
          mutationId: `revoked-member-${uniqueId}`,
          operations: [{ opId: `revoked-member-op-${uniqueId}`, type: 'pantry.upsert', id: `revoked-item-${uniqueId}`, name: itemName, preference: 3 }]
        })
      });
      const body = await response.json();
      return { status: response.status, errorCode: body?.error?.code ?? null };
    }, { api: apiUrl, token: originalMemberToken, spaceId: householdSpaceId, itemName: offlineMemberItem, uniqueId: runId });
    expect(revokedWrite).toEqual({ status: 403, errorCode: 'SPACE_ACCESS_DENIED' });
    await owner.goto(routeUrl(''));
    await expect(owner.getByText(offlineMemberItem, { exact: true })).toHaveCount(0);

    const [removedWorkspaceDownload] = await Promise.all([
      member.waitForEvent('download'),
      member.getByRole('button', { name: 'Export workspace recovery file' }).click()
    ]);
    const removedWorkspaceRecovery = JSON.parse(await readFile(await removedWorkspaceDownload.path(), 'utf8'));
    const removedWorkspaceArchive = removedWorkspaceRecovery.archives.find((archive) => archive.scope_id === householdSpaceId && archive.kind === 'membership-removed');
    const recoveryMutations = [
      ...(removedWorkspaceRecovery.pending ?? []),
      ...(removedWorkspaceRecovery.blocked ?? []),
      ...(removedWorkspaceArchive ? JSON.parse(removedWorkspaceArchive.data_json).pending ?? [] : []),
      ...(removedWorkspaceArchive ? JSON.parse(removedWorkspaceArchive.data_json).blocked ?? [] : [])
    ];
    const pendingEditExported = recoveryMutations.some((row) => {
      try { return JSON.parse(row.payload_json).operations?.some((operation) => operation.name === offlineMemberItem); }
      catch { return false; }
    });
    const archivedEditPreserved = removedWorkspaceArchive
      ? JSON.parse(removedWorkspaceArchive.data_json).state.pantry.some((item) => item.name === offlineMemberItem)
      : false;
    expect(pendingEditExported || archivedEditPreserved, JSON.stringify({
      archives: removedWorkspaceRecovery.archives.map((archive) => ({ scopeId: archive.scope_id, kind: archive.kind })),
      currentStatePantry: removedWorkspaceRecovery.state.pantry.map((item) => item.name),
      pending: removedWorkspaceRecovery.pending.map((row) => row.mutation_id),
      blocked: removedWorkspaceRecovery.blocked.map((row) => row.mutation_id),
      memberStatus: await member.getByTestId('cooking-workspace-status').textContent().catch(() => null),
      memberNoticeVisible: await member.getByText(new RegExp(`Access to ${householdName} was removed`)).count(),
      memberAccountFailures: memberAudit.accountFailures,
      memberMutationFailures: memberAudit.mutationFailures
    })).toBe(true);
    markStage(`removed editor switched to personal space and exported pending work via ${pendingEditExported ? 'blocked outbox record' : 'membership archive'}`);

    await member.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(member.getByText('Not signed in', { exact: true })).toBeVisible();
    await login(member, outsiderEmail, password);
    await openCookingWorkspace(member);
    await expect(member.getByText(offlineMemberItem, { exact: true })).toHaveCount(0);
    await expect(member.getByText(sharedItem, { exact: true })).toHaveCount(0);
    markStage('switching from removed member to a different account did not expose old cooking data');

    expect(ownerAudit.contentRequests).toBeGreaterThan(0);
    expect(ownerSecondAudit.credentialStatuses).toContain(200);
    expect(memberAudit.contentRequests).toBeGreaterThan(0);
    expect(ownerAudit.personalDataUploaded).toBe(true);
    expect(ownerSecondAudit.personalDataUploaded).toBe(false);
    expect(ownerAudit.privateDataLeaked || ownerSecondAudit.privateDataLeaked || memberAudit.privateDataLeaked
      || viewerAudit.privateDataLeaked || outsiderAudit.privateDataLeaked).toBe(false);
    expect(ownerAudit.providerDataLeaked || ownerSecondAudit.providerDataLeaked || memberAudit.providerDataLeaked
      || viewerAudit.providerDataLeaked || outsiderAudit.providerDataLeaked, JSON.stringify({
      owner: ownerAudit.providerLeakRequests,
      ownerSecond: ownerSecondAudit.providerLeakRequests,
      member: memberAudit.providerLeakRequests,
      viewer: viewerAudit.providerLeakRequests,
      outsider: outsiderAudit.providerLeakRequests
    })).toBe(false);
    expect(ownerAudit.pageErrors + ownerSecondAudit.pageErrors + memberAudit.pageErrors
      + viewerAudit.pageErrors + outsiderAudit.pageErrors).toBe(0);
    const browserAudits = [ownerAudit, ownerSecondAudit, memberAudit, viewerAudit, outsiderAudit];
    const expectedConsoleMessages = new Set([
      'Failed to load resource: net::ERR_FAILED',
      'Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
      'Failed to load resource: the server responded with a status of 403 (Forbidden)',
      'falling back to ArrayBuffer instantiation'
    ]);
    const expectedWasmStreamingMessages = new Set([
      'wasm streaming compile failed: TypeError: Failed to fetch',
      'wasm streaming compile failed: TypeError: WebAssembly compilation aborted: Network error: Response body loading was aborted'
    ]);
    const unexpectedConsoleErrors = browserAudits.flatMap((audit) => audit.consoleErrorMessages
      .filter((message) => !expectedWasmStreamingMessages.has(message) && !expectedConsoleMessages.has(message)));
    expect(unexpectedConsoleErrors, JSON.stringify({
      owner: ownerAudit.consoleErrorMessages,
      ownerSecond: ownerSecondAudit.consoleErrorMessages,
      member: memberAudit.consoleErrorMessages,
      viewer: viewerAudit.consoleErrorMessages,
      outsider: outsiderAudit.consoleErrorMessages
    })).toEqual([]);
    for (const audit of browserAudits) {
      const count = (needle) => audit.consoleErrorMessages.filter((message) => message === needle).length;
      const failedNetworkRequests = audit.requestFailures.filter((failure) => failure.error === 'net::ERR_FAILED').length;
      const offlineNetworkFailures = audit.requestFailures.filter((failure) => (
        failure.error === 'net::ERR_INTERNET_DISCONNECTED'
      )).length;
      const deniedResponses = audit.mutationFailures.filter((failure) => failure.status === 403).length;
      const abortedWasmLoads = audit.requestFailures.filter((failure) => (
        failure.error === 'net::ERR_ABORTED' && failure.path.endsWith('.wasm')
      )).length;
      const wasmStreamingFailures = audit.consoleErrorMessages.filter((message) => (
        expectedWasmStreamingMessages.has(message)
      )).length;
      // The intentional offline route block also aborts account and PowerSync
      // requests, so correlate browser console noise with all failed requests.
      expect(count('Failed to load resource: net::ERR_FAILED')).toBeLessThanOrEqual(failedNetworkRequests);
      expect(count('Failed to load resource: net::ERR_INTERNET_DISCONNECTED')).toBeLessThanOrEqual(offlineNetworkFailures);
      expect(count('Failed to load resource: the server responded with a status of 403 (Forbidden)')).toBeLessThanOrEqual(deniedResponses);
      expect(wasmStreamingFailures).toBeLessThanOrEqual(abortedWasmLoads);
      expect(count('falling back to ArrayBuffer instantiation')).toBe(wasmStreamingFailures);
    }

    await member.goto(routeUrl('settings'));
    await member.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(member.getByText('Not signed in', { exact: true })).toBeVisible();
    await owner.goto(routeUrl('settings'));
    await owner.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(owner.getByText('Not signed in', { exact: true })).toBeVisible();
    await ownerSecond.goto(routeUrl('settings'));
    await ownerSecond.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(ownerSecond.getByText('Not signed in', { exact: true })).toBeVisible();
    await viewer.goto(routeUrl('settings'));
    await viewer.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(viewer.getByText('Not signed in', { exact: true })).toBeVisible();
    await outsider.goto(routeUrl('settings'));
    await outsider.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(outsider.getByText('Not signed in', { exact: true })).toBeVisible();
  } finally {
    const closeContexts = Promise.allSettled([
      memberContext?.close(),
      viewerContext?.close(),
      outsiderContext?.close(),
      ownerSecondContext?.close(),
      ownerContext.close()
    ]);
    await Promise.race([closeContexts, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await browser.close().catch(() => undefined);
  }
});
