import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createApp, requireMembership } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashOpaqueToken } from '../src/security.js';

const config = loadConfig();
const dbUrl = new URL(config.databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) || dbUrl.pathname !== '/creative_cooking_test') {
  throw new Error('API integration tests require the isolated loopback creative_cooking_test database.');
}
const pool = new Pool({ connectionString: config.databaseUrl, max: 12 });
const app = await createApp({ pool, config, logger: false });

interface InjectResult {
  statusCode: number;
  body: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
}

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, payload?: unknown, origin?: string): Promise<InjectResult> {
  const response = await app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  let body: Record<string, any> = {};
  if (response.payload.length > 0) body = response.json();
  return { statusCode: response.statusCode, body, headers: response.headers as InjectResult['headers'] };
}

async function register(email: string, password = 'Kitchen-testing-2026!') {
  return call('POST', '/v1/auth/register', undefined, { email, password });
}

before(async () => {
  await app.ready();
  await pool.query('TRUNCATE space_invitations, auth_sessions, space_members, spaces, users CASCADE');
});

after(async () => {
  await app.close();
  await pool.end();
});

test('API enforces account, workspace, invite and current-session rules in PostgreSQL', async (t) => {
  const [raceA, raceB] = await Promise.all([
    register('Concurrent@Example.com'),
    register('concurrent@example.com'),
  ]);
  assert.deepEqual([raceA.statusCode, raceB.statusCode].sort(), [201, 409]);
  const winner = raceA.statusCode === 201 ? raceA : raceB;
  assert.equal(winner.body.spaces.length, 1);
  assert.equal(winner.body.spaces[0].kind, 'personal');
  const raceEmail = winner.body.user.email;
  const [raceRows, raceSpaces] = await Promise.all([
    pool.query('SELECT count(*)::int AS count FROM users WHERE email_normalized = $1', [raceEmail]),
    pool.query("SELECT count(*)::int AS count FROM spaces WHERE created_by = $1 AND kind = 'personal'", [winner.body.user.id]),
  ]);
  assert.equal(raceRows.rows[0].count, 1);
  assert.equal(raceSpaces.rows[0].count, 1);

  const ownerResponse = await register('owner@example.com');
  const memberResponse = await register('member@example.com');
  const outsiderResponse = await register('outsider@example.com');
  const viewerResponse = await register('viewer@example.com');
  for (const response of [ownerResponse, memberResponse, outsiderResponse, viewerResponse]) assert.equal(response.statusCode, 201);
  const owner = ownerResponse.body;
  const member = memberResponse.body;
  const outsider = outsiderResponse.body;
  const viewer = viewerResponse.body;
  const ownerToken = owner.session.token as string;
  const memberToken = member.session.token as string;
  const outsiderToken = outsider.session.token as string;
  const viewerToken = viewer.session.token as string;
  const ownerPersonalId = owner.spaces[0].id as string;
  const memberPersonalId = member.spaces[0].id as string;

  const throttleResults = [];
  for (let index = 0; index < 5; index += 1) {
    throttleResults.push(await call('POST', '/v1/auth/register', undefined, {}));
  }
  assert.deepEqual(
    throttleResults.map((result) => result.statusCode),
    [400, 400, 400, 400, 429],
    JSON.stringify(throttleResults.map((result) => ({ status: result.statusCode, limit: result.headers['x-ratelimit-limit'], remaining: result.headers['x-ratelimit-remaining'] }))),
  );

  await t.test('registration and login do not expose credentials or accept caller identity', async () => {
    assert.equal(owner.user.email, 'owner@example.com');
    assert.equal(JSON.stringify(owner).includes('password'), false);
    const login = await call('POST', '/v1/auth/login', undefined, { email: 'OWNER@example.com', password: 'Kitchen-testing-2026!' });
    assert.equal(login.statusCode, 200);
    assert.equal(login.body.user.id, owner.user.id);
    const badLogin = await call('POST', '/v1/auth/login', undefined, { email: 'owner@example.com', password: 'wrong password' });
    assert.equal(badLogin.statusCode, 401);
    const extraIdentity = await call('POST', '/v1/spaces', ownerToken, {
      kind: 'household', name: 'Spoofed', createdBy: outsider.user.id,
    });
    assert.equal(extraIdentity.statusCode, 400);
    const sessions = await pool.query('SELECT token_hash FROM auth_sessions WHERE user_id = $1', [owner.user.id]);
    assert.equal(sessions.rows.some((row) => row.token_hash === ownerToken), false);
  });

  const privateDenial = await call('GET', `/v1/spaces/${ownerPersonalId}`, outsiderToken);
  assert.equal(privateDenial.statusCode, 403);
  const ownSpace = await call('GET', `/v1/spaces/${ownerPersonalId}`, ownerToken);
  assert.equal(ownSpace.statusCode, 200);
  assert.equal(ownSpace.body.space.role, 'owner');
  const personalInvite = await call('POST', `/v1/spaces/${ownerPersonalId}/invitations`, ownerToken, { email: 'member@example.com' });
  assert.equal(personalInvite.statusCode, 409);

  const injectedSpace = await call('POST', '/v1/spaces', ownerToken, { kind: 'personal', name: 'Other personal' });
  assert.equal(injectedSpace.statusCode, 400);
  const createdSpace = await call('POST', '/v1/spaces', ownerToken, { kind: 'household', name: 'Household A' });
  assert.equal(createdSpace.statusCode, 201);
  const householdId = createdSpace.body.space.id as string;

  await t.test('roles and invitation claims are server controlled', async () => {
    const ownerGrant = await call('POST', `/v1/spaces/${householdId}/invitations`, ownerToken, {
      email: 'member@example.com', role: 'owner',
    });
    assert.equal(ownerGrant.statusCode, 400);
    const actorSubstitution = await call('POST', `/v1/spaces/${householdId}/invitations`, ownerToken, {
      email: 'member@example.com', role: 'editor', userId: outsider.user.id,
    });
    assert.equal(actorSubstitution.statusCode, 400);
    const memberInvite = await call('POST', `/v1/spaces/${householdId}/invitations`, memberToken, { email: 'outsider@example.com' });
    assert.equal(memberInvite.statusCode, 403);
  });

  const invitationResponse = await call('POST', `/v1/spaces/${householdId}/invitations`, ownerToken, {
    email: 'member@example.com', role: 'editor',
  });
  assert.equal(invitationResponse.statusCode, 201);
  const invitation = invitationResponse.body.invitation;
  const inviteRows = await pool.query('SELECT token_hash FROM space_invitations WHERE id = $1', [invitation.id]);
  assert.equal(inviteRows.rows[0].token_hash, hashOpaqueToken(invitation.token, config.sessionTokenPepper));
  assert.notEqual(inviteRows.rows[0].token_hash, invitation.token);
  const wrongEmail = await call('POST', '/v1/invitations/accept', outsiderToken, { token: invitation.token });
  assert.equal(wrongEmail.statusCode, 403);

  const acceptance = await Promise.all([
    call('POST', '/v1/invitations/accept', memberToken, { token: invitation.token }),
    call('POST', '/v1/invitations/accept', memberToken, { token: invitation.token }),
  ]);
  assert.deepEqual(acceptance.map((result) => result.statusCode).sort(), [200, 409]);
  const accepted = acceptance.find((result) => result.statusCode === 200)!;
  assert.deepEqual(Object.keys(accepted.body.space).sort(), ['createdAt', 'id', 'kind', 'name', 'role']);
  assert.equal(accepted.body.space.role, 'editor');
  const replay = await call('POST', '/v1/invitations/accept', memberToken, { token: invitation.token });
  assert.equal(replay.statusCode, 409);

  const viewerInvitation = await call('POST', `/v1/spaces/${householdId}/invitations`, ownerToken, {
    email: 'viewer@example.com', role: 'viewer',
  });
  assert.equal(viewerInvitation.statusCode, 201);
  const viewerAcceptance = await call('POST', '/v1/invitations/accept', viewerToken, { token: viewerInvitation.body.invitation.token });
  assert.equal(viewerAcceptance.statusCode, 200);
  assert.equal(viewerAcceptance.body.space.role, 'viewer');
  assert.equal((await requireMembership(pool, viewer.user.id, householdId, 'viewer')).role, 'viewer');
  await assert.rejects(
    () => requireMembership(pool, viewer.user.id, householdId, 'editor'),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 403,
  );
  assert.equal((await call('GET', `/v1/spaces/${householdId}/invitations`, viewerToken)).statusCode, 403);
  assert.equal((await call('POST', `/v1/spaces/${householdId}/invitations`, viewerToken, { email: 'another@example.com' })).statusCode, 403);
  assert.equal((await call('DELETE', `/v1/spaces/${householdId}/members/${viewer.user.id}`, ownerToken)).statusCode, 204);
  assert.equal((await call('GET', `/v1/spaces/${householdId}`, viewerToken)).statusCode, 403);
  assert.equal((await call('GET', '/v1/me', viewerToken)).statusCode, 200);

  const memberSpace = await call('GET', `/v1/spaces/${householdId}`, memberToken);
  assert.equal(memberSpace.statusCode, 200);
  const unrelatedPrivate = await call('GET', `/v1/spaces/${memberPersonalId}`, ownerToken);
  assert.equal(unrelatedPrivate.statusCode, 403);
  const memberList = await call('GET', `/v1/spaces/${householdId}/members`, memberToken);
  assert.equal(memberList.statusCode, 200);
  assert.equal(memberList.body.members.length, 2);
  assert.equal(memberList.body.members.some((row: { user: { id: string } }) => row.user.id === outsider.user.id), false);
  const outsiderMembers = await call('GET', `/v1/spaces/${householdId}/members`, outsiderToken);
  assert.equal(outsiderMembers.statusCode, 403);

  const expiringInvite = await call('POST', `/v1/spaces/${householdId}/invitations`, ownerToken, { email: 'outsider@example.com' });
  assert.equal(expiringInvite.statusCode, 201);
  const expiredId = expiringInvite.body.invitation.id as string;
  const expiredToken = expiringInvite.body.invitation.token as string;
  const pendingTokenRows = await pool.query('SELECT token_hash FROM space_invitations WHERE id = $1', [expiredId]);
  assert.notEqual(pendingTokenRows.rows[0].token_hash, expiredToken);
  await pool.query('UPDATE space_invitations SET expires_at = now() - interval \'1 second\' WHERE id = $1', [expiredId]);
  const expiredBefore = await call('POST', '/v1/invitations/accept', outsiderToken, { token: expiredToken });
  assert.equal(expiredBefore.statusCode, 410);

  const lastOwnerLeave = await call('POST', `/v1/spaces/${householdId}/leave`, ownerToken);
  assert.equal(lastOwnerLeave.statusCode, 409);
  const lastPersonalOwnerLeave = await call('POST', `/v1/spaces/${ownerPersonalId}/leave`, ownerToken);
  assert.equal(lastPersonalOwnerLeave.statusCode, 409);
  const editorRemoval = await call('DELETE', `/v1/spaces/${householdId}/members/${owner.user.id}`, memberToken);
  assert.equal(editorRemoval.statusCode, 403);

  const removedMember = await call('DELETE', `/v1/spaces/${householdId}/members/${member.user.id}`, ownerToken);
  assert.equal(removedMember.statusCode, 204);
  const revokedWorkspace = await call('GET', `/v1/spaces/${householdId}`, memberToken);
  assert.equal(revokedWorkspace.statusCode, 403);
  await assert.rejects(
    () => requireMembership(pool, member.user.id, householdId),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 403,
  );
  const stillValidSession = await call('GET', '/v1/me', memberToken);
  assert.equal(stillValidSession.statusCode, 200);
  assert.equal(stillValidSession.body.spaces.some((space: { id: string }) => space.id === memberPersonalId), true);
  assert.equal(stillValidSession.body.spaces.some((space: { id: string }) => space.id === householdId), false);
  const householdRemains = await pool.query('SELECT count(*)::int AS count FROM spaces WHERE id = $1', [householdId]);
  assert.equal(householdRemains.rows[0].count, 1);
  assert.equal((await call('POST', '/v1/auth/logout', memberToken)).statusCode, 200);
  assert.equal((await call('GET', '/v1/me', memberToken)).statusCode, 401);

  // Seed a second owner directly because the foundation intentionally has no ownership-transfer route.
  await pool.query(
    "INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $2, 'owner')",
    [householdId, outsider.user.id],
  );
  const [concurrentLeave, concurrentRemoval] = await Promise.all([
    call('POST', `/v1/spaces/${householdId}/leave`, ownerToken),
    call('DELETE', `/v1/spaces/${householdId}/members/${owner.user.id}`, outsiderToken),
  ]);
  const lastOwnerRaceStatuses = [concurrentLeave.statusCode, concurrentRemoval.statusCode].sort();
  assert.equal(lastOwnerRaceStatuses.filter((status) => status === 204).length, 1);
  assert.ok(lastOwnerRaceStatuses.includes(403) || lastOwnerRaceStatuses.includes(404));
  const remainingOwners = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM space_members WHERE space_id = $1 AND role = 'owner'",
    [householdId],
  );
  assert.equal(remainingOwners.rowCount, 1);
  const remainingOwnerToken = remainingOwners.rows[0]!.user_id === owner.user.id ? ownerToken : outsiderToken;
  assert.equal((await call('POST', `/v1/spaces/${householdId}/leave`, remainingOwnerToken)).statusCode, 409);

  const rotated = await call('POST', '/v1/auth/refresh', ownerToken);
  assert.equal(rotated.statusCode, 200);
  const freshOwnerToken = rotated.body.session.token as string;
  assert.notEqual(freshOwnerToken, ownerToken);
  assert.equal((await call('GET', '/v1/me', ownerToken)).statusCode, 401);
  assert.equal((await call('GET', '/v1/me', freshOwnerToken)).statusCode, 200);
  assert.equal((await call('POST', '/v1/auth/logout', freshOwnerToken)).statusCode, 200);
  assert.equal((await call('GET', '/v1/me', freshOwnerToken)).statusCode, 401);

  const outsiderTokenHash = hashOpaqueToken(outsiderToken, config.sessionTokenPepper);
  await pool.query('UPDATE auth_sessions SET expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [outsiderTokenHash]);
  assert.equal((await call('GET', '/v1/me', outsiderToken)).statusCode, 401);

  const allowedOrigin = config.allowedOrigins[0]!;
  const corsAllowed = await call('GET', '/v1/health', undefined, undefined, allowedOrigin);
  assert.equal(corsAllowed.statusCode, 200);
  assert.equal(corsAllowed.headers['access-control-allow-origin'], allowedOrigin);
  const corsDenied = await call('GET', '/v1/health', undefined, undefined, 'https://attacker.invalid');
  assert.equal(corsDenied.statusCode, 403);

  const oversizedBody = await app.inject({
    method: 'POST',
    url: '/v1/spaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: 'oversized@example.com', password: 'p'.repeat(17_000) }),
  });
  assert.equal(oversizedBody.statusCode, 413);
  assert.equal(oversizedBody.json().error.code, 'BODY_TOO_LARGE');
});
