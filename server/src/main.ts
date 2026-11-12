import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 12, idleTimeoutMillis: 30_000 });
const app = await createApp({ pool, config });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'server startup failed');
  await app.close();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => pool.end());
  });
}
