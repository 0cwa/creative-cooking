import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const baseEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:password@127.0.0.1:55439/creative_cooking',
  SESSION_TOKEN_PEPPER: 'p'.repeat(32),
  API_ORIGINS: 'http://localhost:8081',
};

test('test mode cannot migrate a development or remote database', () => {
  assert.throws(
    () => loadConfig({ ...baseEnvironment, TEST_DATABASE_URL: 'postgres://user:password@127.0.0.1:55439/creative_cooking' }),
    /loopback creative_cooking_test/,
  );
  assert.throws(
    () => loadConfig({ ...baseEnvironment, TEST_DATABASE_URL: 'postgres://user:password@test.example/creative_cooking_test' }),
    /loopback creative_cooking_test/,
  );
  assert.equal(
    loadConfig({ ...baseEnvironment, TEST_DATABASE_URL: 'postgres://user:password@127.0.0.1:55439/creative_cooking_test' }).databaseUrl,
    'postgres://user:password@127.0.0.1:55439/creative_cooking_test',
  );
  assert.throws(() => loadConfig(baseEnvironment), /TEST_DATABASE_URL is required/);
});
