/*
 * Security regression: real Chromium WASM -> real pinned Rust CLI with
 * --auth keyhive (NEVER --auth open), disposable localhost infrastructure.
 * This is NOT ARK E2EE; it attacks the actual Keyhive-enabled server's
 * legacy namespace. A successful unauthorized access MUST fail the test.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

let server: ChildProcess | undefined;
let folder: string;
let port: number;
let output = '';
const service = 'cc-auth-keyhive-local-only';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function findPort() {
  return await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') return reject(Error('No port'));
      s.close(() => resolve(addr.port));
    });
  });
}
async function start() {
  folder = mkdtempSync(join(tmpdir(), 'cc-auth-keyhive-'));
  port = await findPort();
  const key = join(folder, 'server-key');
  writeFileSync(key, '6b'.repeat(32) + '\n', { mode: 0o600 });
  const binary = process.env.CC_SUBDUCTION_CLI;
  if (!binary || !existsSync(binary)) throw Error('CC_SUBDUCTION_CLI must be an existing binary');
  const args = ['server', '--socket', '127.0.0.1:' + port,
    '--service-name', service, '--auth', 'keyhive',
    '--key-file', key, '--data-dir', join(folder, 'data')];
  console.log('CC_SECURITY_SERVER_AUTH=keyhive');
  server = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-25000); };
  server.stdout?.on('data', onData);
  server.stderr?.on('data', onData);
  server.on('error', err => { output += String(err); });
  for (let i = 0; i < 250; i++) {
    if (server.exitCode !== null) throw Error('Server failed: ' + output);
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => { s.destroy(); resolve(); });
        s.once('error', reject);
      });
      return;
    } catch { await sleep(100); }
  }
  throw Error('Server unavailable: ' + output);
}
async function stop() {
  const p = server;
  server = undefined;
  if (p && p.exitCode === null) {
    await Promise.race([
      new Promise<void>(resolve => { p.once('exit', () => resolve()); p.kill('SIGTERM'); }),
      sleep(4000).then(() => { if (p.exitCode === null) p.kill('SIGKILL'); })
    ]);
  }
  if (folder) rmSync(folder, { recursive: true, force: true });
}
async function client(browser: any, legacy: boolean) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:9891/');
  await page.waitForFunction(() => (window as any).subductionReady === true, { timeout: 45000 });
  await page.evaluate(async ({ port, service, legacy }: { port: number; service: string; legacy: boolean }) => {
    const api = (window as any).subduction;
    const signer = await api.WebCryptoSigner.setup();
    const syncer = new api.Subduction({ signer, storage: new api.MemoryStorage() });
    const peer = await syncer.connectDiscover(new URL('ws://127.0.0.1:' + port), service);
    let docId: Uint8Array;
    if (legacy) {
      // Legacy 16-byte ID with zero-padded high half: the *real* CLI bypass predicate.
      docId = new Uint8Array(32);
      docId.set([0x63, 0x63, 0x2a, 0x50, 0x51, 0x19, 0x26, 0x01], 0);
    } else {
      // Valid Ed25519 public key: a protected-shaped, but unregistered, document.
      const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      docId = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    }
    (window as any).ccSecurity = { syncer, peer, sid: api.SedimentreeId.fromBytes(docId) };
  }, { port, service, legacy });
  return { page, context };
}
async function upload(page: any, data: number[]) {
  return page.evaluate(async (data: number[]) => {
    const api = (window as any).subduction;
    const t = (window as any).ccSecurity;
    const shaBytes = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
    await t.syncer.addCommit(t.sid, new api.CommitId(new Uint8Array(shaBytes)), [], new Uint8Array(data));
    const result = await t.syncer.syncWithPeer(t.peer, t.sid, true, 15000);
    return { success: result.success, sent: result.stats.commitsSent };
  }, data);
}
async function receive(page: any) {
  return page.evaluate(async () => {
    const t = (window as any).ccSecurity;
    const result = await t.syncer.syncWithPeer(t.peer, t.sid, true, 15000);
    const blobs = await t.syncer.getBlobs(t.sid);
    return { success: result.success, count: blobs.length,
      sha256Available: blobs.length > 0 };
  });
}
async function unknownPeerSees(page: any) {
  let last;
  for (let i = 0; i < 45; i++) {
    last = await receive(page);
    if (last.count > 0) return last;
    await sleep(130);
  }
  return last;
}
test.beforeEach(start);
test.afterEach(stop);

test('legacy 16-byte ID MUST NOT disclose a foreign household blob under --auth keyhive', async ({ browser }, info) => {
  test.setTimeout(120000);
  const a = await client(browser, true);
  const stranger = await client(browser, true);
  const body = Array.from(new TextEncoder().encode('SYNTHETIC PRIVATE RECIPE chickpeas lemon - unprotected attack'));
  try {
    const sent = await upload(a.page, body);
    const seen = await unknownPeerSees(stranger.page);
    const data = {
      idClass: '16-byte zero-padded LEGACY (unprotected)', serverAuth: 'keyhive',
      expected: 'deny unknown household peer', observed: seen.count > 0 ? 'UNAUTHORIZED_READ' : 'DENY',
      sent, received: seen, bytes: body.length,
      sha256: createHash('sha256').update(Buffer.from(body)).digest('hex'),
      upstreamCommit: 'f0af1aab5f2fd44e5b224c22fc8b62660d50bc01'
    };
    console.log('CC_SECURITY_MATRIX=' + JSON.stringify(data));
    await info.attach('legacy-id-unauthorized-read.json', { body: JSON.stringify(data, null, 2),
      contentType: 'application/json' });
    // Intentionally FAILS LOUDLY if upstream still admits legacy IDs.
    expect(seen.count, 'SECURITY FAIL: an ungranted attacker fetched an unprotected legacy-ID blob').toBe(0);
  } finally {
    await a.context.close();
    await stranger.context.close();
  }
});

test('protected-shaped but unregistered document rejects unauthenticated writes', async ({ browser }, info) => {
  test.setTimeout(120000);
  const a = await client(browser, false);
  const stranger = await client(browser, false);
  try {
    // Use the same public document ID from the writer; never invent a keyhive grant.
    const bytes = await a.page.evaluate(() => Array.from((window as any).ccSecurity.sid.toBytes()));
    await stranger.page.evaluate((bytes: number[]) => {
      const api = (window as any).subduction;
      (window as any).ccSecurity.sid = api.SedimentreeId.fromBytes(new Uint8Array(bytes));
    }, bytes);
    const data = Array.from(new TextEncoder().encode('SYNTHETIC UNREGISTERED PROTECTED ATTACK'));
    let result;
    try { result = await upload(a.page, data); }
    catch (e) { result = { rejected: String(e) }; }
    const response = await receive(stranger.page).catch(e => ({ error: String(e), count: 0 }));
    const record = {
      idClass: 'full Ed25519 protected-shaped but NEVER Keyhive-registered',
      serverAuth: 'keyhive', expected: 'deny writes and foreign reads',
      observed: response.count > 0 ? 'UNAUTHORIZED_READ' : 'NO_FOREIGN_BLOB',
      attemptedWrite: result, foreignRead: response, bytes: data.length,
      upstreamCommit: 'f0af1aab5f2fd44e5b224c22fc8b62660d50bc01'
    };
    console.log('CC_SECURITY_MATRIX=' + JSON.stringify(record));
    await info.attach('protected-unregistered.json', { body: JSON.stringify(record, null, 2),
      contentType: 'application/json' });
    expect(response.count, 'unregistered protected doc leaked to ungranted peer').toBe(0);
  } finally {
    await a.context.close();
    await stranger.context.close();
  }
});
