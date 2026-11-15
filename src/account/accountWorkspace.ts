import { accountApiRequest, AccountApiError, AccountTransportError, normalizeApiUrl } from './api';
import type {
  AccountResponse,
  AccountUser,
  AccountWorkspace,
  AccountWorkspaceSnapshot,
  ContentMutationRequest,
  MeResponse,
  PowerSyncCredentialResponse,
  StoredAccountSession,
  WorkspaceInvitation,
  WorkspaceMember
} from './contracts';
import { getStoredApiUrl, getStoredPowerSyncUrl, getStoredSession, setStoredApiUrl, setStoredPowerSyncUrl, setStoredSession } from './sessionStorage';

const REFRESH_EARLY_MS = 72 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_000_000;

type RequestContext = {
  generation: number;
  apiUrl: string;
  session: StoredAccountSession | null;
};

const listeners = new Set<() => void>();
let snapshot: AccountWorkspaceSnapshot = {
  apiUrl: '',
  powerSyncUrl: '',
  status: 'loading',
  user: null,
  localProfileId: null,
  sessionEmail: null,
  spaces: [],
  busyAction: null,
  error: null,
  notice: null
};
let generation = 0;
let currentSession: StoredAccountSession | null = null;
let initialized = false;
let initialization: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let sessionPersistenceWarning: string | null = null;

export function getAccountWorkspaceSnapshot(): AccountWorkspaceSnapshot {
  return snapshot;
}

export function normalizePowerSyncServiceUrl(value: string): string {
  const configured = value.trim();
  if (!configured) return '';
  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    throw new Error('Enter a valid PowerSync Service URL.');
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
    || (endpoint.protocol === 'http:' && !isLoopback)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('The PowerSync Service URL must use HTTPS, or loopback HTTP for local development, without credentials or query parameters.');
  }
  return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}`;
}

export function subscribeAccountWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(patch: Partial<AccountWorkspaceSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function clearRefreshTimer(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}

function errorMessage(error: unknown): string {
  if (error instanceof AccountTransportError) return error.message;
  if (error instanceof AccountApiError) {
    switch (error.code) {
      case 'AUTH_INVALID_CREDENTIALS':
      case 'LOGIN_FAILED':
        return 'Email or password is incorrect.';
      case 'EMAIL_ALREADY_REGISTERED':
        return 'An account with this email already exists. Sign in instead.';
      case 'INVITATION_EMAIL_MISMATCH':
        return 'This invitation belongs to a different email address. Sign in with the invited account.';
      case 'INVITATION_EXPIRED':
        return 'This invitation has expired. Ask a household owner to send a new one.';
      case 'INVITATION_USED':
        return 'This invitation was already accepted. Check your household list.';
      case 'INVITATION_NOT_FOUND':
        return 'This invitation token is not valid. Check that it was copied in full.';
      case 'LAST_OWNER':
        return 'The last household owner cannot leave or be removed. Another owner must remain.';
      case 'ALREADY_A_MEMBER':
        return 'This account is already a member of that household.';
      case 'SPACE_ACCESS_DENIED':
        return 'You no longer have access to this household. Its membership was removed from this account view.';
      case 'ROLE_REQUIRED':
        return 'Your household role does not allow this action.';
      case 'THROTTLED':
        return 'Too many requests were made. Wait a minute before trying again.';
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return 'The account action could not be completed.';
}

function context(sessionRequired: boolean): RequestContext {
  const session = currentSession && currentSession.apiUrl === snapshot.apiUrl ? currentSession : null;
  if (!snapshot.apiUrl) throw new Error('Set an API URL before using an account.');
  if (sessionRequired && (!session || (snapshot.status !== 'signed-in' && snapshot.status !== 'offline'))) {
    throw new Error(snapshot.status === 'expired'
      ? 'This session has expired. Sign in again to continue.'
      : 'Sign in to use account and household features.');
  }
  return { generation, apiUrl: snapshot.apiUrl, session };
}

function isCurrent(requestContext: RequestContext): boolean {
  return requestContext.generation === generation && requestContext.apiUrl === snapshot.apiUrl;
}

function assertCurrent(requestContext: RequestContext): void {
  if (!isCurrent(requestContext)) throw new Error('This response belongs to an earlier account or API address and was ignored.');
}

async function request<T>(
  requestContext: RequestContext,
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; mutationLabel?: string; token?: string } = {}
): Promise<T> {
  const result = await accountApiRequest<T>(requestContext.apiUrl, path, {
    method: options.method,
    body: options.body,
    mutationLabel: options.mutationLabel,
    token: options.token ?? requestContext.session?.token
  });
  assertCurrent(requestContext);
  return result;
}

async function clearSavedSession(): Promise<void> {
  currentSession = null;
  try {
    await setStoredSession(null);
    sessionPersistenceWarning = null;
  } catch {
    // The API still enforces revocation/expiry. The error is surfaced by the caller.
  }
}

async function markExpired(requestContext: RequestContext): Promise<void> {
  if (!isCurrent(requestContext)) return;
  clearRefreshTimer();
  await clearSavedSession();
  publish({
    status: 'expired',
    user: null,
    localProfileId: requestContext.session?.userId ?? snapshot.localProfileId,
    sessionEmail: requestContext.session?.email ?? snapshot.sessionEmail,
    spaces: [],
    error: 'This account session has expired or was revoked. Sign in again to continue.',
    notice: null
  });
}

function scheduleRefresh(session: StoredAccountSession, requestContext: RequestContext): void {
  clearRefreshTimer();
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt)) return;
  const delay = Math.max(0, Math.min(expiresAt - Date.now() - REFRESH_EARLY_MS, MAX_TIMEOUT_MS));
  refreshTimer = setTimeout(() => {
    if (!isCurrent(requestContext) || snapshot.status !== 'signed-in') return;
    void refreshAccountSession().catch(() => undefined);
  }, delay);
}

async function rotateSession(requestContext: RequestContext): Promise<StoredAccountSession> {
  const previous = requestContext.session;
  if (!previous) throw new Error('Sign in before refreshing the account session.');
  let result: { session: { token: string; expiresAt: string } };
  try {
    result = await request<{ session: { token: string; expiresAt: string } }>(requestContext, '/auth/refresh', {
      method: 'POST',
      mutationLabel: 'session refresh',
      token: previous.token
    });
  } catch (error) {
    if (error instanceof AccountApiError && error.status === 401) await markExpired(requestContext);
    else if (error instanceof AccountTransportError && isCurrent(requestContext)) {
      publish({
        status: 'offline',
        error: 'The session refresh could not be confirmed. Reconnect and use Refresh session; this app will not repeat the refresh automatically.',
        notice: null
      });
    }
    throw error;
  }

  const rotated: StoredAccountSession = {
    apiUrl: requestContext.apiUrl,
    token: result.session.token,
    expiresAt: result.session.expiresAt,
    email: previous.email,
    ...(previous.userId ? { userId: previous.userId } : {})
  };
  currentSession = rotated;
  const nextContext = { ...requestContext, session: rotated };
  try {
    await setStoredSession(rotated);
    sessionPersistenceWarning = null;
  } catch {
    sessionPersistenceWarning = 'The session was refreshed, but secure storage could not save it. Keep this app open and sign out before closing it.';
    if (isCurrent(requestContext)) {
      publish({ error: sessionPersistenceWarning, notice: null });
    }
  }
  assertCurrent(requestContext);
  scheduleRefresh(rotated, nextContext);
  return rotated;
}

async function readMe(requestContext: RequestContext, allowRefresh: boolean): Promise<MeResponse> {
  const session = requestContext.session;
  if (!session) throw new Error('Sign in to refresh account information.');
  try {
    return await request<MeResponse>(requestContext, '/me', { token: session.token });
  } catch (error) {
    if (error instanceof AccountApiError && error.status === 401 && allowRefresh) {
      const rotated = await rotateSession(requestContext);
      return readMe({ ...requestContext, session: rotated }, false);
    }
    if (error instanceof AccountApiError && error.status === 401) await markExpired(requestContext);
    throw error;
  }
}

async function restore(apiUrl: string, requestGeneration: number, session: StoredAccountSession): Promise<void> {
  const requestContext: RequestContext = { generation: requestGeneration, apiUrl, session };
  currentSession = session;
  publish({ status: 'restoring', user: null, localProfileId: session.userId ?? null, sessionEmail: session.email, spaces: [], error: null, notice: null });

  try {
    let candidate = session;
    const expiry = Date.parse(candidate.expiresAt);
    if (Number.isFinite(expiry) && expiry <= Date.now() + REFRESH_EARLY_MS) {
      candidate = await rotateSession(requestContext);
    }
    const me = await readMe({ ...requestContext, session: candidate }, true);
    assertCurrent(requestContext);
    currentSession = candidate;
    publish({ status: 'signed-in', user: me.user, localProfileId: me.user.id, sessionEmail: me.user.email, spaces: me.spaces, error: sessionPersistenceWarning, notice: null });
    scheduleRefresh(candidate, { ...requestContext, session: candidate });
  } catch (error) {
    if (!isCurrent(requestContext)) return;
    if (snapshot.status === 'expired') return;
    if (error instanceof AccountTransportError) {
      publish({
        status: 'offline',
        user: null,
        localProfileId: session.userId ?? null,
        sessionEmail: session.email,
        spaces: [],
        error: 'The saved session could not be checked while offline. Household membership stays hidden until the service confirms it.',
        notice: null
      });
      return;
    }
    if (error instanceof AccountApiError && error.status !== 401) {
      publish({
        status: 'offline',
        user: null,
        localProfileId: session.userId ?? null,
        sessionEmail: session.email,
        spaces: [],
        error: errorMessage(error),
        notice: null
      });
      return;
    }
    publish({
      status: snapshot.status === 'signed-in' ? 'signed-in' : 'expired',
      user: snapshot.user,
      sessionEmail: session.email,
      spaces: snapshot.spaces,
      error: errorMessage(error),
      notice: null
    });
  }
}

export async function initializeAccountWorkspace(): Promise<void> {
  if (initialized) return;
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const [rawUrl, storedPowerSyncUrl] = await Promise.all([getStoredApiUrl(), getStoredPowerSyncUrl()]);
      const apiUrl = normalizeApiUrl(rawUrl);
      const powerSyncUrl = normalizePowerSyncServiceUrl(storedPowerSyncUrl);
      const requestGeneration = ++generation;
      clearRefreshTimer();
      publish({ apiUrl, powerSyncUrl, status: apiUrl ? 'signed-out' : 'local', user: null, localProfileId: null, sessionEmail: null, spaces: [], error: null, notice: null });
      const session = await getStoredSession();
      if (requestGeneration !== generation) return;
      if (!apiUrl) return;
      if (!session || session.apiUrl !== apiUrl) return;
      await restore(apiUrl, requestGeneration, session);
    } catch (error) {
      publish({
        status: snapshot.apiUrl ? 'signed-out' : 'local',
        error: error instanceof Error ? error.message : 'Account settings could not be loaded.'
      });
    } finally {
      initialized = true;
      initialization = null;
    }
  })();
  return initialization;
}

async function withBusy<T>(
  action: string,
  requireSession: boolean,
  operation: (requestContext: RequestContext) => Promise<T>
): Promise<T> {
  if (snapshot.busyAction) throw new Error('Another account action is still in progress.');
  const requestContext = context(requireSession);
  publish({ busyAction: action, error: sessionPersistenceWarning, notice: null });
  try {
    return await operation(requestContext);
  } catch (error) {
    if (isCurrent(requestContext)) {
      if (requestContext.session && error instanceof AccountApiError && error.status === 401) {
        await markExpired(requestContext);
      } else if (requestContext.session && error instanceof AccountApiError && error.code === 'SPACE_ACCESS_DENIED') {
        try {
          const me = await readMe(requestContext, true);
          if (isCurrent(requestContext)) publish({ user: me.user, spaces: me.spaces });
        } catch {
          // The original authorization error is more useful than a failed reconciliation read.
        }
      }
      if (isCurrent(requestContext) && snapshot.status !== 'expired') {
        publish({ error: errorMessage(error), notice: null });
      }
    }
    throw error;
  } finally {
    if (isCurrent(requestContext)) publish({ busyAction: null });
  }
}

export async function setAccountApiUrl(value: string): Promise<void> {
  await initializeAccountWorkspace();
  const apiUrl = normalizeApiUrl(value);
  if (apiUrl === snapshot.apiUrl) return;
  if (snapshot.busyAction) throw new Error('Wait for the current account action to finish before changing the API URL.');
  if (snapshot.status === 'signed-in' || snapshot.status === 'offline' || snapshot.status === 'restoring') {
    throw new Error('Sign out before changing the API URL. The current session stays bound to its service.');
  }

  const requestGeneration = ++generation;
  clearRefreshTimer();
  publish({ status: 'loading', busyAction: 'save-api-url', error: null, notice: null });
  try {
    await setStoredApiUrl(apiUrl);
    if (requestGeneration !== generation) return;
    currentSession = null;
    sessionPersistenceWarning = null;
    publish({ apiUrl, status: apiUrl ? 'signed-out' : 'local', user: null, localProfileId: null, sessionEmail: null, spaces: [], busyAction: null, error: null, notice: null });
    if (apiUrl) {
      const storedSession = await getStoredSession();
      if (requestGeneration !== generation) return;
      if (storedSession?.apiUrl === apiUrl) await restore(apiUrl, requestGeneration, storedSession);
    }
  } catch (error) {
    if (requestGeneration === generation) {
      publish({ status: snapshot.apiUrl ? 'signed-out' : 'local', busyAction: null, error: errorMessage(error) });
    }
    throw error;
  }
}

/** The Service address is device-only connection configuration, never content. */
export async function setPowerSyncServiceUrl(value: string): Promise<void> {
  await initializeAccountWorkspace();
  const powerSyncUrl = normalizePowerSyncServiceUrl(value);
  if (powerSyncUrl === snapshot.powerSyncUrl) return;
  await setStoredPowerSyncUrl(powerSyncUrl);
  publish({ powerSyncUrl, error: null, notice: powerSyncUrl ? 'PowerSync Service address saved on this device.' : 'PowerSync Service address cleared on this device.' });
}

async function authenticate(path: '/auth/register' | '/auth/login', email: string, password: string): Promise<void> {
  await initializeAccountWorkspace();
  if (snapshot.status === 'signed-in' || snapshot.status === 'offline') {
    throw new Error('Sign out of the current account before switching accounts.');
  }
  generation += 1;
  clearRefreshTimer();
  currentSession = null;
  return withBusy(path === '/auth/register' ? 'create-account' : 'sign-in', false, async (requestContext) => {
    const response = await request<AccountResponse>(requestContext, path, {
      method: 'POST',
      body: { email: email.trim(), password },
      mutationLabel: path === '/auth/register' ? 'account registration' : 'sign in'
    });
    const session: StoredAccountSession = {
      apiUrl: requestContext.apiUrl,
      token: response.session.token,
      expiresAt: response.session.expiresAt,
      email: response.user.email,
      userId: response.user.id
    };
    currentSession = session;
    try {
      await setStoredSession(session);
      sessionPersistenceWarning = null;
    } catch {
      sessionPersistenceWarning = 'Account access succeeded, but secure session storage failed. Keep this app open and sign out before closing it.';
    }
    assertCurrent(requestContext);
    publish({ status: 'signed-in', user: response.user, localProfileId: response.user.id, sessionEmail: response.user.email, spaces: response.spaces, error: sessionPersistenceWarning, notice: null });
    scheduleRefresh(session, { ...requestContext, session });
  });
}

export function registerAccount(email: string, password: string): Promise<void> {
  return authenticate('/auth/register', email, password);
}

export function loginAccount(email: string, password: string): Promise<void> {
  return authenticate('/auth/login', email, password);
}

export async function logoutAccount(): Promise<void> {
  await withBusy('sign-out', true, async (requestContext) => {
    try {
      await request<{ loggedOut: true }>(requestContext, '/auth/logout', {
        method: 'POST',
        mutationLabel: 'sign out'
      });
    } catch (error) {
      if (!(error instanceof AccountApiError && error.status === 401)) throw error;
    }

    const oldEmail = requestContext.session?.email ?? snapshot.sessionEmail;
    generation += 1;
    clearRefreshTimer();
    currentSession = null;
    let storageError: string | null = null;
    try {
      await setStoredSession(null);
      sessionPersistenceWarning = null;
    } catch {
      sessionPersistenceWarning = null;
      storageError = ' The server revoked the session, but local secure storage could not clear the old token.';
    }
    publish({
      status: 'signed-out',
      user: null,
      localProfileId: null,
      sessionEmail: null,
      spaces: [],
      busyAction: null,
      error: storageError,
      notice: storageError ? null : `Signed out${oldEmail ? ` from ${oldEmail}` : ''}. Cooking data on this device was left untouched.`
    });
  });
}

export async function refreshAccountWorkspace(): Promise<void> {
  await withBusy('refresh-account', true, async (requestContext) => {
    const me = await readMe(requestContext, true);
    const returnedIds = new Set(me.spaces.map((space) => space.id));
    const removed = snapshot.spaces.filter((space) => space.kind === 'household' && !returnedIds.has(space.id));
    publish({
      status: 'signed-in',
      user: me.user,
      localProfileId: me.user.id,
      sessionEmail: me.user.email,
      spaces: me.spaces,
      error: sessionPersistenceWarning,
      notice: removed.length
        ? `Access to ${removed.map((space) => space.name).join(', ')} was removed. The saved workspace copy and pending edits remain on this device.`
        : 'Account and household membership were checked with the service.'
    });
  });
}

export async function refreshAccountSession(): Promise<void> {
  await withBusy('refresh-session', true, async (requestContext) => {
    const rotated = await rotateSession(requestContext);
    const me = await readMe({ ...requestContext, session: rotated }, false);
    publish({ status: 'signed-in', user: me.user, localProfileId: me.user.id, sessionEmail: me.user.email, spaces: me.spaces, error: sessionPersistenceWarning, notice: 'Session refreshed. The previous session token was revoked.' });
  });
}

/** Fetch a fresh service JWT without exposing the long-lived app bearer to sync code. */
export async function fetchPowerSyncCredential(): Promise<{
  endpoint: string;
  token: string;
  expiresAt?: Date;
}> {
  const endpoint = configuredPowerSyncEndpoint();
  let requestContext = context(true);
  try {
    const credential = await request<PowerSyncCredentialResponse>(requestContext, '/sync/credentials', {
      method: 'POST',
      mutationLabel: 'sync credential request'
    });
    if (!credential || typeof credential.token !== 'string' || !credential.token
      || !Number.isFinite(Date.parse(credential.expiresAt))) {
      throw new Error('The sync service returned incomplete connection credentials.');
    }
    return {
      endpoint,
      token: credential.token,
      expiresAt: new Date(credential.expiresAt)
    };
  } catch (error) {
    if (error instanceof AccountApiError && error.status === 401 && requestContext.session) {
      const rotated = await rotateSession(requestContext);
      requestContext = { ...requestContext, session: rotated };
      const credential = await request<PowerSyncCredentialResponse>(requestContext, '/sync/credentials', {
        method: 'POST',
        mutationLabel: 'sync credential request'
      });
      if (!credential || typeof credential.token !== 'string' || !credential.token
        || !Number.isFinite(Date.parse(credential.expiresAt))) {
        throw new Error('The sync service returned incomplete connection credentials.');
      }
      return {
        endpoint,
        token: credential.token,
        expiresAt: new Date(credential.expiresAt)
      };
    }
    if (error instanceof AccountApiError && error.status === 401) await markExpired(requestContext);
    throw error;
  }
}

function configuredPowerSyncEndpoint(): string {
  const endpoint = normalizePowerSyncServiceUrl(snapshot.powerSyncUrl);
  if (!endpoint) throw new Error('Set a PowerSync Service URL on this device before connecting workspace content.');
  return endpoint;
}

/** Apply one idempotent PowerSync CRUD transaction through the membership-checked API. */
export async function submitContentMutation(
  spaceId: string,
  body: ContentMutationRequest
): Promise<unknown> {
  const requestContext = context(true);
  try {
    return await request<unknown>(requestContext, `/spaces/${encodeURIComponent(spaceId)}/content/mutations`, {
      method: 'POST',
      body,
      mutationLabel: 'content upload'
    });
  } catch (error) {
    if (error instanceof AccountApiError && error.status === 401) await markExpired(requestContext);
    if (error instanceof AccountApiError && error.status === 403) {
      try {
        const me = await readMe(requestContext, true);
        if (isCurrent(requestContext)) publish({ user: me.user, spaces: me.spaces, status: 'signed-in' });
      } catch {
        // The original authorization denial remains the actionable upload result.
      }
    }
    throw error;
  }
}

export async function createHousehold(name: string): Promise<AccountWorkspace> {
  return withBusy('create-household', true, async (requestContext) => {
    const result = await request<{ space: AccountWorkspace }>(requestContext, '/spaces', {
      method: 'POST',
      body: { kind: 'household', name: name.trim() },
      mutationLabel: 'household creation'
    });
    const spaces = [...snapshot.spaces.filter((space) => space.id !== result.space.id), result.space];
    publish({ spaces, notice: `${result.space.name} was created. Choose it as the cooking workspace when you are ready.` });
    return result.space;
  });
}

export async function listWorkspaceMembers(spaceId: string): Promise<WorkspaceMember[]> {
  return withBusy(`load-members:${spaceId}`, true, async (requestContext) => {
    const result = await request<{ members: WorkspaceMember[] }>(requestContext, `/spaces/${encodeURIComponent(spaceId)}/members`);
    return result.members;
  });
}

export async function listWorkspaceInvitations(spaceId: string): Promise<WorkspaceInvitation[]> {
  return withBusy(`load-invitations:${spaceId}`, true, async (requestContext) => {
    const result = await request<{ invitations: WorkspaceInvitation[] }>(requestContext, `/spaces/${encodeURIComponent(spaceId)}/invitations`);
    return result.invitations;
  });
}

export async function inviteWorkspaceMember(
  spaceId: string,
  email: string,
  role: 'editor' | 'viewer'
): Promise<WorkspaceInvitation> {
  return withBusy(`invite:${spaceId}`, true, async (requestContext) => {
    const result = await request<{ invitation: WorkspaceInvitation }>(requestContext, `/spaces/${encodeURIComponent(spaceId)}/invitations`, {
      method: 'POST',
      body: { email: email.trim(), role },
      mutationLabel: 'invitation creation'
    });
    return result.invitation;
  });
}

export async function acceptWorkspaceInvitation(token: string): Promise<AccountWorkspace> {
  return withBusy('accept-invitation', true, async (requestContext) => {
    const result = await request<{ space: AccountWorkspace }>(requestContext, '/invitations/accept', {
      method: 'POST',
      body: { token: token.trim() },
      mutationLabel: 'invitation acceptance'
    });
    publish({
      spaces: [...snapshot.spaces.filter((space) => space.id !== result.space.id), result.space],
      notice: `Joined ${result.space.name} as ${result.space.role}. Choose it as the cooking workspace when you are ready.`
    });
    return result.space;
  });
}

export async function removeWorkspaceMember(spaceId: string, userId: string): Promise<void> {
  await withBusy(`remove-member:${spaceId}`, true, async (requestContext) => {
    await request<void>(requestContext, `/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      mutationLabel: 'member removal'
    });
  });
}

export async function leaveWorkspace(spaceId: string): Promise<void> {
  await withBusy(`leave-household:${spaceId}`, true, async (requestContext) => {
    await request<void>(requestContext, `/spaces/${encodeURIComponent(spaceId)}/leave`, {
      method: 'POST',
      mutationLabel: 'leaving a household'
    });
    publish({
      spaces: snapshot.spaces.filter((space) => space.id !== spaceId),
      notice: 'You left the household. Cooking data on this device was left untouched.'
    });
  });
}
