// Ordinary Chromium page proof, with a static HTTP host and a localhost-only
// durable WebCrypto ciphertext mailbox. This is NOT p2panda browser transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createGateway } from './gateway.mjs';

const htmlDir = join(dirname(fileURLToPath(import.meta.url)), 'browser');
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}
async function shutdown(server) {
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}
function staticServer() {
  return createServer(async (req, res) => {
    const name = new URL(req.url, 'http://127.0.0.1').pathname;
    const file = name === '/' || name === '/index.html' ? 'index.html' :
      name === '/interop.mjs' ? 'interop.mjs' : null;
    if (!file) { res.writeHead(404); res.end('not found'); return; }
    try {
      const body = await readFile(join(htmlDir, file));
      res.writeHead(200, {
        'Content-Type': file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500);
      res.end('static file error');
    }
  });
}

test('ordinary static Chromium browser encrypts before upload and recovers after all producer processes disappear', { timeout: 90_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-panda-chrome-'));
  const staticHost = staticServer();
  let mailbox = createGateway(dir);
  const siteUrl = await listen(staticHost);
  let mailboxUrl = await listen(mailbox);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await shutdown(mailbox);
    await shutdown(staticHost);
    await rm(dir, { recursive: true, force: true });
  });

  const publisher = await browser.newContext();
  const a = await publisher.newPage();
  await a.goto(siteUrl);
  await a.locator('#generate').click();
  const spaceId = await a.locator('#space').inputValue();
  const key = await a.locator('#key').inputValue();
  assert.match(spaceId, /^[a-f0-9]{32}$/);
  assert.match(key, /^[a-f0-9]{64}$/);
  await a.locator('#base').fill(mailboxUrl);
  const fixture = 'Browser encrypted catch-up: caf\u00e9 + exact binary bytes';
  await a.locator('#content').fill(fixture);
  await a.locator('#publish').click();
  await a.waitForFunction(() => document.querySelector('#log')?.textContent?.includes('Stored encrypted frame'));
  await publisher.close(); // the original browser device is gone

  await shutdown(mailbox); // service process is also gone
  mailbox = createGateway(dir);
  mailboxUrl = await listen(mailbox); // service returns with same persistent disk

  const reader = await browser.newContext(); // no cookies, local state, or shared browser keys
  const b = await reader.newPage();
  await b.goto(siteUrl);
  await b.locator('#base').fill(mailboxUrl);
  await b.locator('#space').fill(spaceId);
  await b.locator('#key').fill(key);
  await b.locator('#read').click();
  await b.waitForFunction(expected => document.querySelector('#log')?.textContent?.includes(expected), fixture);
  const output = await b.locator('#log').textContent();
  assert.ok(output.includes(fixture), output);

  // Browser WebCrypto APIs are used in-page, not replaced by Node polyfills.
  const cryptoProof = await b.evaluate(() => ({
    hasSubtleCrypto: typeof crypto.subtle?.decrypt === 'function',
    secureContext: isSecureContext
  }));
  assert.deepEqual(cryptoProof, { hasSubtleCrypto: true, secureContext: true });
  await reader.close();
});
