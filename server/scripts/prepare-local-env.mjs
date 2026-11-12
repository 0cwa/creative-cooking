import { randomBytes } from 'node:crypto';
import { open, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const serverDir = dirname(dirname(fileURLToPath(import.meta.url)));
const envFile = join(serverDir, '.env');
try {
  await access(envFile, constants.F_OK);
  console.info('server/.env already exists; left it unchanged.');
} catch {
  const databasePassword = randomBytes(32).toString('hex');
  const pepper = randomBytes(32).toString('hex');
  const contents = [
    `DATABASE_URL=postgres://creative_cooking:${databasePassword}@127.0.0.1:55439/creative_cooking`,
    `TEST_DATABASE_URL=postgres://creative_cooking:${databasePassword}@127.0.0.1:55439/creative_cooking_test`,
    `POSTGRES_PASSWORD=${databasePassword}`,
    `SESSION_TOKEN_PEPPER=${pepper}`,
    'API_ORIGINS=http://localhost:8081,http://127.0.0.1:8081',
    'HOST=127.0.0.1',
    'PORT=8787',
    'LOG_LEVEL=info',
    '',
  ].join('\n');
  const handle = await open(envFile, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
  console.info('Created server/.env with random local-only secrets.');
}
