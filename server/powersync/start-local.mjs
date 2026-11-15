import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const powersyncDir = dirname(fileURLToPath(import.meta.url));
const serverDir = dirname(powersyncDir);
const envFile = join(serverDir, '.env');
if (!existsSync(envFile)) throw new Error('Create server/.env with npm run prepare:local first.');
process.loadEnvFile(envFile);

const databaseUrl = process.env.NODE_ENV === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required.');
const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
  || !['/creative_cooking', '/creative_cooking_test'].includes(database.pathname)) {
  throw new Error('The local PowerSync launcher only accepts the loopback creative_cooking databases.');
}
if (process.env.NODE_ENV === 'test' && database.pathname !== '/creative_cooking_test') {
  throw new Error('Test mode is restricted to creative_cooking_test.');
}

function serviceDatabaseUrl(username, password) {
  const url = new URL(databaseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

const service = join(powersyncDir, 'node_modules', '.bin', 'powersync-service');
if (!existsSync(service)) throw new Error('Install the pinned Service runtime with npm ci --prefix server/powersync.');
const child = spawn(service, ['start', '-c', 'service.yaml'], {
  cwd: powersyncDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    PS_DATA_SOURCE_URI: serviceDatabaseUrl('cc_powersync_replication', process.env.POWERSYNC_REPLICATION_PASSWORD ?? ''),
    PS_STORAGE_SOURCE_URI: serviceDatabaseUrl('cc_powersync_storage', process.env.POWERSYNC_STORAGE_PASSWORD ?? ''),
    PS_PORT: process.env.POWERSYNC_PORT ?? '8080',
    PS_JWKS_URL: `http://127.0.0.1:${process.env.PORT ?? '8787'}/v1/sync/jwks`,
  },
});

child.on('error', (error) => {
  process.stderr.write(`Could not start PowerSync Service: ${error.message}\n`);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
