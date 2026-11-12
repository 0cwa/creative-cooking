import assert from 'node:assert/strict';
import test from 'node:test';
import { accountApiRequest, AccountApiError, AccountTransportError, normalizeApiUrl } from './api.ts';

test('API URL accepts remote HTTPS and local HTTP only', () => {
  assert.equal(normalizeApiUrl('https://api.example.test/'), 'https://api.example.test');
  assert.equal(normalizeApiUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeApiUrl('http://localhost:8787/service/'), 'http://localhost:8787/service');
  assert.throws(() => normalizeApiUrl('http://api.example.test'), /Use HTTPS/);
  assert.throws(() => normalizeApiUrl('https://user:secret@api.example.test'), /cannot contain credentials/);
  assert.throws(() => normalizeApiUrl('https://api.example.test/v1/'), /without the \/v1 path/);
});

test('bearer request omits cookies and does not expose auth in request options', async () => {
  let observed;
  const fetchImpl = async (url, options) => {
    observed = { url, options };
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await accountApiRequest('https://api.example.test', '/me', {
    token: 'test-session-token',
    fetchImpl
  });

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(observed.url, 'https://api.example.test/v1/me');
  assert.equal(observed.options.credentials, 'omit');
  assert.equal(observed.options.headers.get('authorization'), 'Bearer test-session-token');
  assert.equal(observed.options.redirect, 'error');
});

test('ambiguous mutation transport failure is surfaced once without automatic retry', async () => {
  let calls = 0;
  await assert.rejects(accountApiRequest('https://api.example.test', '/spaces', {
    method: 'POST',
    body: { kind: 'household', name: 'Home' },
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('network failure');
    }
  }), (error) => error instanceof AccountTransportError && error.mutationMayHaveCompleted);
  assert.equal(calls, 1);
});

test('server error preserves machine code without retrying', async () => {
  let calls = 0;
  await assert.rejects(accountApiRequest('https://api.example.test', '/invitations/accept', {
    method: 'POST',
    body: { token: 'invalid' },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: 'INVITATION_EXPIRED', message: 'Invitation expired.' } }), {
        status: 410,
        headers: { 'content-type': 'application/json' }
      });
    }
  }), (error) => error instanceof AccountApiError && error.status === 410 && error.code === 'INVITATION_EXPIRED');
  assert.equal(calls, 1);
});
