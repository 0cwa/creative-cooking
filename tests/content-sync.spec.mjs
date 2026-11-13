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
      payloadHash: createHash('sha256').update(body).digest('hex'),
      spaceId,
      operationTypes,
      personalPreferenceFields: Array.isArray(parsedBody?.operations)
        ? parsedBody.operations.filter((operation) => operation?.type === 'personal.preference.set').map((operation) => operation.field)
        : [],
      recipeSaves: Array.isArray(parsedBody?.operations)
        ? parsedBody.operations.filter((operation) => operation?.type === 'recipe.save').map((operation) => ({
            opId: operation.opId,
            recipeId: operation.recipe?.id ?? null,
            title: operation.recipe?.title ?? null,
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
        : [],
      shoppingPurchases: Array.isArray(parsedBody?.operations)
        ? parsedBody.operations.filter((operation) => operation?.type === 'shopping.purchase').map(({ opId, purchase }) => ({
            opId,
            id: purchase?.id ?? null,
            listId: purchase?.listId ?? null,
            purchaseCycleId: purchase?.purchaseCycleId ?? null,
            itemIds: purchase?.itemIds ?? [],
            pantryItemIds: purchase?.pantryItemIds ?? []
          }))
        : [],
      shoppingCycleStarts: Array.isArray(parsedBody?.operations)
        ? parsedBody.operations.filter((operation) => operation?.type === 'shopping.cycle.start').map(({ listId, cycle }) => ({
            listId,
            cycleId: cycle?.id ?? null
          }))
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
      const responseRequestBody = response.request().postData() ?? '';
      const requestBody = (() => { try { return JSON.parse(responseRequestBody); } catch { return null; } })();
      audit.mutationResponses.push({
        mutationId: typeof requestBody?.mutationId === 'string' ? requestBody.mutationId : null,
        payloadHash: createHash('sha256').update(responseRequestBody).digest('hex'),
        spaceId: path.match(/^\/v1\/spaces\/([^/]+)\/content\/mutations$/)?.[1] ?? null,
        status: response.status()
      });
      void response.json().then((body) => {
        audit.mutationResults ??= [];
        audit.mutationResults.push({
          mutationId: typeof requestBody?.mutationId === 'string' ? requestBody.mutationId : null,
          spaceId: path.match(/^\/v1\/spaces\/([^/]+)\/content\/mutations$/)?.[1] ?? null,
          status: response.status(),
          operations: Array.isArray(body?.operations) ? body.operations : []
        });
      }).catch(() => undefined);
    }
    if (path.endsWith('/content/mutations') && response.status() >= 400) {
      const request = response.request();
      let requestBody;
      try { requestBody = JSON.parse(request.postData() ?? ''); } catch { requestBody = null; }
      void response.json().then((body) => {
        audit.mutationFailures.push({
          status: response.status(),
          mutationId: typeof requestBody?.mutationId === 'string' ? requestBody.mutationId : null,
          payloadHash: createHash('sha256').update(request.postData() ?? '').digest('hex'),
          spaceId: path.match(/^\/v1\/spaces\/([^/]+)\/content\/mutations$/)?.[1] ?? null,
          operationTypes: Array.isArray(requestBody?.operations)
            ? requestBody.operations.map((operation) => operation?.type).filter((type) => typeof type === 'string')
            : [],
          errorCode: typeof body?.error?.code === 'string' ? body.error.code : null,
          errorMessage: redactFixtureSecrets(body?.error?.message ?? '').slice(0, 300)
        });
      }).catch(() => undefined);
    }
    if (response.status() === 429) {
      audit.rateLimitResponses.push({ method: response.request().method(), path });
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

function createAudit() {
  return {
    contentRequests: 0, mutationStatuses: [], mutationResponses: [], credentialStatuses: [], rateLimitResponses: [], pageErrors: 0, consoleErrors: 0,
    personalSpaceId: null, personalDataUploaded: false, privateDataLeaked: false, providerDataLeaked: false,
    accountFailures: [], providerLeakRequests: [], dialogMessages: [], mutationFailures: [], mutationRequests: [],
    pageErrorMessages: [], consoleErrorMessages: [], requestFailures: []
  };
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

async function configureApi(page, targetApiUrl = apiUrl) {
  await page.getByLabel('API base URL').fill(targetApiUrl);
  await page.getByRole('button', { name: 'Save API URL' }).click();
  await page.getByRole('textbox', { name: 'PowerSync Service URL' }).fill(serviceUrl);
  await page.getByRole('button', { name: 'Save PowerSync Service URL' }).click();
}

function apiUrlFor(role) {
  return process.env[`CONTENT_SYNC_${role.toUpperCase()}_API_URL`] ?? apiUrl;
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
  const pantryTab = page.getByRole('tab', { name: /Pantry/ });
  if (new URL(page.url()).pathname !== homePath) {
    if (await pantryTab.count()) {
      if (await pantryTab.getAttribute('aria-selected') !== 'true') await pantryTab.click();
    } else {
      await page.goto(routeUrl(''));
    }
  }
  if (expectedWorkspaceName) {
    const workspaceStatus = page.getByTestId('pantry-workspace-status');
    await expect(workspaceStatus).toContainText(expectedWorkspaceName, { timeout: 60_000 });
    await expect(workspaceStatus).not.toContainText(/opening|switching/, { timeout: 60_000 });
  }
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
      || (label === 'Account access unverified'
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
  const tombstonePantryItem = `Tombstone Pantry ${runId.slice(-8)}`;
  const staleCycleShoppingItem = `Stale cycle ${runId.slice(-8)}`;
  const concurrentOwnerPantryItem = `Offline owner pantry ${runId.slice(-8)}`;
  const concurrentMemberPantryItem = `Offline editor pantry ${runId.slice(-8)}`;
  const concurrentOwnerShoppingItem = `Offline owner shopping ${runId.slice(-8)}`;
  const concurrentMemberShoppingItem = `Offline editor shopping ${runId.slice(-8)}`;
  const concurrentShoppingListName = `Offline shared shopping ${runId.slice(-8)}`;
  const viewerOnlyItem = `Viewer must not add ${runId.slice(-8)}`;
  const historicalEffectName = `Historical effect must not run ${runId.slice(-8)}`;
  const householdEffectName = `Household proposal effect ${runId.slice(-8)}`;
  const deniedEffectName = `Denied proposal remains pending ${runId.slice(-8)}`;
  const ignoredEffectName = `Ignored proposal remains pending ${runId.slice(-8)}`;
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
        id: 'private-assistant-message', role: 'assistant', content: 'I have four saved pantry suggestions.', createdAt: '2026-10-01T12:01:00.000Z',
        proposals: [
          { id: 'historical-applied-proposal', toolName: 'pantry_add', arguments: JSON.stringify({ names: [historicalEffectName] }), status: 'applied' },
          { id: 'household-effect-proposal', toolName: 'pantry_add', arguments: JSON.stringify({ names: [householdEffectName] }), status: 'pending' },
          { id: 'denied-effect-proposal', toolName: 'pantry_add', arguments: JSON.stringify({ names: [deniedEffectName] }), status: 'pending' },
          { id: 'ignored-effect-proposal', toolName: 'pantry_remove', arguments: JSON.stringify({ name: ignoredEffectName }), status: 'pending' }
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
  const ownerAudit = createAudit();
  const ownerSecondAudit = createAudit();
  const memberAudit = createAudit();
  const viewerAudit = createAudit();
  const outsiderAudit = createAudit();
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
    await openSettings(owner);
    await configureApi(owner, apiUrlFor('owner'));
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
    let ignoredEffectPantryId = null;
    let ignoredEffectMutationId = null;
    let ignoredEffectResponseStatus = null;
    let ignoredEffectOperationStatus = null;
    let ignoredEffectServerDeleteStatus = null;
    const ignoredEffectMutationIds = new Set();
    let shoppingPurchaseRequestCount = 0;
    let shoppingPurchaseResponseStatus = null;
    let shoppingPurchaseResponseLost = false;
    let allowShoppingPurchaseRetryAfterReload = false;
    let shoppingPurchaseMutationId = null;
    const shoppingPurchaseMutationIds = new Set();
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

      const ignoredProposalEffect = operations.find((operation) => (
        operation?.type === 'pantry.delete' && operation.id === ignoredEffectPantryId
      ));
      if (ignoredProposalEffect) {
        ignoredEffectMutationId = request.mutationId;
        if (typeof request.mutationId === 'string') ignoredEffectMutationIds.add(request.mutationId);
        const targetSpaceId = new URL(route.request().url()).pathname.match(/^\/v1\/spaces\/([^/]+)\/content\/mutations$/)?.[1];
        if (!targetSpaceId) throw new Error('The ignored Chef effect request did not include its workspace path.');
        const token = await storedSessionToken(owner);
        if (!token) throw new Error('The owner session token was unavailable for the local race fixture.');
        const deleteResponse = await fetch(`${apiUrlFor('owner')}/v1/spaces/${targetSpaceId}/content/mutations`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            mutationId: `${request.mutationId}-race-delete`,
            operations: [{ opId: 'ignored-effect-race-delete-op', type: 'pantry.delete', id: ignoredEffectPantryId }]
          })
        });
        const deleteBody = await deleteResponse.json();
        ignoredEffectServerDeleteStatus = deleteResponse.status;
        if (deleteResponse.status !== 200 || deleteBody.operations?.[0]?.status !== 'applied') {
          throw new Error(`Could not create the server-side removal race for the ignored Chef effect: ${JSON.stringify({ status: deleteResponse.status, result: deleteBody.operations?.[0] })}`);
        }
        const effectResponse = await route.fetch();
        const effectBody = await effectResponse.json();
        ignoredEffectResponseStatus = effectResponse.status();
        ignoredEffectOperationStatus = effectBody.operations?.find((result) => result.opId === ignoredProposalEffect.opId)?.status ?? null;
        await route.fulfill({ response: effectResponse, body: JSON.stringify(effectBody) });
        return;
      }

      const shoppingPurchase = operations.find((operation) => operation?.type === 'shopping.purchase');
      if (shoppingPurchase) {
        shoppingPurchaseRequestCount += 1;
        shoppingPurchaseMutationId = request.mutationId;
        if (typeof request.mutationId === 'string') shoppingPurchaseMutationIds.add(request.mutationId);
        if (shoppingPurchaseRequestCount === 1) {
          const response = await route.fetch();
          shoppingPurchaseResponseStatus = response.status();
          if (!response.ok()) {
            await route.fulfill({ response });
            return;
          }
          shoppingPurchaseResponseLost = true;
          await route.abort('failed');
          return;
        }
        if (!allowShoppingPurchaseRetryAfterReload) {
          await route.abort('failed');
          return;
        }
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
        deniedEffectMutationIds.add(request.mutationId);
        deniedEffectMutationId ??= request.mutationId;
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

    ignoredEffectPantryId = `ignored-effect-pantry-${runId}`;
    const ownerTokenForSeed = await storedSessionToken(owner);
    expect(ownerTokenForSeed).toBeTruthy();
    const ownerSpacesResponse = await fetch(`${apiUrlFor('owner')}/v1/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${ownerTokenForSeed}` }
    });
    const ownerSpacesBody = await ownerSpacesResponse.json();
    expect(ownerSpacesResponse.status).toBe(200);
    const ignoredEffectSpaceId = ownerSpacesBody.spaces?.find((space) => space.kind === 'household' && space.name === householdName)?.id;
    expect(ignoredEffectSpaceId).toBeTruthy();
    const seedResponse = await fetch(`${apiUrlFor('owner')}/v1/spaces/${ignoredEffectSpaceId}/content/mutations`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${ownerTokenForSeed}` },
      body: JSON.stringify({
        mutationId: `ignored-effect-seed-${runId}`,
        operations: [{ opId: `ignored-effect-seed-op-${runId}`, type: 'pantry.upsert', id: ignoredEffectPantryId, name: ignoredEffectName, preference: 3 }]
      })
    });
    const seedBody = await seedResponse.json();
    expect(seedResponse.status).toBe(200);
    expect(seedBody.operations?.[0]?.status).toBe('applied');
    await expect(owner.getByText(ignoredEffectName, { exact: true })).toBeVisible({ timeout: 30_000 });
    const ignoredStatusCountBefore = statusRequestCount;
    await openChefWorkspace(owner);
    const ignoredEffectCard = proposalCard(owner, ignoredEffectName);
    await expect(ignoredEffectCard.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
    await ignoredEffectCard.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(() => ignoredEffectResponseStatus, { timeout: 30_000 }).toBe(200);
    expect(ignoredEffectServerDeleteStatus).toBe(200);
    expect(ignoredEffectOperationStatus).toBe('ignored');
    expect(ignoredEffectMutationId).toBeTruthy();
    expect([...ignoredEffectMutationIds]).toEqual([ignoredEffectMutationId]);
    expect(statusRequestCount).toBe(ignoredStatusCountBefore);
    expect(proposalStatusOperations.some((operation) => operation.proposalId === 'ignored-effect-proposal')).toBe(false);
    await openSettings(owner, true, householdName);
    const [ignoredEffectRecoveryDownload] = await Promise.all([
      owner.waitForEvent('download'),
      owner.getByRole('button', { name: 'Export workspace recovery file' }).click()
    ]);
    const ignoredEffectRecovery = JSON.parse(await readFile(await ignoredEffectRecoveryDownload.path(), 'utf8'));
    const ignoredEffectAction = ignoredEffectRecovery.proposalActions.find((action) => action.effect_mutation_id === ignoredEffectMutationId);
    expect(ignoredEffectAction, JSON.stringify({
      effectMutationId: ignoredEffectMutationId,
      proposalActions: ignoredEffectRecovery.proposalActions.map(({ id, space_id, effect_mutation_id, effect_op_id, stage }) => ({
        id, space_id, effect_mutation_id, effect_op_id, stage
      })),
      blockedMutationIds: ignoredEffectRecovery.blocked.map((row) => row.mutation_id),
      pendingMutationIds: ignoredEffectRecovery.pending.map((row) => row.mutation_id),
      issueTypes: ignoredEffectRecovery.issues.map((issue) => issue.issue_type),
      proposalStatus: ignoredEffectRecovery.state.chatMessages.flatMap((message) => message.proposals ?? [])
        .find((proposal) => proposal.id === 'ignored-effect-proposal')?.status ?? null
    })).toBeTruthy();
    expect(ignoredEffectAction?.stage).toBe('effect-blocked');
    expect(ignoredEffectAction?.effect_op_id).toBeTruthy();
    expect(JSON.parse(ignoredEffectAction.effect_payload_json).operations[0].opId).toBe(ignoredEffectAction.effect_op_id);
    expect(ignoredEffectRecovery.blocked.some((row) => row.mutation_id === ignoredEffectMutationId)).toBe(true);
    const ignoredProposal = [
      ...ignoredEffectRecovery.state.chatMessages,
      ...ignoredEffectRecovery.state.chatHistory.flatMap((conversation) => conversation.messages)
    ].flatMap((message) => message.proposals ?? [])
      .find((proposal) => proposal.id === ignoredEffectAction.proposal_id);
    expect(ignoredProposal?.status).toBe('pending');
    markStage('ignored Chef effect remains pending with its exact effect link and outbox body in recovery export');
    if (process.env.CONTENT_SYNC_IGNORED_EFFECT_ONLY === '1') return;

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
    await expect(owner.getByTestId('pantry-workspace-status')).toContainText('attention', { timeout: 30_000 });
    markStage('owner added the first household pantry record');

    const syncedHouseholdSpaceId = ownerAudit.mutationRequests.find((request) => (
      request.pantryUpserts.some((operation) => operation.name === sharedItem)
    ))?.spaceId;
    const sharedPantryId = ownerAudit.mutationRequests.flatMap((request) => request.pantryUpserts)
      .find((operation) => operation.name === sharedItem)?.id;
    expect(syncedHouseholdSpaceId).toBeTruthy();
    expect(sharedPantryId).toBeTruthy();
    await owner.getByRole('tab', { name: /Recipes/ }).click();
    await owner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(owner.getByTestId('shopping-local-persistence-status')).toContainText(householdName);
    await owner.getByLabel('New shopping list name').fill(concurrentShoppingListName);
    await owner.getByRole('button', { name: 'Create shopping list' }).click();
    await selectShoppingList(owner, concurrentShoppingListName);
    const shoppingSaveStatus = owner.getByTestId('shopping-local-persistence-status');
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
    await configureApi(viewer, apiUrlFor('aux'));
    await register(viewer, viewerEmail, password);
    await viewer.getByLabel('Invitation token').fill(viewerInviteToken);
    await viewer.getByRole('button', { name: 'Accept invitation' }).click();
    const viewerWorkspaceChoice = viewer.getByRole('button', { name: `Use ${householdName} for cooking` });
    await expect(viewerWorkspaceChoice).toBeVisible({ timeout: 20_000 });
    await viewerWorkspaceChoice.click();
    await expect(viewer.getByText(/^Your role here is viewer/)).toBeVisible({ timeout: 30_000 });
    await expect(viewer.getByTestId('cooking-workspace-status')).toContainText(householdName, { timeout: 30_000 });
    await expect(viewer.getByTestId('cooking-workspace-status')).not.toContainText(/opening|switching/, { timeout: 30_000 });
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
    await configureApi(outsider, apiUrlFor('aux'));
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
    await configureApi(ownerSecond, apiUrlFor('aux'));
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
    await expect(owner.getByText('Account access unverified', { exact: true })).toBeVisible({ timeout: 30_000 });
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
    await expect(owner.getByText('Account access unverified', { exact: true })).toBeVisible({ timeout: 30_000 });
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
    const deniedMutationAudit = ownerAudit.mutationRequests.flatMap((request) => request.pantryUpserts
      .filter((item) => item.name === deniedEffectName)
      .map((item) => ({ mutationId: request.mutationId, operationId: item.opId, entityId: item.id })));
    expect([...deniedEffectMutationIds], JSON.stringify(deniedMutationAudit)).toEqual([deniedEffectMutationId]);
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
    let member = await memberContext.newPage();
    auditPage(member, memberAudit);
    await member.goto(routeUrl('settings'));
    await configureApi(member, apiUrlFor('member'));
    await register(member, memberEmail, password);
    markStage('second account registered independently');
    await member.getByLabel('Invitation token').fill(inviteToken);
    await member.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(member.getByRole('button', { name: `Use ${householdName} for cooking` })).toBeVisible({ timeout: 20_000 });
    await member.getByRole('button', { name: `Use ${householdName} for cooking` }).click();
    await expect(member.getByTestId('cooking-workspace-status')).toContainText(householdName, { timeout: 30_000 });
    await expect(member.getByTestId('cooking-workspace-status')).not.toContainText(/opening|switching/, { timeout: 30_000 });
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

    // Keep an editor's same-ID edit offline while the owner deletes that row.
    // The stale upsert must be parked as a recoverable tombstone conflict.
    await memberContext.setOffline(true);
    await member.getByTestId(`pantry-item-${sharedPantryId}`)
      .getByRole('button', { name: 'Set preference to 4 out of 5' }).click();
    await expect(member.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
    await owner.getByRole('button', { name: `Remove ${sharedItem}` }).click();
    await expect(owner.getByTestId('pantry-screen').getByText(sharedItem, { exact: true })).toHaveCount(0);
    await expect.poll(() => hasAcceptedMutationWith(ownerAudit, syncedHouseholdSpaceId, (request) => (
      request.operationTypes.includes('pantry.delete')
    )), { timeout: 30_000 }).toBe(true);
    await memberContext.setOffline(false);
    await restoreAccountConnection(member, memberEmail);
    await openCookingWorkspace(member, householdName);
    await expect.poll(() => memberAudit.mutationFailures.some((failure) => (
      failure.status === 409 && failure.errorCode === 'ENTITY_TOMBSTONED'
    )), { timeout: 60_000 }).toBe(true);
    await expect(owner.getByTestId('pantry-screen').getByText(sharedItem, { exact: true })).toHaveCount(0);
    await expect(member.getByTestId('pantry-screen').getByText(sharedItem, { exact: true })).toHaveCount(0);
    await openSettings(member, true, householdName);
    const [tombstoneRecoveryDownload] = await Promise.all([
      member.waitForEvent('download'),
      member.getByRole('button', { name: 'Export workspace recovery file' }).click()
    ]);
    const tombstoneRecovery = JSON.parse(await readFile(await tombstoneRecoveryDownload.path(), 'utf8'));
    const parkedTombstoneEdit = tombstoneRecovery.blocked.some((row) => {
      try {
        return JSON.parse(row.payload_json).operations?.some((operation) => (
          operation.type === 'pantry.upsert' && operation.id === sharedPantryId
        ));
      } catch {
        return false;
      }
    });
    expect(parkedTombstoneEdit).toBe(true);
    await openCookingWorkspace(member, householdName);
    markStage('offline stale pantry edit was rejected by the tombstone and remained exportable');

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
    await expect(owner.getByText('Account access unverified', { exact: true })).toBeVisible({ timeout: 30_000 });
    await openCookingWorkspace(owner);
    await expect(owner.getByTestId('pantry-workspace-status')).toContainText('membership unverified');
    await member.goto(routeUrl('settings'));
    await expect(member.getByText('Account access unverified', { exact: true })).toBeVisible({ timeout: 30_000 });
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
    await owner.getByRole('checkbox', { name: `Check ${concurrentOwnerShoppingItem}` }).click();
    await owner.getByRole('button', { name: 'Add checked to Pantry (1)' }).click();
    await expect(owner.getByText('Purchased', { exact: true })).toHaveCount(1);

    await member.getByLabel('Ingredient and details').fill(concurrentMemberPantryItem);
    await member.getByRole('button', { name: 'Add ingredient' }).click();
    await expect(member.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toBeVisible();
    await expect(member.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally', { timeout: 30_000 });
    await member.getByRole('tab', { name: /Recipes/ }).click();
    await member.getByRole('button', { name: 'Shopping', exact: true }).click();
    await addShoppingItem(member, concurrentMemberShoppingItem, concurrentShoppingListName);
    await expect(member.getByTestId('shopping-local-persistence-status')).toContainText('Saved on this device.', { timeout: 30_000 });
    await member.getByRole('checkbox', { name: `Check ${concurrentMemberShoppingItem}` }).click();
    await member.getByRole('button', { name: 'Add checked to Pantry (1)' }).click();
    await expect(member.getByText('Purchased', { exact: true })).toHaveCount(1);

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
    await expect(owner.getByRole('checkbox', { name: `Check ${concurrentOwnerShoppingItem}` })).toHaveCount(1);
    await expect(owner.getByRole('checkbox', { name: `Check ${concurrentMemberShoppingItem}` })).toHaveCount(0);
    await member.getByRole('tab', { name: /Recipes/ }).click();
    await member.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(member.getByRole('checkbox', { name: `Check ${concurrentMemberShoppingItem}` })).toHaveCount(1);
    await expect(member.getByRole('checkbox', { name: `Check ${concurrentOwnerShoppingItem}` })).toHaveCount(0);
    await expect(member.getByText('Purchased', { exact: true })).toHaveCount(1);
    markStage('owner and editor kept independent pantry and shopping purchases through offline reloads');

    await Promise.all([ownerContext.setOffline(false), memberContext.setOffline(false)]);
    await Promise.all([restoreAccountConnection(owner, ownerEmail), restoreAccountConnection(member, memberEmail)]);
    await openCookingWorkspace(owner, householdName);
    await expect.poll(() => shoppingPurchaseResponseLost && shoppingPurchaseResponseStatus === 200, { timeout: 90_000 }).toBe(true);
    await expect.poll(() => hasAcceptedMutationWith(memberAudit, syncedHouseholdSpaceId, (request) => (
      request.shoppingPurchases.length > 0
    )), { timeout: 90_000 }).toBe(true);
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

    await openCookingWorkspace(member, householdName);
    await expect.poll(() => (
      hasAcceptedMutationWith(memberAudit, syncedHouseholdSpaceId, (request) => (
        request.pantryUpserts.some((operation) => operation.name === concurrentMemberPantryItem)
      ))
      && hasAcceptedMutationWith(memberAudit, syncedHouseholdSpaceId, (request) => (
        request.shoppingItemOperations.some((operation) => operation.name === concurrentMemberShoppingItem)
      ))
    ), { timeout: 90_000 }).toBe(true);
    const lostPurchaseId = shoppingPurchaseMutationId;
    expect(lostPurchaseId).toBeTruthy();
    expect([...shoppingPurchaseMutationIds]).toEqual([lostPurchaseId]);
    const purchaseRetryReload = owner.reload();
    allowShoppingPurchaseRetryAfterReload = true;
    await purchaseRetryReload;
    await restoreAccountConnection(owner, ownerEmail);
    await openCookingWorkspace(owner, householdName);
    await expect.poll(() => hasAcceptedMutationWith(ownerAudit, syncedHouseholdSpaceId, (request) => (
      request.mutationId === lostPurchaseId && request.shoppingPurchases.length > 0
    )), { timeout: 90_000 }).toBe(true);
    expect(shoppingPurchaseRequestCount).toBeGreaterThanOrEqual(2);
    expect(new Set(mutationAttempts.get(lostPurchaseId)).size).toBe(1);
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentOwnerPantryItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await expect(owner.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await expect(member.getByTestId('pantry-screen').getByText(concurrentOwnerPantryItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });
    await expect(member.getByTestId('pantry-screen').getByText(concurrentMemberPantryItem, { exact: true })).toHaveCount(1, { timeout: 90_000 });

    await owner.getByRole('tab', { name: /Recipes/ }).click();
    await owner.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(owner.getByRole('checkbox', { name: `Check ${concurrentOwnerShoppingItem}` })).toHaveCount(1, { timeout: 90_000 });
    await expect(owner.getByRole('checkbox', { name: `Check ${concurrentMemberShoppingItem}` })).toHaveCount(1, { timeout: 90_000 });
    await member.getByRole('tab', { name: /Recipes/ }).click();
    await member.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect(member.getByRole('checkbox', { name: `Check ${concurrentOwnerShoppingItem}` })).toHaveCount(1, { timeout: 90_000 });
    await expect(member.getByRole('checkbox', { name: `Check ${concurrentMemberShoppingItem}` })).toHaveCount(1, { timeout: 90_000 });
    await expect(owner.getByText('Purchased', { exact: true })).toHaveCount(2, { timeout: 90_000 });
    await expect(member.getByText('Purchased', { exact: true })).toHaveCount(2, { timeout: 90_000 });
    markStage('concurrent purchases converged once, and the exact owner purchase mutation survived a lost response and reload');

    await addShoppingItem(owner, staleCycleShoppingItem, concurrentShoppingListName);
    await expect.poll(() => hasAcceptedMutationWith(ownerAudit, syncedHouseholdSpaceId, (request) => (
      request.shoppingItemOperations.some((operation) => operation.name === staleCycleShoppingItem)
    )), { timeout: 90_000 }).toBe(true);
    await expect(member.getByText(staleCycleShoppingItem, { exact: true })).toBeVisible({ timeout: 90_000 });
    const staleCycleItem = ownerAudit.mutationRequests.flatMap((request) => request.shoppingItemOperations)
      .find((operation) => operation.name === staleCycleShoppingItem);
    expect(staleCycleItem?.id).toBeTruthy();
    expect(staleCycleItem?.purchaseCycleId).toBeTruthy();

    await memberContext.setOffline(true);
    await member.reload();
    await expect(member.getByText(staleCycleShoppingItem, { exact: true })).toBeVisible({ timeout: 30_000 });
    await owner.getByRole('button', { name: 'Start new purchase cycle' }).click();
    await expect(owner.getByText('A new purchase cycle has started.', { exact: true })).toBeVisible();
    await expect.poll(() => hasAcceptedMutationWith(ownerAudit, syncedHouseholdSpaceId, (request) => (
      request.operationTypes.includes('shopping.cycle.start')
    )), { timeout: 90_000 }).toBe(true);
    const newPurchaseCycleId = ownerAudit.mutationRequests.flatMap((request) => request.shoppingCycleStarts)
      .at(-1)?.cycleId;
    expect(newPurchaseCycleId).toBeTruthy();
    expect(newPurchaseCycleId).not.toBe(staleCycleItem.purchaseCycleId);

    await member.getByRole('checkbox', { name: `Check ${staleCycleShoppingItem}` }).click();
    await expect(member.getByTestId('shopping-local-persistence-status')).toContainText('Saved on this device.', { timeout: 30_000 });
    await memberContext.setOffline(false);
    await restoreAccountConnection(member, memberEmail);
    await openCookingWorkspace(member, householdName);
    await member.getByRole('tab', { name: /Recipes/ }).click();
    await member.getByRole('button', { name: 'Shopping', exact: true }).click();
    await expect.poll(() => memberAudit.mutationResults?.some((result) => (
      result.status === 200 && result.operations.some((operation) => (
        operation.status === 'ignored' && operation.reason === 'stale_cycle'
      ))
    )), { timeout: 90_000 }).toBe(true);
    await expect(member.getByRole('checkbox', { name: `Check ${staleCycleShoppingItem}` })).toHaveAttribute('aria-checked', 'false', { timeout: 90_000 });
    await expect(owner.getByTestId('pantry-screen').getByText(staleCycleShoppingItem, { exact: true })).toHaveCount(0);
    markStage('old-cycle check was ignored after the owner advanced the shared list');

    await owner.getByRole('button', { name: 'Remove list', exact: true }).click();
    await owner.getByRole('button', { name: 'Confirm remove list', exact: true }).click();
    await expect(owner.getByLabel('New shopping list name')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => hasAcceptedMutationWith(ownerAudit, syncedHouseholdSpaceId, (request) => (
      request.operationTypes.includes('shopping.list.remove')
    )), { timeout: 90_000 }).toBe(true);
    await expect(member.getByLabel('New shopping list name')).toBeVisible({ timeout: 90_000 });
    await openSettings(owner, true, householdName);
    const [removedListRecoveryDownload] = await Promise.all([
      owner.waitForEvent('download'),
      owner.getByRole('button', { name: 'Export workspace recovery file' }).click()
    ]);
    const removedListRecovery = JSON.parse(await readFile(await removedListRecoveryDownload.path(), 'utf8'));
    const removedHouseholdList = removedListRecovery.state.shopping.lists.find((list) => (
      list.id === ownerAudit.mutationRequests.flatMap((request) => request.shoppingPurchases)
        .find((purchase) => purchase.listId)?.listId
    ));
    expect(removedHouseholdList?.removedAt).toBeTruthy();
    expect(removedListRecovery.state.shopping.purchases).toHaveLength(2);
    await openCookingWorkspace(owner, householdName);
    markStage('shared shopping-list tombstone synced while its two purchase-ledger rows stayed in recovery data');

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
    }, { api: apiUrlFor('member'), token: originalMemberToken, spaceId: householdSpaceId, itemName: offlineMemberItem, uniqueId: runId });
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

    await owner.goto(routeUrl('settings'));
    await owner.getByRole('button', { name: `View members of ${householdName}` }).click();
    await owner.getByLabel(`Invitation email for ${householdName}`).fill(memberEmail);
    await owner.getByRole('button', { name: 'Invite as editor' }).click();
    await owner.getByRole('button', { name: `Invite member to ${householdName}` }).click();
    const reInviteToken = await owner.getByLabel('One-time invitation token').inputValue();
    expect(reInviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await member.goto(routeUrl('settings'));
    await member.getByLabel('Invitation token').fill(reInviteToken);
    await member.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(member.getByRole('button', { name: `Use ${householdName} for cooking` })).toBeVisible({ timeout: 30_000 });
    await member.getByRole('button', { name: `Use ${householdName} for cooking` }).click();
    await expect(member.getByTestId('cooking-workspace-status')).toContainText(householdName, { timeout: 30_000 }).catch(async (error) => {
      const messages = (await member.locator('body').innerText()).split(/\n+/u)
        .map((line) => line.trim())
        .filter((line) => /workspace|membership|account|session|error|failed|local copy/i.test(line));
      throw new Error(`${error.message}\nReinvitation recovery state: ${JSON.stringify(messages)}`);
    });
    await expect(member.getByTestId('cooking-workspace-status')).not.toContainText(/opening|switching/, { timeout: 30_000 });
    await openCookingWorkspace(member, householdName);
    await expect(member.getByTestId('pantry-screen').getByText(memberItem, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(member.getByTestId('pantry-screen').getByText(offlineMemberItem, { exact: true })).toHaveCount(0);
    markStage('the removed account regained authorized household rows after a new invitation without resubmitting its old pending edit');

    // Delete only this member's PowerSync profile database. The separate
    // account/session database remains available so accepted server rows can
    // be fetched again after a real app restart.
    const resetSessionToken = await storedSessionToken(member);
    const resetProfile = await member.evaluate(async ({ api, token }) => {
      const response = await fetch(`${api}/v1/me`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' });
      const body = await response.json();
      const profileId = body?.user?.id;
      const databaseNames = (await indexedDB.databases()).map((database) => database.name).filter(Boolean);
      const profileDatabase = databaseNames.find((name) => name.endsWith('.db') && name.includes(profileId));
      return { profileId, profileDatabase };
    }, { api: apiUrlFor('member'), token: resetSessionToken });
    expect(resetProfile.profileDatabase).toBeTruthy();
    await member.close();
    member = await memberContext.newPage();
    auditPage(member, memberAudit);
    await member.addInitScript((databaseName) => {
      const resetMarker = `creative-cooking-profile-reset:${databaseName}`;
      if (window.name === resetMarker) {
        window.__contentProfileReset = 'already-done';
        return;
      }
      window.name = resetMarker;
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => { window.__contentProfileReset = 'done'; };
      request.onerror = () => { window.__contentProfileReset = 'failed'; };
      request.onblocked = () => { window.__contentProfileReset = 'blocked'; };
    }, resetProfile.profileDatabase);
    await member.goto(routeUrl('settings'));
    await expect.poll(() => member.evaluate(() => window.__contentProfileReset)).toBe('done');
    await expect(member.getByText(`Signed in as ${memberEmail}`, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(member.getByRole('button', { name: `Use ${householdName} for cooking` })).toBeVisible({ timeout: 30_000 });
    await member.getByRole('button', { name: `Use ${householdName} for cooking` }).click();
    await expect(member.getByTestId('cooking-workspace-status')).toContainText(householdName, { timeout: 30_000 });
    await expect(member.getByTestId('cooking-workspace-status')).not.toContainText(/opening|switching/, { timeout: 30_000 });
    await openCookingWorkspace(member, householdName);
    await expect(member.getByTestId('pantry-screen').getByText(memberItem, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(member.getByTestId('pantry-screen').getByText(sharedItem, { exact: true })).toHaveCount(0);
    markStage('cleared account content profile resynced the acknowledged household rows while respecting the server tombstone');

    await member.goto(routeUrl('settings'));
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
      'Failed to load resource: the server responded with a status of 409 (Conflict)',
      'Failed to load resource: the server responded with a status of 429 (Too Many Requests)',
      'falling back to ArrayBuffer instantiation'
    ]);
    const expectedWasmStreamingMessages = new Set([
      'wasm streaming compile failed: TypeError: Failed to fetch',
      'wasm streaming compile failed: TypeError: WebAssembly compilation aborted: Network error: Response body loading was aborted'
    ]);
    const unexpectedConsoleErrors = browserAudits.flatMap((audit) => audit.consoleErrorMessages
      .filter((message) => !expectedWasmStreamingMessages.has(message)
        && !expectedConsoleMessages.has(message)
        && !message.startsWith('[PowerSync]: Sync error AccountApiError: Too many requests. Please try again later.')));
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
      const tombstoneConflicts = audit.mutationFailures.filter((failure) => failure.status === 409).length;
      const rateLimitResponses = audit.rateLimitResponses.length;
      const credentialRateLimitLogs = audit.consoleErrorMessages.filter((message) => (
        message.startsWith('[PowerSync]: Sync error AccountApiError: Too many requests. Please try again later.')
      )).length;
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
      expect(count('Failed to load resource: the server responded with a status of 409 (Conflict)')).toBeLessThanOrEqual(tombstoneConflicts);
      expect(count('Failed to load resource: the server responded with a status of 429 (Too Many Requests)')).toBeLessThanOrEqual(rateLimitResponses);
      expect(credentialRateLimitLogs).toBeLessThanOrEqual(rateLimitResponses);
      expect(wasmStreamingFailures).toBeLessThanOrEqual(abortedWasmLoads);
      expect(count('falling back to ArrayBuffer instantiation')).toBe(wasmStreamingFailures);
    }

    for (const audit of browserAudits) {
      const rejectedMutations = audit.mutationFailures.filter((failure) => failure.status === 429);
      for (const rejectedMutation of rejectedMutations) {
        const exactRetry = audit.mutationResponses.find((response) => (
          response.mutationId === rejectedMutation.mutationId
            && response.spaceId === rejectedMutation.spaceId
            && response.status === 200
        ));
        expect(exactRetry?.payloadHash, `rate-limited mutation ${rejectedMutation.mutationId} must receive an exact accepted retry`).toBe(rejectedMutation.payloadHash);
      }
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

test('recipe conflicts preserve both versions and allow a restart-safe copy resolution', async ({ browser }) => {
  test.skip(!enabled, 'Set CONTENT_SYNC_E2E=1 and start the local API and PowerSync Service to run this acceptance path.');
  test.setTimeout(300_000);

  const runId = `${process.env.CONTENT_SYNC_RUN_ID ?? `cc-recipe-${Date.now()}`}-recipe-${randomBytes(4).toString('hex')}`;
  const ownerEmail = `${runId}-owner@example.test`;
  const memberEmail = `${runId}-editor@example.test`;
  const password = randomBytes(24).toString('base64url');
  const householdName = `Recipe Conflict ${runId.slice(-8)}`;
  const baseTitle = `Shared base ${runId.slice(-8)}`;
  const ownerTitle = `Owner version ${runId.slice(-8)}`;
  const memberTitle = `Editor version ${runId.slice(-8)}`;
  const at = '2026-10-15T10:00:00.000Z';
  const guestState = {
    pantry: [],
    recipes: [{
      id: 'conflict-base-recipe',
      title: baseTitle,
      description: 'Shared starting description.',
      portions: 2,
      ingredients: [{ id: 'same-scoped-ingredient', name: 'lentils', amount: '1 cup' }],
      steps: ['Soak the lentils.', 'Cook until soft.'],
      stepIds: ['same-scoped-step-one', 'same-scoped-step-two'],
      notes: ['Shared starting note.'],
      createdAt: at,
      updatedAt: at
    }],
    chatMessages: [],
    chatHistory: [],
    activeConversationId: null,
    mealContext: { willingToShop: true, portions: 2, cooks: ['medium'] },
    settings: {
      systemPrompt: '', allergies: [], sendLocalTime: false, city: '',
      providerId: 'openrouter', model: 'openrouter/free', dictationEngine: 'browser'
    }
  };
  const ownerAudit = createAudit();
  const memberAudit = createAudit();
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

  try {
    await ownerContext.addInitScript((state) => {
      if (window.localStorage.getItem('creative-cooking-state-v1') === null) {
        window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify(state));
      }
    }, guestState);
    const owner = await ownerContext.newPage();
    auditPage(owner, ownerAudit);
    await owner.goto(routeUrl('settings'));
    await configureApi(owner);
    await register(owner, ownerEmail, password);

    await owner.getByLabel('Household name').fill(householdName);
    await owner.getByRole('button', { name: 'Create household' }).click();
    const ownerHouseholdChoice = owner.getByRole('button', { name: `Use ${householdName} for cooking` });
    await expect(ownerHouseholdChoice).toBeVisible({ timeout: 30_000 });
    await ownerHouseholdChoice.click();
    await expect(owner.getByTestId('cooking-workspace-status')).toContainText(householdName, { timeout: 30_000 });
    await owner.getByRole('button', { name: `Merge local cooking into ${householdName}` }).click();
    await expect(owner.getByText('Local cooking records were merged into this workspace. The original local copy remains saved.')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => ownerAudit.mutationRequests.some((request) => (
      request.recipeSaves.some((save) => save.title === baseTitle)
        && ownerAudit.mutationResponses.some((response) => response.mutationId === request.mutationId && response.status === 200)
    )), { timeout: 90_000 }).toBe(true);

    await owner.goto(routeUrl('recipes'));
    await expect(owner.getByRole('button', { name: `Open recipe ${baseTitle}` })).toBeVisible({ timeout: 30_000 });
    await openSettings(owner, true, householdName);
    await owner.getByRole('button', { name: `View members of ${householdName}` }).click();
    await owner.getByLabel(`Invitation email for ${householdName}`).fill(memberEmail);
    await owner.getByRole('button', { name: 'Invite as editor' }).click();
    await owner.getByRole('button', { name: `Invite member to ${householdName}` }).click();
    const inviteToken = await owner.getByLabel('One-time invitation token').inputValue();
    expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const member = await memberContext.newPage();
    auditPage(member, memberAudit);
    await member.goto(routeUrl('settings'));
    await configureApi(member);
    await register(member, memberEmail, password);
    await member.getByLabel('Invitation token').fill(inviteToken);
    await member.getByRole('button', { name: 'Accept invitation' }).click();
    await member.getByRole('button', { name: `Use ${householdName} for cooking` }).click();
    await expect(member.getByText(/Your role here is editor/)).toBeVisible({ timeout: 30_000 });

    for (const [clientName, page] of [['owner', owner], ['member', member]]) {
      await page.goto(routeUrl('recipes'));
      await expect(page.getByRole('button', { name: `Open recipe ${baseTitle}` })).toBeVisible({ timeout: 90_000 });
      await page.goto(routeUrl('settings'));
      await expect(page.getByTestId('cooking-workspace-status')).toContainText('synced', { timeout: 90_000 });
      await page.goto(routeUrl('recipes'));
      await expect(page.getByRole('button', { name: `Open recipe ${baseTitle}` }), `${clientName} should retain the shared recipe before disconnecting`).toBeVisible({ timeout: 30_000 });
    }

    await ownerContext.setOffline(true);
    await memberContext.setOffline(true);
    const editRecipe = async (page, title, description, ingredient, step, note) => {
      await page.getByLabel(`Open recipe ${baseTitle}`).click();
      await expect(page.getByLabel('Close recipe')).toBeVisible({ timeout: 30_000 });
      await page.getByLabel(`Edit recipe ${baseTitle}`).click();
      await expect(page.getByLabel('Recipe title')).toBeVisible({ timeout: 30_000 });
      await page.getByLabel('Recipe title').fill(title);
      await page.getByLabel('Recipe description').fill(description);
      await page.getByLabel('Recipe ingredients').fill(`1 cup ${ingredient}\n1 tbsp olive oil`);
      await page.getByLabel('Recipe method').fill(`1. ${step}\n2. Simmer until tender.`);
      await page.getByLabel('Recipe notes').fill(note);
      await page.getByLabel('Save recipe changes').click();
      await expect(page.getByRole('dialog').getByText(title, { exact: true })).toBeVisible();
      await page.getByLabel('Close recipe').click();
    };
    await editRecipe(owner, ownerTitle, 'Owner description retained.', 'owner lentils', 'Owner method retained.', 'Owner note retained.');
    await editRecipe(member, memberTitle, 'Editor description retained.', 'editor lentils', 'Editor method retained.', 'Editor note retained.');
    await owner.reload();
    await member.reload();
    await expect(owner.getByRole('button', { name: `Open recipe ${ownerTitle}` })).toBeVisible({ timeout: 30_000 });
    await expect(member.getByRole('button', { name: `Open recipe ${memberTitle}` })).toBeVisible({ timeout: 30_000 });
    markStage('both editors changed the same shared recipe offline and retained their local edits through reload');

    await ownerContext.setOffline(false);
    await restoreAccountConnection(owner, ownerEmail);
    const ownerAccepted = (request) => request.recipeSaves.some((save) => save.title === ownerTitle);
    await expect.poll(() => ownerAudit.mutationRequests.some((request) => (
      ownerAccepted(request) && ownerAudit.mutationResponses.some((response) => response.mutationId === request.mutationId && response.status === 200)
    )), { timeout: 90_000 }).toBe(true);
    const ownerSave = ownerAudit.mutationRequests.find(ownerAccepted)?.recipeSaves.find((save) => save.title === ownerTitle);
    expect(ownerSave?.baseVersion).toBe(1);

    await memberContext.setOffline(false);
    await restoreAccountConnection(member, memberEmail);
    const memberAttempt = (request) => request.recipeSaves.some((save) => save.title === memberTitle);
    await expect.poll(() => memberAudit.mutationFailures.some((failure) => (
      failure.errorCode === 'RECIPE_VERSION_CONFLICT'
        && memberAudit.mutationRequests.some((request) => request.mutationId === failure.mutationId && memberAttempt(request))
    )), { timeout: 90_000 }).toBe(true);
    const attemptedSave = memberAudit.mutationRequests.find(memberAttempt)?.recipeSaves.find((save) => save.title === memberTitle);
    expect(attemptedSave?.recipeId).toBe(ownerSave?.recipeId);
    expect(attemptedSave?.baseVersion).toBe(1);

    await member.goto(routeUrl('settings'));
    const conflictCard = member.locator('[data-testid^="recipe-conflict-"]').first();
    await expect(conflictCard).toBeVisible({ timeout: 30_000 });
    await expect(conflictCard).toContainText(memberTitle);
    await expect(conflictCard).toContainText('Editor description retained.');
    await expect(conflictCard).toContainText(ownerTitle);
    await expect(conflictCard).toContainText('Owner description retained.');
    await expect(member.getByTestId('cooking-workspace-status')).toContainText('attention');
    await conflictCard.getByRole('button', { name: 'Save my version as a new recipe' }).click();
    await expect(conflictCard.getByText('Your version is saved as a separate recipe.')).toBeVisible();
    await expect(member.getByText('Local cooking changes are saved on this device.', { exact: true })).toBeVisible({ timeout: 30_000 });
    markStage('the stale recipe response showed both full versions and the member saved the attempted version as a new recipe');

    await memberContext.setOffline(true);
    await member.goto(routeUrl('recipes'));
    await expect(member.getByRole('button', { name: `Open recipe ${memberTitle}` })).toBeVisible();
    await member.reload();
    await expect(member.getByRole('button', { name: `Open recipe ${memberTitle}` })).toBeVisible({ timeout: 30_000 });
    await member.goto(routeUrl('settings'));
    const restoredConflict = member.locator('[data-testid^="recipe-conflict-"]').first();
    await expect(restoredConflict).toBeVisible();
    await expect(restoredConflict.getByText('Your version is saved as a separate recipe.')).toBeVisible();
    await restoredConflict.getByRole('button', { name: 'Keep workspace version' }).click();
    await expect(member.locator('[data-testid^="recipe-conflict-"]')).toHaveCount(0);
    await member.goto(routeUrl('recipes'));
    await expect(member.getByRole('button', { name: `Open recipe ${ownerTitle}` })).toBeVisible({ timeout: 30_000 });
    await member.reload();
    await expect(member.getByRole('button', { name: `Open recipe ${ownerTitle}` })).toBeVisible({ timeout: 30_000 });

    await member.goto(routeUrl('settings'));
    await expect(member.getByTestId('cooking-workspace-status')).toContainText('offline unverified', { timeout: 30_000 });
    await expect(member.getByTestId('cooking-workspace-status')).toContainText('membership unverified');
    const [recoveryDownload] = await Promise.all([
      member.waitForEvent('download'),
      member.getByRole('button', { name: 'Export workspace recovery file' }).click()
    ]);
    const recovery = JSON.parse(await readFile(await recoveryDownload.path(), 'utf8'));
    expect(Array.isArray(recovery.blocked)).toBe(true);
    const attemptedConflictIsRecoverable = recovery.blocked.some((row) => {
      try {
        return JSON.parse(row.payload_json).operations.some((operation) => (
          operation.type === 'recipe.save' && operation.recipe?.title === memberTitle
        ));
      } catch { return false; }
    });
    expect(attemptedConflictIsRecoverable).toBe(true);
    markStage('the chosen workspace recipe survived offline reload, while the original blocked request remained exportable');

    await memberContext.setOffline(false);
    await restoreAccountConnection(member, memberEmail);
    await expect.poll(() => memberAudit.mutationRequests.some((request) => (
      request.recipeSaves.some((save) => save.title === memberTitle && save.recipeId !== ownerSave?.recipeId && save.baseVersion === null)
        && memberAudit.mutationResponses.some((response) => response.mutationId === request.mutationId && response.status === 200)
    )), { timeout: 90_000 }).toBe(true);

    await owner.goto(routeUrl('recipes'));
    await expect(owner.getByRole('button', { name: `Open recipe ${ownerTitle}` })).toBeVisible({ timeout: 90_000 });
    await expect(owner.getByRole('button', { name: `Open recipe ${memberTitle}` })).toBeVisible({ timeout: 90_000 });
    await member.goto(routeUrl('recipes'));
    await expect(member.getByRole('button', { name: `Open recipe ${ownerTitle}` })).toBeVisible({ timeout: 90_000 });
    await expect(member.getByRole('button', { name: `Open recipe ${memberTitle}` })).toBeVisible({ timeout: 90_000 });
    expect(memberAudit.mutationRequests.some((request) => request.recipeSaves.some((save) => save.title === ownerTitle))).toBe(false);
    expect(ownerAudit.pageErrors + memberAudit.pageErrors).toBe(0);
    markStage('the accepted workspace recipe and the editor recovery copy converged to both clients');
  } finally {
    await Promise.allSettled([memberContext.close(), ownerContext.close()]);
  }
});

test('rate-limited session restoration keeps membership unverified and allows an explicit retry', async ({ browser }) => {
  test.skip(!enabled, 'Set CONTENT_SYNC_E2E=1 and start the local API to run this account recovery path.');
  test.setTimeout(90_000);

  const runId = `${process.env.CONTENT_SYNC_RUN_ID ?? `cc-account-${Date.now()}`}-rate-${randomBytes(4).toString('hex')}`;
  const email = `${runId}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    await page.goto(routeUrl('settings'));
    await configureApi(page);
    await register(page, email, password);
    const savedToken = await storedSessionToken(page);
    expect(savedToken).toBeTruthy();

    let rejectNextMe = true;
    await page.route(`${apiUrl}/v1/me`, async (route) => {
      if (!rejectNextMe) return route.continue();
      rejectNextMe = false;
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } })
      });
    });
    await page.reload();
    await expect(page.getByText('Account access unverified', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Sign out from saved session', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use Personal for cooking' })).toHaveCount(0);
    expect(await storedSessionToken(page)).toBe(savedToken);

    await page.unroute(`${apiUrl}/v1/me`);
    await page.getByRole('button', { name: 'Check account connection' }).click();
    await expect(page.getByText(`Signed in as ${email}`, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('cooking-workspace-status')).toContainText('Personal', { timeout: 30_000 });
    expect(await storedSessionToken(page)).toBe(savedToken);
  } finally {
    await context.close();
  }
});
