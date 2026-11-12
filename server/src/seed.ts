import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { hashPassword } from './security.js';

const config = loadConfig();
const database = new URL(config.databaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(database.hostname) || !['/creative_cooking', '/creative_cooking_test'].includes(database.pathname)) {
  throw new Error('Fixture seed is restricted to the local creative_cooking or creative_cooking_test database.');
}
const password = process.env.SEED_PASSWORD;
if (!password || password.length < 12 || password.length > 128) {
  throw new Error('Set SEED_PASSWORD to a local fixture password of 12 to 128 characters.');
}

const users = [
  { id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test' },
  { id: '10000000-0000-4000-8000-000000000002', email: 'member@example.test' },
  { id: '10000000-0000-4000-8000-000000000003', email: 'outsider@example.test' },
];
const personalSpaceIds = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
];
const householdId = '30000000-0000-4000-8000-000000000001';
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });

try {
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [index, user] of users.entries()) {
      await client.query(
        `INSERT INTO users(id, email_normalized, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET email_normalized = EXCLUDED.email_normalized, password_hash = EXCLUDED.password_hash`,
        [user.id, user.email, passwordHash],
      );
      await client.query(
        `INSERT INTO spaces(id, name, kind, created_by) VALUES ($1, 'Personal', 'personal', $2)
         ON CONFLICT (id) DO NOTHING`,
        [personalSpaceIds[index]!, user.id],
      );
      await client.query(
        `INSERT INTO space_members(space_id, user_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (space_id, user_id) DO NOTHING`,
        [personalSpaceIds[index]!, user.id],
      );
    }
    await client.query(
      `INSERT INTO spaces(id, name, kind, created_by) VALUES ($1, 'Seed household', 'household', $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [householdId, users[0]!.id],
    );
    await client.query(
      `INSERT INTO space_members(space_id, user_id, role) VALUES
       ($1, $2, 'owner'), ($1, $3, 'editor')
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [householdId, users[0]!.id, users[1]!.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.info('Seeded owner@example.test, member@example.test, outsider@example.test and one household.');
} finally {
  await pool.end();
}
