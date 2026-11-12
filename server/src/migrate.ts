import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
const migrationsDir = join(process.cwd(), 'migrations');

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.up.sql')).sort();
  for (const name of files) {
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [402801129]);
      const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) throw new Error(`Applied migration was changed: ${name}`);
      } else {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
        console.info(`Applied ${name}`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
