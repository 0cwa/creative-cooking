import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_TOKEN_PEPPER: z.string().min(32),
  API_ORIGINS: z.string().default(''),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface ServerConfig {
  databaseUrl: string;
  sessionTokenPepper: string;
  allowedOrigins: string[];
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env === process.env) {
    const localEnvFile = join(process.cwd(), '.env');
    if (existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);
  }
  let configEnv = env;
  if (env.NODE_ENV === 'test') {
    if (!env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required in test mode.');
    const testDatabase = new URL(env.TEST_DATABASE_URL);
    const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(testDatabase.hostname);
    if (!isLoopback || testDatabase.pathname !== '/creative_cooking_test') {
      throw new Error('Test mode is restricted to the loopback creative_cooking_test database.');
    }
    configEnv = { ...env, DATABASE_URL: env.TEST_DATABASE_URL };
  }
  const parsed = envSchema.parse(configEnv);
  const allowedOrigins = parsed.API_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
      throw new Error(`API_ORIGINS contains an invalid or insecure origin: ${origin}`);
    }
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    sessionTokenPepper: parsed.SESSION_TOKEN_PEPPER,
    allowedOrigins,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
  };
}
