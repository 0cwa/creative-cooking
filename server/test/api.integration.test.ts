import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { importSPKI, jwtVerify } from 'jose';
import { Pool } from 'pg';
import { createApp, requireMembership } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { contentStorageId } from '../src/contentIdentity.js';
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
  const memberContentMutation = {
    mutationId: 'member-content-before-removal',
    operations: [{ opId: 'member-pantry-write', type: 'pantry.upsert', id: 'member-pantry-row', name: 'Cumin', preference: 3 }],
  };
  let removedMemberHistoryMutation: unknown = null;

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

  await t.test('PowerSync credentials are signed, short-lived, and scoped at query time', async () => {
    const unauthenticated = await call('POST', '/v1/sync/credentials');
    assert.equal(unauthenticated.statusCode, 401);
    const jwks = await call('GET', '/v1/sync/jwks');
    assert.equal(jwks.statusCode, 200);
    assert.equal(jwks.body.keys.length, 1);
    assert.equal(jwks.body.keys[0].kid, config.syncJwtKeyId);
    assert.equal(jwks.body.keys[0].alg, 'EdDSA');
    assert.equal('d' in jwks.body.keys[0], false);
    const credentials = await call('POST', '/v1/sync/credentials', ownerToken);
    assert.equal(credentials.statusCode, 200);
    const publicKeyPem = Buffer.from(config.syncJwtPublicKeyB64Url, 'base64url').toString('utf8');
    const { payload, protectedHeader } = await jwtVerify(
      credentials.body.token,
      await importSPKI(publicKeyPem, 'EdDSA'),
      { audience: config.syncJwtAudience, issuer: config.syncJwtIssuer },
    );
    assert.equal(protectedHeader.kid, config.syncJwtKeyId);
    assert.equal(payload.sub, owner.user.id);
    assert.equal(typeof payload.iat, 'number');
    assert.equal(typeof payload.exp, 'number');
    assert.ok((payload.exp as number) - (payload.iat as number) <= 300);
    assert.equal('space_ids' in payload, false);
  });

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

  await t.test('content writes preserve scoped IDs, conflicts, shopping atomicity, and current roles', async () => {
    const pantryMutation = {
      mutationId: 'owner-pantry-write',
      operations: [{ opId: 'salt-upsert', type: 'pantry.upsert', id: 'pantry-salt', name: 'Salt', preference: 4 }],
    };
    const pantryWrite = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, pantryMutation);
    assert.equal(pantryWrite.statusCode, 200);
    assert.equal(pantryWrite.body.operations[0].entityId, 'pantry-salt');
    const pantryRow = await pool.query<{ id: string; entity_id: string }>(
      'SELECT id, entity_id FROM pantry_items WHERE space_id = $1 AND entity_id = $2', [householdId, 'pantry-salt'],
    );
    assert.equal(pantryRow.rowCount, 1);
    assert.equal(pantryRow.rows[0]!.id, contentStorageId('pantry_items', householdId, null, 'pantry-salt'));
    assert.equal(pantryRow.rows[0]!.entity_id, 'pantry-salt');

    const recipePayload = (id: string, title: string) => ({
      id, title, description: null, portions: 2, notes: ['Keep the handwritten note.'],
      ingredients: [{ id: 'ingredient-copy-id', name: 'Salt', amount: '1 pinch', needsShopping: false, metadata: { source: 'legacy-import' } }],
      steps: [{ id: 'step-copy-id', text: 'Stir gently.' }],
    });
    const initialRecipeMutation = {
      mutationId: 'recipe-create-household',
      operations: [{ opId: 'recipe-create', type: 'recipe.save', baseVersion: null, recipe: recipePayload('recipe-shared-id', 'Household Soup') }],
    };
    const initialRecipe = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, initialRecipeMutation);
    assert.equal(initialRecipe.statusCode, 200);
    const copiedChildRecipe = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'recipe-copy-household',
      operations: [{ opId: 'recipe-copy-create', type: 'recipe.save', baseVersion: null, recipe: recipePayload('recipe-copy-id', 'Copied Soup') }],
    });
    assert.equal(copiedChildRecipe.statusCode, 200);
    const adoptedSameRoot = await call('POST', `/v1/spaces/${ownerPersonalId}/content/mutations`, ownerToken, {
      mutationId: 'recipe-adopt-personal',
      operations: [{ opId: 'recipe-adopt', type: 'recipe.save', baseVersion: null, recipe: recipePayload('recipe-shared-id', 'Personal Soup') }],
    });
    assert.equal(adoptedSameRoot.statusCode, 200);
    const scopedRecipeRows = await pool.query<{ id: string; space_id: string; entity_id: string }>(
      'SELECT id, space_id, entity_id FROM recipes WHERE entity_id = $1 ORDER BY space_id', ['recipe-shared-id'],
    );
    assert.equal(scopedRecipeRows.rowCount, 2);
    assert.equal(new Set(scopedRecipeRows.rows.map((row) => row.id)).size, 2);
    assert.equal(scopedRecipeRows.rows.find((row) => row.space_id === householdId)?.id,
      contentStorageId('recipes', householdId, null, 'recipe-shared-id'));
    const childRows = await pool.query<{ id: string; space_id: string; recipe_id: string; entity_id: string }>(
      `SELECT id, space_id, recipe_id, entity_id FROM recipe_ingredients WHERE entity_id = $1 ORDER BY space_id, recipe_id`,
      ['ingredient-copy-id'],
    );
    assert.equal(childRows.rowCount, 3);
    assert.equal(new Set(childRows.rows.map((row) => row.id)).size, 3);
    assert.ok(childRows.rows.some((row) => row.space_id === householdId && row.recipe_id === 'recipe-shared-id'
      && row.id === contentStorageId('recipe_ingredients', householdId, 'recipe-shared-id', 'ingredient-copy-id')));
    assert.ok(childRows.rows.some((row) => row.space_id === householdId && row.recipe_id === 'recipe-copy-id'
      && row.id === contentStorageId('recipe_ingredients', householdId, 'recipe-copy-id', 'ingredient-copy-id')));
    const recipeRead = await call('GET', `/v1/spaces/${householdId}/content/recipes/recipe-shared-id`, memberToken);
    assert.equal(recipeRead.statusCode, 200);
    assert.equal(recipeRead.body.recipe.ingredients[0].id, 'ingredient-copy-id');
    assert.equal(recipeRead.body.recipe.steps[0].id, 'step-copy-id');
    assert.deepEqual(recipeRead.body.recipe.ingredients[0].metadata, { source: 'legacy-import' });

    const memberRecipeUpdate = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, {
      mutationId: 'recipe-member-update',
      operations: [{ opId: 'recipe-member-save', type: 'recipe.save', baseVersion: 1, recipe: recipePayload('recipe-shared-id', 'Member Soup') }],
    });
    assert.equal(memberRecipeUpdate.statusCode, 200);
    const staleRecipeUpdate = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'recipe-stale-owner-update',
      operations: [{ opId: 'recipe-stale-save', type: 'recipe.save', baseVersion: 1, recipe: recipePayload('recipe-shared-id', 'Stale Owner Soup') }],
    });
    assert.equal(staleRecipeUpdate.statusCode, 409);
    assert.equal(staleRecipeUpdate.body.error.code, 'RECIPE_VERSION_CONFLICT');
    assert.equal(staleRecipeUpdate.body.conflicts[0].current.title, 'Member Soup');
    assert.equal(staleRecipeUpdate.body.conflicts[0].attempted.title, 'Stale Owner Soup');
    assert.equal((await call('GET', `/v1/spaces/${householdId}/content/recipes/recipe-shared-id`, ownerToken)).body.recipe.title, 'Member Soup');

    const viewerWrite = await call('POST', `/v1/spaces/${householdId}/content/mutations`, viewerToken, {
      mutationId: 'viewer-content-denied',
      operations: [{ opId: 'viewer-write', type: 'pantry.upsert', id: 'viewer-row', name: 'Forbidden', preference: 2 }],
    });
    assert.equal(viewerWrite.statusCode, 403);
    const outsiderWrite = await call('POST', `/v1/spaces/${householdId}/content/mutations`, outsiderToken, {
      mutationId: 'outsider-content-denied',
      operations: [{ opId: 'outsider-write', type: 'pantry.upsert', id: 'outsider-row', name: 'Forbidden', preference: 2 }],
    });
    assert.equal(outsiderWrite.statusCode, 403);

    const memberWrite = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, memberContentMutation);
    assert.equal(memberWrite.statusCode, 200);
    const memberReplay = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, memberContentMutation);
    assert.equal(memberReplay.statusCode, 200);
    assert.deepEqual(memberReplay.body, memberWrite.body);

    const listMutation = {
      mutationId: 'shopping-list-create',
      operations: [{
        opId: 'list-create', type: 'shopping.list.create',
        list: { id: 'shopping-list-main', name: 'Market', currentCycleId: 'cycle-one', createdAt: '2026-11-12T07:00:00.000Z', updatedAt: '2026-11-12T07:00:00.000Z' },
        cycle: { id: 'cycle-one', listId: 'shopping-list-main', startedAt: '2026-11-12T07:00:00.000Z' },
      }],
    };
    const listWrite = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, listMutation);
    assert.equal(listWrite.statusCode, 200);
    const itemMutation = {
      mutationId: 'shopping-items-create',
      operations: [
        { opId: 'item-flour-create', type: 'shopping.item.upsert', item: { id: 'item-flour', listId: 'shopping-list-main', name: 'Flour', purchaseCycleId: 'cycle-one', checked: false, createdAt: '2026-11-12T07:00:00.000Z', updatedAt: '2026-11-12T07:00:00.000Z' } },
        { opId: 'item-salt-create', type: 'shopping.item.upsert', item: { id: 'item-salt', listId: 'shopping-list-main', name: 'Salt', purchaseCycleId: 'cycle-one', checked: false, createdAt: '2026-11-12T07:00:00.000Z', updatedAt: '2026-11-12T07:00:00.000Z' } },
      ],
    };
    assert.equal((await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, itemMutation)).statusCode, 200);
    const purchasePayload = {
      mutationId: 'shopping-purchase-one',
      operations: [{
        opId: 'purchase-one', type: 'shopping.purchase',
        purchase: { id: 'purchase-stable-one', listId: 'shopping-list-main', purchaseCycleId: 'cycle-one', itemIds: ['item-flour', 'item-salt'], pantryItemIds: ['pantry-flour', 'pantry-salt'], purchasedAt: '2026-11-12T07:05:00.000Z' },
        pantryAdds: [{ id: 'pantry-flour', name: 'Flour', preference: 3 }],
      }],
    };
    const purchase = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, purchasePayload);
    assert.equal(purchase.statusCode, 200);
    const purchaseEffect = await pool.query<{ purchases: number; flour: number; completed: number }>(
      `SELECT
        (SELECT count(*)::int FROM shopping_purchases WHERE space_id = $1 AND list_id = 'shopping-list-main' AND entity_id = 'purchase-stable-one') AS purchases,
        (SELECT count(*)::int FROM pantry_items WHERE space_id = $1 AND entity_id = 'pantry-flour' AND deleted_at IS NULL) AS flour,
        (SELECT count(*)::int FROM shopping_items WHERE space_id = $1 AND list_id = 'shopping-list-main' AND purchased_cycle_id = 'cycle-one') AS completed`,
      [householdId],
    );
    assert.deepEqual(purchaseEffect.rows[0], { purchases: 1, flour: 1, completed: 2 });
    const purchaseReplay = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, {
      ...purchasePayload,
      mutationId: 'shopping-purchase-transport-replay',
      operations: [{ ...purchasePayload.operations[0], opId: 'purchase-one-retry' }],
    });
    assert.equal(purchaseReplay.statusCode, 200);
    assert.equal(purchaseReplay.body.operations[0].reason, 'duplicate_purchase');
    const ledgerAfterReplay = await pool.query<{ purchases: number; flour: number }>(
      `SELECT
        (SELECT count(*)::int FROM shopping_purchases WHERE space_id = $1 AND list_id = 'shopping-list-main' AND entity_id = 'purchase-stable-one') AS purchases,
        (SELECT count(*)::int FROM pantry_items WHERE space_id = $1 AND entity_id = 'pantry-flour' AND deleted_at IS NULL) AS flour`,
      [householdId],
    );
    assert.deepEqual(ledgerAfterReplay.rows[0], { purchases: 1, flour: 1 });

    const cycleStart = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-cycle-two',
      operations: [{ opId: 'cycle-two-start', type: 'shopping.cycle.start', listId: 'shopping-list-main', cycle: { id: 'cycle-two', startedAt: '2026-11-12T07:10:00.000Z' } }],
    });
    assert.equal(cycleStart.statusCode, 200);

    const personalHistorySeed = await call('POST', `/v1/spaces/${ownerPersonalId}/content/mutations`, ownerToken, {
      mutationId: 'personal-history-reference-seed',
      operations: [
        { opId: 'personal-history-pantry', type: 'pantry.upsert', id: 'pantry-history-foreign', name: 'Personal-only flour', preference: 3 },
        {
          opId: 'personal-history-list', type: 'shopping.list.create',
          list: { id: 'shopping-list-personal-history', name: 'Personal history', currentCycleId: 'cycle-personal-history', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
          cycle: { id: 'cycle-personal-history', listId: 'shopping-list-personal-history', startedAt: '2024-01-01T00:00:00Z' },
        },
      ],
    });
    assert.equal(personalHistorySeed.statusCode, 200);
    const personalHistoryItem = await call('POST', `/v1/spaces/${ownerPersonalId}/content/mutations`, ownerToken, {
      mutationId: 'personal-history-item-seed',
      operations: [{
        opId: 'personal-history-item', type: 'shopping.item.upsert',
        item: { id: 'item-history-foreign', listId: 'shopping-list-personal-history', name: 'Personal-only item', purchaseCycleId: 'cycle-personal-history', checked: false, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
      }],
    });
    assert.equal(personalHistoryItem.statusCode, 200);
    const otherHouseholdList = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-list-other-create',
      operations: [{
        opId: 'list-other-create', type: 'shopping.list.create',
        list: { id: 'shopping-list-other', name: 'Other market', currentCycleId: 'cycle-other-list', createdAt: '2026-11-12T07:11:00Z', updatedAt: '2026-11-12T07:11:00Z' },
        cycle: { id: 'cycle-other-list', listId: 'shopping-list-other', startedAt: '2026-11-12T07:11:00Z' },
      }],
    });
    assert.equal(otherHouseholdList.statusCode, 200);

    const readShoppingEffects = async () => {
      const [list, items, pantry] = await Promise.all([
        pool.query(
          'SELECT current_cycle_id, updated_at, version FROM shopping_lists WHERE space_id = $1 AND entity_id = $2',
          [householdId, 'shopping-list-main'],
        ),
        pool.query(
          `SELECT entity_id, purchase_cycle_id, checked, purchased_cycle_id, updated_at, version
           FROM shopping_items WHERE space_id = $1 AND list_id = $2 ORDER BY entity_id`,
          [householdId, 'shopping-list-main'],
        ),
        pool.query(
          'SELECT entity_id, name, preference, deleted_at FROM pantry_items WHERE space_id = $1 ORDER BY entity_id',
          [householdId],
        ),
      ]);
      return { list: list.rows, items: items.rows, pantry: pantry.rows };
    };
    const effectsBeforeHistory = await readShoppingEffects();
    const historyImport = {
      mutationId: 'shopping-history-import-one',
      operations: [{
        opId: 'history-import-one', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two',
        cycles: [{ id: 'cycle-history-one', startedAt: '2024-01-03T09:00:00.123456Z' }],
        purchases: [
          {
            id: 'purchase-history-old', purchaseCycleId: 'cycle-history-one',
            itemIds: ['item-history-foreign', 'item-history-removed'],
            pantryItemIds: ['pantry-history-foreign', 'pantry-history-removed'],
            purchasedAt: '2024-01-06T12:15:00.987654Z',
          },
          {
            id: 'purchase-history-active', purchaseCycleId: 'cycle-two',
            itemIds: [], pantryItemIds: [], purchasedAt: '2024-02-01T08:00:00.000Z',
          },
        ],
      }],
    };
    const importedHistory = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, historyImport);
    assert.equal(importedHistory.statusCode, 200);
    assert.deepEqual(importedHistory.body.operations[0].cycles, [{ id: 'cycle-history-one', status: 'applied' }]);
    assert.deepEqual(importedHistory.body.operations[0].purchases.map((row: { status: string }) => row.status), ['applied', 'applied']);
    const historyReceiptReplay = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, historyImport);
    assert.equal(historyReceiptReplay.statusCode, 200);
    assert.deepEqual(historyReceiptReplay.body, importedHistory.body);

    const exactRowsRetry = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-exact-row-retry',
      operations: [{
        opId: 'history-exact-row-retry', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two',
        cycles: [{ id: 'cycle-history-one', startedAt: '2024-01-03T10:00:00.123456+01:00' }],
        purchases: [
          {
            id: 'purchase-history-old', purchaseCycleId: 'cycle-history-one',
            itemIds: ['item-history-foreign', 'item-history-removed'],
            pantryItemIds: ['pantry-history-foreign', 'pantry-history-removed'],
            purchasedAt: '2024-01-06T13:15:00.987654+01:00',
          },
          {
            id: 'purchase-history-active', purchaseCycleId: 'cycle-two',
            itemIds: [], pantryItemIds: [], purchasedAt: '2024-02-01T09:00:00.000+01:00',
          },
        ],
      }],
    });
    assert.equal(exactRowsRetry.statusCode, 200);
    assert.deepEqual(exactRowsRetry.body.operations[0].cycles, [{ id: 'cycle-history-one', status: 'ignored', reason: 'already_exists' }]);
    assert.deepEqual(exactRowsRetry.body.operations[0].purchases.map((row: { status: string }) => row.status), ['ignored', 'ignored']);

    const historyRows = await pool.query<{
      id: string; entity_id: string; purchase_cycle_id: string; item_ids: string[]; pantry_item_ids: string[]; purchased_at_utc: string;
    }>(
      `SELECT id, entity_id, purchase_cycle_id, item_ids, pantry_item_ids,
              to_char(purchased_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purchased_at_utc
       FROM shopping_purchases WHERE space_id = $1 AND list_id = $2 AND entity_id = ANY($3::text[]) ORDER BY entity_id`,
      [householdId, 'shopping-list-main', ['purchase-history-old', 'purchase-history-active']],
    );
    assert.equal(historyRows.rowCount, 2);
    const oldPurchase = historyRows.rows.find((row) => row.entity_id === 'purchase-history-old')!;
    assert.equal(oldPurchase.id, contentStorageId('shopping_purchases', householdId, 'shopping-list-main', 'purchase-history-old'));
    assert.equal(oldPurchase.purchase_cycle_id, 'cycle-history-one');
    assert.deepEqual(oldPurchase.item_ids, ['item-history-foreign', 'item-history-removed']);
    assert.deepEqual(oldPurchase.pantry_item_ids, ['pantry-history-foreign', 'pantry-history-removed']);
    assert.equal(oldPurchase.purchased_at_utc, '2024-01-06T12:15:00.987654Z');
    const cycleTimestamp = await pool.query<{ id: string; started_at_utc: string }>(
      `SELECT id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at_utc
       FROM shopping_cycles WHERE space_id = $1 AND list_id = $2 AND entity_id = $3`,
      [householdId, 'shopping-list-main', 'cycle-history-one'],
    );
    assert.equal(cycleTimestamp.rows[0]?.id, contentStorageId('shopping_cycles', householdId, 'shopping-list-main', 'cycle-history-one'));
    assert.equal(cycleTimestamp.rows[0]?.started_at_utc, '2024-01-03T09:00:00.123456Z');
    const liveSnapshotReferences = await pool.query<{ items: number; pantry: number }>(
      `SELECT
         (SELECT count(*)::int FROM shopping_items WHERE space_id = $1 AND list_id = $2 AND entity_id = ANY($3::text[])) AS items,
         (SELECT count(*)::int FROM pantry_items WHERE space_id = $1 AND entity_id = ANY($4::text[])) AS pantry`,
      [householdId, 'shopping-list-main', ['item-history-foreign', 'item-history-removed'], ['pantry-history-foreign', 'pantry-history-removed']],
    );
    assert.deepEqual(liveSnapshotReferences.rows[0], { items: 0, pantry: 0 });
    assert.deepEqual(await readShoppingEffects(), effectsBeforeHistory);

    const nextHistoryChunk = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-chunk-two',
      operations: [{
        opId: 'history-chunk-two', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two', cycles: [],
        purchases: [{ id: 'purchase-history-next-chunk', purchaseCycleId: 'cycle-one', itemIds: ['item-not-live'], pantryItemIds: ['pantry-not-live'], purchasedAt: '2024-03-01T10:00:00Z' }],
      }],
    });
    assert.equal(nextHistoryChunk.statusCode, 200);

    const activeCycleInHistory = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-active-cycle-in-history',
      operations: [{
        opId: 'history-active-cycle-in-history', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two',
        cycles: [{ id: 'cycle-two', startedAt: '2026-11-12T07:10:00Z' }], purchases: [],
      }],
    });
    assert.equal(activeCycleInHistory.statusCode, 400);
    const oversizedHistorySnapshot = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-oversized-snapshot',
      operations: [{
        opId: 'history-oversized-snapshot', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two', cycles: [],
        purchases: [{
          id: 'purchase-history-oversized', purchaseCycleId: 'cycle-two',
          itemIds: Array.from({ length: 201 }, (_, index) => `legacy-item-${index}`), pantryItemIds: [], purchasedAt: '2024-03-02T10:00:00Z',
        }],
      }],
    });
    assert.equal(oversizedHistorySnapshot.statusCode, 400);

    const wrongActiveCycle = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-stale-active',
      operations: [{
        opId: 'history-stale-active', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-one', cycles: [],
        purchases: [{ id: 'purchase-history-stale-assertion', purchaseCycleId: 'cycle-one', itemIds: [], pantryItemIds: [], purchasedAt: '2024-04-01T00:00:00Z' }],
      }],
    });
    assert.equal(wrongActiveCycle.statusCode, 409);
    assert.equal(wrongActiveCycle.body.error.code, 'SHOPPING_HISTORY_STALE_CYCLE');

    const wrongTargetList = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-cross-space-list',
      operations: [{
        opId: 'history-cross-space-list', type: 'shopping.history.import', listId: 'shopping-list-personal-history', currentCycleId: 'cycle-personal-history', cycles: [],
        purchases: [{ id: 'purchase-cross-space-list', purchaseCycleId: 'cycle-personal-history', itemIds: [], pantryItemIds: [], purchasedAt: '2024-04-02T00:00:00Z' }],
      }],
    });
    assert.equal(wrongTargetList.statusCode, 404);
    const wrongListCycle = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-cross-list-cycle',
      operations: [{
        opId: 'history-cross-list-cycle', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two', cycles: [],
        purchases: [{ id: 'purchase-cross-list-cycle', purchaseCycleId: 'cycle-other-list', itemIds: [], pantryItemIds: [], purchasedAt: '2024-04-03T00:00:00Z' }],
      }],
    });
    assert.equal(wrongListCycle.statusCode, 422);
    const wrongWorkspaceCycle = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-cross-workspace-cycle',
      operations: [{
        opId: 'history-cross-workspace-cycle', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two', cycles: [],
        purchases: [{ id: 'purchase-cross-workspace-cycle', purchaseCycleId: 'cycle-personal-history', itemIds: [], pantryItemIds: [], purchasedAt: '2024-04-04T00:00:00Z' }],
      }],
    });
    assert.equal(wrongWorkspaceCycle.statusCode, 422);

    const cycleIdentityConflict = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-cycle-identity-conflict',
      operations: [{
        opId: 'history-cycle-identity-conflict', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two',
        cycles: [
          { id: 'cycle-history-cycle-rollback', startedAt: '2024-05-01T00:00:00Z' },
          { id: 'cycle-history-one', startedAt: '2024-01-04T09:00:00Z' },
        ],
        purchases: [],
      }],
    });
    assert.equal(cycleIdentityConflict.statusCode, 409);
    assert.equal(cycleIdentityConflict.body.error.code, 'SHOPPING_CYCLE_ID_REUSED');
    const cycleRollback = await pool.query('SELECT count(*)::int AS count FROM shopping_cycles WHERE space_id = $1 AND list_id = $2 AND entity_id = $3',
      [householdId, 'shopping-list-main', 'cycle-history-cycle-rollback']);
    assert.equal(cycleRollback.rows[0]?.count, 0);

    const purchaseIdentityConflict = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'shopping-history-purchase-identity-conflict',
      operations: [{
        opId: 'history-purchase-identity-conflict', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two',
        cycles: [{ id: 'cycle-history-purchase-rollback', startedAt: '2024-06-01T00:00:00Z' }],
        purchases: [
          { id: 'purchase-history-purchase-rollback', purchaseCycleId: 'cycle-history-purchase-rollback', itemIds: [], pantryItemIds: [], purchasedAt: '2024-06-02T00:00:00Z' },
          { id: 'purchase-history-old', purchaseCycleId: 'cycle-history-one', itemIds: ['item-history-removed', 'item-history-foreign'], pantryItemIds: ['pantry-history-foreign', 'pantry-history-removed'], purchasedAt: '2024-01-06T12:15:00.987654Z' },
        ],
      }],
    });
    assert.equal(purchaseIdentityConflict.statusCode, 409);
    assert.equal(purchaseIdentityConflict.body.error.code, 'PURCHASE_ID_REUSED');
    const purchaseRollback = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM shopping_cycles WHERE space_id = $1 AND list_id = $2 AND entity_id = 'cycle-history-purchase-rollback') AS cycles,
         (SELECT count(*)::int FROM shopping_purchases WHERE space_id = $1 AND list_id = $2 AND entity_id = 'purchase-history-purchase-rollback') AS purchases`,
      [householdId, 'shopping-list-main'],
    );
    assert.deepEqual(purchaseRollback.rows[0], { cycles: 0, purchases: 0 });

    const outsiderHistory = await call('POST', `/v1/spaces/${householdId}/content/mutations`, outsiderToken, {
      mutationId: 'outsider-history-denied',
      operations: [{
        opId: 'outsider-history', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two',
        cycles: [{ id: 'cycle-outsider-history', startedAt: '2024-07-01T00:00:00Z' }], purchases: [],
      }],
    });
    assert.equal(outsiderHistory.statusCode, 403);
    const viewerHistory = await call('POST', `/v1/spaces/${householdId}/content/mutations`, viewerToken, {
      mutationId: 'viewer-history-denied',
      operations: [{
        opId: 'viewer-history', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two',
        cycles: [{ id: 'cycle-viewer-history', startedAt: '2024-07-02T00:00:00Z' }], purchases: [],
      }],
    });
    assert.equal(viewerHistory.statusCode, 403);
    const deniedHistoryRows = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM shopping_cycles WHERE space_id = $1 AND list_id = $2 AND entity_id IN ('cycle-outsider-history', 'cycle-viewer-history')",
      [householdId, 'shopping-list-main'],
    );
    assert.equal(deniedHistoryRows.rows[0]?.count, 0);

    removedMemberHistoryMutation = {
      mutationId: 'member-history-before-removal',
      operations: [{
        opId: 'member-history-before-removal-op', type: 'shopping.history.import', listId: 'shopping-list-main', currentCycleId: 'cycle-two',
        cycles: [{ id: 'cycle-member-history', startedAt: '2024-08-01T00:00:00Z' }], purchases: [],
      }],
    };
    const memberHistory = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, removedMemberHistoryMutation);
    assert.equal(memberHistory.statusCode, 200);

    const staleCheck = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, {
      mutationId: 'shopping-stale-check',
      operations: [{ opId: 'old-cycle-check', type: 'shopping.item.check', id: 'item-flour', listId: 'shopping-list-main', purchaseCycleId: 'cycle-one', checked: true }],
    });
    assert.equal(staleCheck.statusCode, 200);
    assert.equal(staleCheck.body.operations[0].reason, 'stale_cycle');
    const stalePurchase = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, {
      mutationId: 'shopping-stale-purchase',
      operations: [{
        opId: 'old-cycle-purchase', type: 'shopping.purchase',
        purchase: { id: 'purchase-stale-cycle', listId: 'shopping-list-main', purchaseCycleId: 'cycle-one', itemIds: ['item-flour'], pantryItemIds: ['pantry-flour'], purchasedAt: '2026-11-12T07:15:00.000Z' },
        pantryAdds: [],
      }],
    });
    assert.equal(stalePurchase.statusCode, 200);
    assert.equal(stalePurchase.body.operations[0].reason, 'stale_cycle');
    const staleState = await pool.query<{ current_cycle_id: string; purchase_cycle_id: string; checked: boolean; purchased_cycle_id: string | null }>(
      `SELECT l.current_cycle_id, i.purchase_cycle_id, i.checked, i.purchased_cycle_id
       FROM shopping_lists l JOIN shopping_items i ON i.space_id = l.space_id AND i.list_id = l.entity_id
       WHERE l.space_id = $1 AND l.entity_id = 'shopping-list-main' AND i.entity_id = 'item-flour'`, [householdId],
    );
    assert.deepEqual(staleState.rows[0], { current_cycle_id: 'cycle-two', purchase_cycle_id: 'cycle-two', checked: false, purchased_cycle_id: null });

    const recipeToDelete = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'recipe-delete-create',
      operations: [{ opId: 'delete-recipe-create', type: 'recipe.save', baseVersion: null, recipe: recipePayload('recipe-tombstone', 'Deleted Recipe') }],
    });
    assert.equal(recipeToDelete.statusCode, 200);
    const recipeDelete = await call('POST', `/v1/spaces/${householdId}/content/mutations`, ownerToken, {
      mutationId: 'recipe-delete-command',
      operations: [{ opId: 'delete-recipe', type: 'recipe.delete', id: 'recipe-tombstone', baseVersion: 1 }],
    });
    assert.equal(recipeDelete.statusCode, 200);
    const staleDeletedRecipe = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, {
      mutationId: 'recipe-delete-stale-save',
      operations: [{ opId: 'save-deleted-recipe', type: 'recipe.save', baseVersion: 1, recipe: recipePayload('recipe-tombstone', 'Resurrected') }],
    });
    assert.equal(staleDeletedRecipe.statusCode, 409);
    const tombstone = await pool.query<{ deleted_at: Date | null; title: string }>(
      'SELECT deleted_at, title FROM recipes WHERE space_id = $1 AND entity_id = $2', [householdId, 'recipe-tombstone'],
    );
    assert.ok(tombstone.rows[0]?.deleted_at);
    assert.equal(tombstone.rows[0]?.title, 'Deleted Recipe');
  });

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
  const removedMemberReplay = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, memberContentMutation);
  assert.equal(removedMemberReplay.statusCode, 403);
  const removedMemberHistoryReplay = await call('POST', `/v1/spaces/${householdId}/content/mutations`, memberToken, removedMemberHistoryMutation);
  assert.equal(removedMemberHistoryReplay.statusCode, 403);
  assert.equal((await call('POST', '/v1/sync/credentials', memberToken)).statusCode, 200);
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
