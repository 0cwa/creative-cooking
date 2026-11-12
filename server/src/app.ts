import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type preHandlerHookHandler } from 'fastify';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import { hashOpaqueToken, hashPassword, normalizeEmail, createOpaqueToken, verifyPassword } from './security.js';

const SESSION_DAYS = 30;
const INVITATION_DAYS = 7;
const rolePower = { viewer: 1, editor: 2, owner: 3 } as const;

interface AuthContext {
  userId: string;
  email: string;
  sessionId: string;
  tokenHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

class ApiFault extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

interface AppOptions {
  pool: Pool;
  config: Pick<ServerConfig, 'sessionTokenPepper' | 'allowedOrigins' | 'logLevel'>;
  logger?: boolean;
}

const emailSchema = z.string().trim().email().max(320);
const passwordSchema = z.string().min(12).max(128);
const registerSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
const spaceCreateSchema = z.object({ kind: z.literal('household'), name: z.string().trim().min(1).max(80) }).strict();
const invitationCreateSchema = z.object({
  email: emailSchema,
  role: z.enum(['editor', 'viewer']).default('editor'),
}).strict();
const invitationAcceptSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const uuidSchema = z.string().uuid();

function fail(reply: FastifyReply, statusCode: number, code: string, message: string): void {
  reply.code(statusCode).send({ error: { code, message } });
}

function parse<T extends z.ZodType>(reply: FastifyReply, schema: T, value: unknown): z.output<T> | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    fail(reply, 400, 'INVALID_REQUEST', 'Request body or path parameters are invalid.');
    return undefined;
  }
  return result.data;
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function issueSession(client: PoolClient, userId: string, pepper: string) {
  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token, pepper);
  const result = await client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3::text || ' days')::interval)
     RETURNING id, expires_at`,
    [userId, tokenHash, SESSION_DAYS],
  );
  return { token, tokenHash, id: result.rows[0]!.id, expiresAt: result.rows[0]!.expires_at.toISOString() };
}

async function userSpaces(pool: Pool, userId: string) {
  const result = await pool.query<{
    id: string; name: string; kind: 'personal' | 'household'; role: 'owner' | 'editor' | 'viewer'; created_at: Date;
  }>(
    `SELECT s.id, s.name, s.kind, m.role, s.created_at
     FROM spaces s JOIN space_members m ON m.space_id = s.id
     WHERE m.user_id = $1 ORDER BY s.kind, s.created_at, s.id`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function requireMembership(
  pool: Pool,
  userId: string,
  spaceId: string,
  minimumRole: 'viewer' | 'editor' | 'owner' = 'viewer',
) {
  const result = await pool.query<{ role: 'owner' | 'editor' | 'viewer'; kind: 'personal' | 'household' }>(
    `SELECT m.role, s.kind
     FROM spaces s JOIN space_members m ON m.space_id = s.id
     WHERE s.id = $1 AND m.user_id = $2`,
    [spaceId, userId],
  );
  const membership = result.rows[0];
  if (!membership) throw new ApiFault(403, 'SPACE_ACCESS_DENIED', 'Current workspace membership is required.');
  if (rolePower[membership.role] < rolePower[minimumRole]) {
    throw new ApiFault(403, 'ROLE_REQUIRED', `Workspace role ${minimumRole} is required.`);
  }
  return membership;
}

export async function requireMembershipInTransaction(
  client: PoolClient,
  userId: string,
  spaceId: string,
  minimumRole: 'viewer' | 'editor' | 'owner',
) {
  await client.query('SELECT id FROM spaces WHERE id = $1 FOR SHARE', [spaceId]);
  const result = await client.query<{ role: 'owner' | 'editor' | 'viewer'; kind: 'personal' | 'household' }>(
    `SELECT m.role, s.kind FROM spaces s JOIN space_members m ON m.space_id = s.id
     WHERE s.id = $1 AND m.user_id = $2 FOR SHARE OF m`,
    [spaceId, userId],
  );
  const membership = result.rows[0];
  if (!membership) throw new ApiFault(403, 'SPACE_ACCESS_DENIED', 'Current workspace membership is required.');
  if (rolePower[membership.role] < rolePower[minimumRole]) {
    throw new ApiFault(403, 'ROLE_REQUIRED', `Workspace role ${minimumRole} is required.`);
  }
  return membership;
}

async function authenticateRequest(request: FastifyRequest, reply: FastifyReply, pool: Pool, pepper: string): Promise<void> {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header) : null;
  if (!match) {
    fail(reply, 401, 'AUTH_REQUIRED', 'A valid bearer session is required.');
    return;
  }
  const tokenHash = hashOpaqueToken(match[1]!, pepper);
  const result = await pool.query<{ session_id: string; user_id: string; email_normalized: string }>(
    `UPDATE auth_sessions AS a SET last_used_at = now()
     FROM users AS u
     WHERE a.user_id = u.id AND a.token_hash = $1 AND a.revoked_at IS NULL AND a.expires_at > now()
     RETURNING a.id AS session_id, a.user_id, u.email_normalized`,
    [tokenHash],
  );
  const session = result.rows[0];
  if (!session) {
    fail(reply, 401, 'SESSION_INVALID', 'The session is expired, revoked, or invalid.');
    return;
  }
  request.auth = { userId: session.user_id, email: session.email_normalized, sessionId: session.session_id, tokenHash };
}

function authGuard(pool: Pool, pepper: string): preHandlerHookHandler {
  return async (request, reply) => authenticateRequest(request, reply, pool, pepper);
}

function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new ApiFault(401, 'AUTH_REQUIRED', 'A valid bearer session is required.');
  return request.auth;
}

function paramSpace(reply: FastifyReply, request: FastifyRequest): { spaceId: string } | undefined {
  return parse(reply, z.object({ spaceId: uuidSchema }).strict(), request.params);
}

export async function createApp({ pool, config, logger = true }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    bodyLimit: 16 * 1024,
    trustProxy: false,
  });
  app.decorateRequest('auth', null);
  await app.register(cors, {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    hook: 'onRequest',
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      fail(reply, 403, 'ORIGIN_DENIED', 'This web origin is not configured for the API.');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiFault) {
      fail(reply, error.statusCode, error.code, error.message);
      return;
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429) {
      fail(reply, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
      return;
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 413) {
      fail(reply, 413, 'BODY_TOO_LARGE', 'Request body exceeds the 16 KiB limit.');
      return;
    }
    request.log.error({ err: error }, 'request failed');
    fail(reply, 500, 'INTERNAL_ERROR', 'The request could not be completed.');
  });

  app.get('/v1/health', async (_request, reply) => {
    await pool.query('SELECT 1');
    return reply.send({ status: 'ok' });
  });

  app.post('/v1/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = parse(reply, registerSchema, request.body);
    if (!body) return;
    const email = normalizeEmail(body.email);
    const passwordHash = await hashPassword(body.password);
    try {
      const result = await transaction(pool, async (client) => {
        const userResult = await client.query<{ id: string }>(
          'INSERT INTO users(email_normalized, password_hash) VALUES ($1, $2) RETURNING id',
          [email, passwordHash],
        );
        const userId = userResult.rows[0]!.id;
        const spaceResult = await client.query<{ id: string; name: string; kind: 'personal'; created_at: Date }>(
          `INSERT INTO spaces(name, kind, created_by) VALUES ('Personal', 'personal', $1)
           RETURNING id, name, kind, created_at`,
          [userId],
        );
        await client.query('INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $2, \'owner\')', [spaceResult.rows[0]!.id, userId]);
        const session = await issueSession(client, userId, config.sessionTokenPepper);
        return { userId, space: spaceResult.rows[0]!, session };
      });
      return reply.code(201).send({
        user: { id: result.userId, email },
        session: { token: result.session.token, expiresAt: result.session.expiresAt },
        spaces: [{
          id: result.space.id, name: result.space.name, kind: result.space.kind,
          role: 'owner', createdAt: result.space.created_at.toISOString(),
        }],
      });
    } catch (error) {
      if (isUniqueViolation(error)) return fail(reply, 409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists.');
      throw error;
    }
  });

  app.post('/v1/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = parse(reply, loginSchema, request.body);
    if (!body) return;
    const email = normalizeEmail(body.email);
    const found = await pool.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email_normalized = $1', [email],
    );
    const user = found.rows[0];
    if (!(await verifyPassword(user?.password_hash, body.password))) {
      return fail(reply, 401, 'LOGIN_FAILED', 'Email or password is incorrect.');
    }
    const session = await transaction(pool, (client) => issueSession(client, user!.id, config.sessionTokenPepper));
    return reply.send({
      user: { id: user!.id, email },
      session: { token: session.token, expiresAt: session.expiresAt },
      spaces: await userSpaces(pool, user!.id),
    });
  });

  app.get('/v1/me', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const auth = requireAuth(request);
    return reply.send({ user: { id: auth.userId, email: auth.email }, spaces: await userSpaces(pool, auth.userId) });
  });

  app.post('/v1/auth/refresh', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const auth = requireAuth(request);
    const newToken = createOpaqueToken();
    const newHash = hashOpaqueToken(newToken, config.sessionTokenPepper);
    const result = await pool.query<{ expires_at: Date }>(
      `UPDATE auth_sessions SET token_hash = $1, expires_at = now() + ($2::text || ' days')::interval, last_used_at = now()
       WHERE id = $3 AND token_hash = $4 AND revoked_at IS NULL AND expires_at > now()
       RETURNING expires_at`,
      [newHash, SESSION_DAYS, auth.sessionId, auth.tokenHash],
    );
    if (!result.rowCount) return fail(reply, 401, 'SESSION_ROTATED', 'The session token is no longer current.');
    return reply.send({ session: { token: newToken, expiresAt: result.rows[0]!.expires_at.toISOString() } });
  });

  app.post('/v1/auth/logout', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const auth = requireAuth(request);
    await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL', [auth.sessionId, auth.tokenHash]);
    return reply.send({ loggedOut: true });
  });

  app.post('/v1/spaces', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const body = parse(reply, spaceCreateSchema, request.body);
    if (!body) return;
    const auth = requireAuth(request);
    const created = await transaction(pool, async (client) => {
      const space = await client.query<{ id: string; name: string; kind: 'household'; created_at: Date }>(
        `INSERT INTO spaces(name, kind, created_by) VALUES ($1, 'household', $2) RETURNING id, name, kind, created_at`,
        [body.name, auth.userId],
      );
      await client.query('INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $2, \'owner\')', [space.rows[0]!.id, auth.userId]);
      return space.rows[0]!;
    });
    return reply.code(201).send({
      space: { id: created.id, name: created.name, kind: created.kind, role: 'owner', createdAt: created.created_at.toISOString() },
    });
  });

  app.get('/v1/spaces/:spaceId', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const params = paramSpace(reply, request);
    if (!params) return;
    const auth = requireAuth(request);
    const space = await transaction(pool, async (client) => {
      await client.query('SELECT id FROM spaces WHERE id = $1 FOR SHARE', [params.spaceId]);
      const membership = await requireMembershipInTransaction(client, auth.userId, params.spaceId, 'viewer');
      const result = await client.query<{ id: string; name: string; kind: 'personal' | 'household'; created_at: Date }>(
        'SELECT id, name, kind, created_at FROM spaces WHERE id = $1', [params.spaceId],
      );
      return { ...result.rows[0]!, role: membership.role };
    });
    return reply.send({ space: { id: space.id, name: space.name, kind: space.kind, role: space.role, createdAt: space.created_at.toISOString() } });
  });

  app.get('/v1/spaces/:spaceId/members', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const params = paramSpace(reply, request);
    if (!params) return;
    const auth = requireAuth(request);
    const members = await transaction(pool, async (client) => {
      await client.query('SELECT id FROM spaces WHERE id = $1 FOR SHARE', [params.spaceId]);
      await requireMembershipInTransaction(client, auth.userId, params.spaceId, 'viewer');
      return client.query<{ id: string; email_normalized: string; role: 'owner' | 'editor' | 'viewer'; joined_at: Date }>(
        `SELECT u.id, u.email_normalized, m.role, m.joined_at
         FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = $1 ORDER BY m.joined_at, u.id`,
        [params.spaceId],
      );
    });
    return reply.send({ members: members.rows.map((member) => ({
      user: { id: member.id, email: member.email_normalized }, role: member.role, joinedAt: member.joined_at.toISOString(),
    })) });
  });

  app.post('/v1/spaces/:spaceId/invitations', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const params = paramSpace(reply, request);
    if (!params) return;
    const body = parse(reply, invitationCreateSchema, request.body);
    if (!body) return;
    const auth = requireAuth(request);
    const token = createOpaqueToken();
    const tokenHash = hashOpaqueToken(token, config.sessionTokenPepper);
    const invitation = await transaction(pool, async (client) => {
      const space = await client.query<{ kind: 'personal' | 'household' }>('SELECT kind FROM spaces WHERE id = $1 FOR UPDATE', [params.spaceId]);
      if (!space.rowCount) throw new ApiFault(403, 'SPACE_ACCESS_DENIED', 'Current workspace membership is required.');
      if (space.rows[0]!.kind !== 'household') throw new ApiFault(409, 'PERSONAL_SPACE', 'Personal spaces cannot invite other accounts.');
      await requireMembershipInTransaction(client, auth.userId, params.spaceId, 'owner');
      const result = await client.query<{
        id: string; email_normalized: string; role: 'editor' | 'viewer'; expires_at: Date; created_at: Date;
      }>(
        `INSERT INTO space_invitations(space_id, email_normalized, role, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, now() + ($5::text || ' days')::interval, $6)
         RETURNING id, email_normalized, role, expires_at, created_at`,
        [params.spaceId, normalizeEmail(body.email), body.role, tokenHash, INVITATION_DAYS, auth.userId],
      );
      return result.rows[0]!;
    });
    return reply.code(201).send({
      invitation: {
        id: invitation.id, email: invitation.email_normalized, role: invitation.role,
        expiresAt: invitation.expires_at.toISOString(), createdAt: invitation.created_at.toISOString(), token,
      },
    });
  });

  app.get('/v1/spaces/:spaceId/invitations', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const params = paramSpace(reply, request);
    if (!params) return;
    const auth = requireAuth(request);
    const invitations = await transaction(pool, async (client) => {
      const space = await client.query<{ kind: 'personal' | 'household' }>('SELECT kind FROM spaces WHERE id = $1 FOR SHARE', [params.spaceId]);
      if (!space.rowCount) throw new ApiFault(403, 'SPACE_ACCESS_DENIED', 'Current workspace membership is required.');
      if (space.rows[0]!.kind !== 'household') throw new ApiFault(409, 'PERSONAL_SPACE', 'Personal spaces do not have invitations.');
      await requireMembershipInTransaction(client, auth.userId, params.spaceId, 'owner');
      return client.query<{
        id: string; email_normalized: string; role: 'editor' | 'viewer'; expires_at: Date; created_at: Date;
      }>(
        `SELECT id, email_normalized, role, expires_at, created_at FROM space_invitations
         WHERE space_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at`,
        [params.spaceId],
      );
    });
    return reply.send({ invitations: invitations.rows.map((invite) => ({
      id: invite.id, email: invite.email_normalized, role: invite.role,
      expiresAt: invite.expires_at.toISOString(), createdAt: invite.created_at.toISOString(),
    })) });
  });

  app.post('/v1/invitations/accept', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const body = parse(reply, invitationAcceptSchema, request.body);
    if (!body) return;
    const auth = requireAuth(request);
    const tokenHash = hashOpaqueToken(body.token, config.sessionTokenPepper);
    const accepted = await transaction(pool, async (client) => {
      const found = await client.query<{
        id: string; space_id: string; email_normalized: string; role: 'editor' | 'viewer'; expires_at: Date; accepted_at: Date | null;
      }>('SELECT * FROM space_invitations WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
      const invitation = found.rows[0];
      if (!invitation) throw new ApiFault(404, 'INVITATION_NOT_FOUND', 'Invitation token is invalid.');
      if (invitation.accepted_at) throw new ApiFault(409, 'INVITATION_USED', 'Invitation has already been accepted.');
      if (invitation.expires_at.getTime() <= Date.now()) throw new ApiFault(410, 'INVITATION_EXPIRED', 'Invitation has expired.');
      if (auth.email !== invitation.email_normalized) throw new ApiFault(403, 'INVITATION_EMAIL_MISMATCH', 'Sign in with the invited email address to accept.');
      const space = await client.query<{ id: string; name: string; kind: 'household'; created_at: Date }>(
        "SELECT id, name, kind, created_at FROM spaces WHERE id = $1 AND kind = 'household' FOR UPDATE",
        [invitation.space_id],
      );
      if (!space.rowCount) throw new ApiFault(410, 'INVITATION_EXPIRED', 'The invited workspace is no longer available.');
      const membership = await client.query('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [invitation.space_id, auth.userId]);
      if (membership.rowCount) throw new ApiFault(409, 'ALREADY_A_MEMBER', 'This account already belongs to the workspace.');
      await client.query('INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $2, $3)', [invitation.space_id, auth.userId, invitation.role]);
      await client.query('UPDATE space_invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [invitation.id, auth.userId]);
      return {
        id: space.rows[0]!.id,
        name: space.rows[0]!.name,
        kind: space.rows[0]!.kind,
        role: invitation.role,
        createdAt: space.rows[0]!.created_at.toISOString(),
      };
    });
    return reply.send({ space: accepted });
  });

  async function removeMembership(spaceId: string, targetUserId: string, actorUserId: string, ownerOnly: boolean): Promise<void> {
    await transaction(pool, async (client) => {
      const spaceResult = await client.query<{ kind: 'personal' | 'household' }>('SELECT kind FROM spaces WHERE id = $1 FOR UPDATE', [spaceId]);
      const space = spaceResult.rows[0];
      if (!space) throw new ApiFault(403, 'SPACE_ACCESS_DENIED', 'Current workspace membership is required.');
      await requireMembershipInTransaction(client, actorUserId, spaceId, ownerOnly ? 'owner' : 'viewer');
      const target = await client.query<{ role: 'owner' | 'editor' | 'viewer' }>(
        'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2 FOR UPDATE', [spaceId, targetUserId],
      );
      if (!target.rowCount) throw new ApiFault(404, 'MEMBER_NOT_FOUND', 'Workspace member was not found.');
      if (target.rows[0]!.role === 'owner') {
        const ownerCount = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM space_members WHERE space_id = $1 AND role = 'owner'", [spaceId],
        );
        if (space.kind === 'personal' || Number(ownerCount.rows[0]!.count) <= 1) {
          throw new ApiFault(409, 'LAST_OWNER', 'The last workspace owner cannot leave or be removed.');
        }
      }
      await client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, targetUserId]);
    });
  }

  app.delete('/v1/spaces/:spaceId/members/:userId', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const params = parse(reply, z.object({ spaceId: uuidSchema, userId: uuidSchema }).strict(), request.params);
    if (!params) return;
    const auth = requireAuth(request);
    await removeMembership(params.spaceId, params.userId, auth.userId, true);
    return reply.code(204).send();
  });

  app.post('/v1/spaces/:spaceId/leave', { preHandler: authGuard(pool, config.sessionTokenPepper) }, async (request, reply) => {
    const params = paramSpace(reply, request);
    if (!params) return;
    const auth = requireAuth(request);
    await removeMembership(params.spaceId, auth.userId, auth.userId, false);
    return reply.code(204).send();
  });

  return app;
}
