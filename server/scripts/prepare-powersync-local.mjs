import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const envFile = join(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const databaseUrl = process.env.NODE_ENV === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required.');
const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
  || !['/creative_cooking', '/creative_cooking_test'].includes(database.pathname)) {
  throw new Error('PowerSync role preparation is restricted to the loopback creative_cooking databases.');
}
if (process.env.NODE_ENV === 'test' && database.pathname !== '/creative_cooking_test') {
  throw new Error('Test mode is restricted to creative_cooking_test.');
}

const replicationPassword = process.env.POWERSYNC_REPLICATION_PASSWORD;
const storagePassword = process.env.POWERSYNC_STORAGE_PASSWORD;
if (!replicationPassword || replicationPassword.length < 32 || !storagePassword || storagePassword.length < 32) {
  throw new Error('Local PowerSync passwords must be present and at least 32 characters.');
}

const publicationTables = [
  'spaces', 'space_members', 'pantry_items', 'recipes', 'recipe_ingredients', 'recipe_steps', 'recipe_conflicts',
  'shopping_lists', 'shopping_cycles', 'shopping_items', 'shopping_purchases',
];
const roleComments = 'creative-cooking local PowerSync fixture role';
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

async function ensureRole(client, role, password, replication) {
  const found = await client.query(
    `SELECT shobj_description(oid, 'pg_authid') AS comment FROM pg_roles WHERE rolname = $1`, [role],
  );
  const passwordLiteral = (await client.query('SELECT quote_literal($1) AS quoted', [password])).rows[0].quoted;
  if (found.rowCount) {
    if (found.rows[0].comment !== roleComments) {
      throw new Error(`Role ${role} already exists and is not marked as this local fixture's role; it was left unchanged.`);
    }
    await client.query(`ALTER ROLE ${role} WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE ${replication ? 'REPLICATION' : 'NOREPLICATION'} CONNECTION LIMIT 5 PASSWORD ${passwordLiteral}`);
  } else {
    await client.query(`CREATE ROLE ${role} WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE ${replication ? 'REPLICATION' : 'NOREPLICATION'} CONNECTION LIMIT 5 PASSWORD ${passwordLiteral}`);
    const commentLiteral = (await client.query('SELECT quote_literal($1) AS quoted', [roleComments])).rows[0].quoted;
    await client.query(`COMMENT ON ROLE ${role} IS ${commentLiteral}`);
  }
}

try {
  const client = await pool.connect();
  try {
    const walLevel = await client.query('SHOW wal_level');
    if (walLevel.rows[0]?.wal_level !== 'logical') {
      throw new Error('Postgres wal_level must be logical; start the local fixture with server/compose.yaml settings.');
    }
    const publication = await client.query(
      `SELECT tablename FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' ORDER BY tablename`,
    );
    const actualTables = publication.rows.map((row) => row.tablename).sort();
    if (JSON.stringify(actualTables) !== JSON.stringify([...publicationTables].sort())) {
      throw new Error(`The powersync publication table allowlist does not match migration 002 (found ${actualTables.length} tables).`);
    }

    await ensureRole(client, 'cc_powersync_replication', replicationPassword, true);
    await ensureRole(client, 'cc_powersync_storage', storagePassword, false);
    await client.query(`GRANT CONNECT ON DATABASE ${database.pathname.slice(1)} TO cc_powersync_replication, cc_powersync_storage`);
    await client.query('GRANT USAGE ON SCHEMA public TO cc_powersync_replication, cc_powersync_storage');
    await client.query(`GRANT SELECT ON TABLE ${publicationTables.map((name) => `public.${name}`).join(', ')} TO cc_powersync_replication`);
    await client.query(`GRANT CREATE ON DATABASE ${database.pathname.slice(1)} TO cc_powersync_storage`);
    await client.query('GRANT CREATE, USAGE ON SCHEMA public TO cc_powersync_storage');

    const privileges = await client.query(
      `SELECT
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
           AND has_table_privilege('cc_powersync_replication', c.oid, 'SELECT')) AS replication_tables,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($2::text[])
           AND has_table_privilege('cc_powersync_replication', c.oid, 'SELECT')) AS sensitive_tables`,
      [publicationTables, ['users', 'auth_sessions', 'space_invitations', 'content_mutations']],
    );
    if (privileges.rows[0]?.replication_tables !== publicationTables.length || privileges.rows[0]?.sensitive_tables !== 0) {
      throw new Error('PowerSync replication role privileges failed the allowlist check.');
    }
    console.info(`Prepared local PowerSync roles for ${database.pathname.slice(1)}; ${publicationTables.length} allowlisted tables, 0 sensitive tables readable.`);
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
