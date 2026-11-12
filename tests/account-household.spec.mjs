import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';

const test = base.extend({
  browser: async ({ playwright }, use) => {
    const browser = await playwright.chromium.connectOverCDP(
      process.env.ACCOUNT_TEST_BROWSER_CDP ?? 'http://127.0.0.1:9222'
    );
    try {
      await use(browser);
    } finally {
      await browser.close();
    }
  }
});

test.use({ trace: 'off' });

const apiUrl = process.env.ACCOUNT_TEST_API_URL;
if (!apiUrl) throw new Error('Set ACCOUNT_TEST_API_URL to the local API base URL before running the account household acceptance test.');

const appUrl = process.env.ACCOUNT_TEST_APP_URL ?? 'http://127.0.0.1:4173/creative-cooking/';

async function configureApi(page) {
  await page.goto(`${appUrl}settings`);
  await expect(page.getByRole('heading', { name: 'Account & sharing' })).toBeVisible();
  const apiField = page.getByLabel('API base URL');
  if (await apiField.inputValue() !== apiUrl) {
    await apiField.fill(apiUrl);
    await page.getByRole('button', { name: 'Save API URL' }).click();
  }
}

async function register(page, email, password) {
  await page.getByRole('button', { name: 'Create account mode' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText(`Signed in as ${email}`, { exact: true })).toBeVisible();
}

async function storedToken(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('creative-cooking-account', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const session = await new Promise((resolve, reject) => {
      const transaction = database.transaction('session', 'readonly');
      const request = transaction.objectStore('session').get('current');
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return session?.token ?? null;
  });
}

async function callApi(page, token, path, method = 'GET', body) {
  return page.evaluate(async ({ base, bearer, route, verb, payload }) => {
    const response = await fetch(`${base}/v1${route}`, {
      method: verb,
      headers: {
        Accept: 'application/json',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${bearer}`
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      credentials: 'omit',
      redirect: 'error'
    });
    const raw = response.status === 204 ? null : await response.json();
    return { status: response.status, body: raw };
  }, { base: apiUrl, bearer: token, route: path, verb: method, payload: body });
}

test('built PWA registers, restores, manages household roles, enforces revocation, and preserves local cooking data', async ({ browser }) => {
  const runId = randomUUID();
  const password = `Account-${randomUUID()}!`;
  const ownerEmail = `owner-${runId}@example.test`;
  const viewerEmail = `viewer-${runId}@example.test`;
  const outsiderEmail = `outsider-${runId}@example.test`;
  const ownerContext = await browser.newContext({ serviceWorkers: 'allow' });
  const viewerContext = await browser.newContext({ serviceWorkers: 'allow' });
  const outsiderContext = await browser.newContext({ serviceWorkers: 'allow' });
  const owner = await ownerContext.newPage();
  const viewer = await viewerContext.newPage();
  const outsider = await outsiderContext.newPage();

  try {
    // The local-only cooking path works before account configuration.
    await owner.goto(appUrl);
    await owner.getByLabel('Ingredient and details').fill('local continuity lentils');
    await owner.getByLabel('Ingredient and details').press('Enter');
    await expect(owner.getByText('local continuity lentils', { exact: true })).toBeVisible();

    await configureApi(owner);
    await register(owner, ownerEmail, password);
    await expect(owner.getByText('Personal workspace · owner')).toBeVisible();
    await expect(owner.getByText(/Cooking content is still stored on this device and is not shared yet/)).toBeVisible();

    await owner.getByLabel('Household name').fill('Weeknight kitchen');
    await owner.getByRole('button', { name: 'Create household', exact: true }).click();
    await expect(owner.getByText('Weeknight kitchen', { exact: true }).first()).toBeVisible();
    await owner.reload({ waitUntil: 'domcontentloaded' });
    await expect(owner.getByText(`Signed in as ${ownerEmail}`, { exact: true })).toBeVisible();
    await expect(owner.getByText('Weeknight kitchen', { exact: true })).toBeVisible();
    const ownerToken = await storedToken(owner);
    expect(typeof ownerToken).toBe('string');

    // The explicit session refresh rotates the browser's bearer credential.
    await owner.getByRole('button', { name: 'Refresh account session' }).click();
    await expect(owner.getByText('Session refreshed. The previous session token was revoked.')).toBeVisible();
    const rotatedOwnerToken = await storedToken(owner);
    expect(rotatedOwnerToken).not.toBe(ownerToken);
    expect((await callApi(owner, ownerToken, '/me')).status).toBe(401);
    expect((await callApi(owner, rotatedOwnerToken, '/me')).status).toBe(200);

    await owner.getByLabel('View members of Weeknight kitchen').click();
    await expect(owner.getByText(ownerEmail, { exact: false })).toBeVisible();
    await owner.getByLabel('Invitation email for Weeknight kitchen').fill(viewerEmail);
    await owner.getByLabel('Invite as viewer').click();
    await owner.getByLabel('Invite member to Weeknight kitchen').click();
    const invitationTokenField = owner.getByLabel('One-time invitation token');
    await expect(invitationTokenField).toBeVisible();
    const invitationToken = await invitationTokenField.inputValue();
    expect(invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ownerStoredSession = await owner.evaluate(async () => {
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
      return JSON.stringify(session);
    });
    expect(ownerStoredSession).not.toContain(invitationToken);

    // A second context has independent IndexedDB and no owner session.
    await configureApi(viewer);
    await expect(viewer.getByText('Not signed in', { exact: true })).toBeVisible();
    await register(viewer, viewerEmail, password);
    await viewer.getByLabel('Invitation token').fill(invitationToken);
    await viewer.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(viewer.getByText('Weeknight kitchen', { exact: true })).toBeVisible();
    await expect(viewer.getByText(/Household · viewer/)).toBeVisible();
    await viewer.getByLabel('View members of Weeknight kitchen').click();
    await expect(viewer.getByText(ownerEmail, { exact: false })).toBeVisible();
    await expect(viewer.getByLabel('Invite member to Weeknight kitchen')).toHaveCount(0);
    await expect(viewer.getByLabel(`Remove ${ownerEmail} from Weeknight kitchen`)).toHaveCount(0);

    const viewerToken = await storedToken(viewer);
    // Keep the viewer's original credential and substitute a member-only action.
    const viewerMemberships = await callApi(viewer, viewerToken, '/me');
    const household = viewerMemberships.body.spaces.find((space) => space.name === 'Weeknight kitchen');
    expect(household).toBeTruthy();
    const realViewerInviteAttempt = await callApi(viewer, viewerToken, `/spaces/${household.id}/invitations`, 'POST', {
      email: outsiderEmail,
      role: 'viewer'
    });
    expect(realViewerInviteAttempt.status).toBe(403);
    expect(realViewerInviteAttempt.body.error.code).toBe('ROLE_REQUIRED');

    const replayedInvite = await callApi(viewer, viewerToken, '/invitations/accept', 'POST', { token: invitationToken });
    expect(replayedInvite.status).toBe(409);
    expect(replayedInvite.body.error.code).toBe('INVITATION_USED');

    // A third isolated account is denied membership reads as an outsider.
    await configureApi(outsider);
    await register(outsider, outsiderEmail, password);
    const outsiderToken = await storedToken(outsider);
    const outsiderRead = await callApi(outsider, outsiderToken, `/spaces/${household.id}/members`);
    expect(outsiderRead.status).toBe(403);
    expect(outsiderRead.body.error.code).toBe('SPACE_ACCESS_DENIED');

    // Invite the unrelated account as an editor, then verify the client leave flow.
    await owner.getByLabel('Invitation email for Weeknight kitchen').fill(outsiderEmail);
    await owner.getByLabel('Invite as editor').click();
    await owner.getByLabel('Invite member to Weeknight kitchen').click();
    const secondInviteToken = await owner.getByLabel('One-time invitation token').inputValue();
    await outsider.getByLabel('Invitation token').fill(secondInviteToken);
    await outsider.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(outsider.getByText(/Household · editor/)).toBeVisible();
    await outsider.getByLabel('View members of Weeknight kitchen').click();
    await outsider.getByLabel('Leave Weeknight kitchen').click();
    await outsider.getByLabel('Confirm leave Weeknight kitchen').click();
    await expect(outsider.getByText('Weeknight kitchen', { exact: true })).toHaveCount(0);
    const leftMemberRead = await callApi(outsider, outsiderToken, `/spaces/${household.id}/members`);
    expect(leftMemberRead.status).toBe(403);
    expect(leftMemberRead.body.error.code).toBe('SPACE_ACCESS_DENIED');

    // The owner removes the viewer; the viewer's original session remains live but household access stops.
    const memberResponse = await callApi(owner, rotatedOwnerToken, `/spaces/${household.id}/members`);
    const viewerMember = memberResponse.body.members.find((member) => member.user.email === viewerEmail);
    expect(viewerMember).toBeTruthy();
    await owner.getByLabel('Hide members of Weeknight kitchen').click();
    await owner.getByLabel('View members of Weeknight kitchen').click();
    await expect(owner.getByText(viewerEmail, { exact: false })).toBeVisible();
    await owner.getByLabel(`Remove ${viewerEmail} from Weeknight kitchen`).click();
    await owner.getByLabel(`Confirm remove ${viewerEmail}`).click();
    await expect(owner.getByText(viewerEmail, { exact: false })).toHaveCount(0);
    const removedMemberRead = await callApi(viewer, viewerToken, `/spaces/${household.id}/members`);
    expect(removedMemberRead.status).toBe(403);
    expect(removedMemberRead.body.error.code).toBe('SPACE_ACCESS_DENIED');
    await viewer.getByRole('button', { name: 'Check account and household access' }).click();
    await expect(viewer.getByText('Weeknight kitchen', { exact: true })).toHaveCount(0);
    await expect(viewer.getByText(/Access to Weeknight kitchen was removed/)).toBeVisible();

    // Logout revokes the owner's original current token; sign-out never touches local app state.
    await owner.goto(`${appUrl}settings`);
    const tokenBeforeLogout = await storedToken(owner);
    await owner.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(owner.getByText('Not signed in', { exact: true })).toBeVisible();
    expect((await callApi(owner, tokenBeforeLogout, '/me')).status).toBe(401);
    await owner.goto(appUrl);
    await expect(owner.getByText('local continuity lentils', { exact: true })).toBeVisible();
  } finally {
    await Promise.all([ownerContext.close(), viewerContext.close(), outsiderContext.close()]);
  }
});
