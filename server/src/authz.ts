import type { FastifyRequest } from 'fastify';
import { Pool, type PoolClient } from 'pg';

export interface AuthContext {
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

export class ApiFault extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

const rolePower = { viewer: 1, editor: 2, owner: 3 } as const;

export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
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

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new ApiFault(401, 'AUTH_REQUIRED', 'A valid bearer session is required.');
  return request.auth;
}
