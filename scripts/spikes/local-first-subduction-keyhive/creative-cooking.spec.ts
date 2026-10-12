/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Runs IN the pinned upstream Subduction WASM Playwright harness, with two real
 * Chromium pages, a real local Rust CLI, and encrypted Automerge change bytes.
 * This is a test, not a Creative Cooking runtime integration.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import * as Automerge from '@automerge/automerge';

type Change = { kind: string; head: number[]; ciphertext: number[]; plainSha256: string; plainLength: number; ciphertextLength: number };
type Fixtures = { key: number[]; changes: Change[]; expected: Record<string, unknown>; plaintextSentinels: string[] };
const fixturePath = process.env.CC_SUBDUCTION_FIXTURES;
const binary = process.env.CC_SUBDUCTION_CLI;
if (!fixturePath || !binary) throw new Error('Set CC_SUBDUCTION_FIXTURES and CC_SUBDUCTION_CLI to local files');
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixtures;
const serviceName = 'creative-cooking-local-subduction-spike';
const testRoot = mkdtempSync(join(tmpdir(), 'creative-cooking-subduction-'));
const dataDir = join(testRoot, 'relay');
const seedFile = join(testRoot, 'server-key');
writeFileSync(seedFile, 'ab'.repeat(32) + '\n', { mode: 0o600 });
let server: ChildProcess | null = null;
let port = 0;
let serverLog = '';
let wsUrl = '';
let httpUrl = '';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') return reject(new Error('No port assigned'));
      listener.close(() => resolve(address.port));
    });
  });
}
async function awaitPort(target: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(target, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
        socket.setTimeout(300, () => { socket.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch {
      if (server?.exitCode !== null) throw new Error('Subduction exited early: ' + serverLog.slice(-10000));
      await delay(100);
    }
  }
  throw new Error('Subduction did not listen: ' + serverLog.slice(-10000));
}
async function startServer() {
  server = spawn(binary!, ['server', '--socket', '127.0.0.1:' + port,
    '--service-name', serviceName, '--auth', 'open',
    '--key-file', seedFile, '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', error => { serverLog += String(error); });
  server.stdout?.on('data', bytes => { serverLog = (serverLog + bytes.toString()).slice(-100000); });
  server.stderr?.on('data', bytes => { serverLog = (serverLog + bytes.toString()).slice(-100000); });
  await awaitPort(port);
}
async function stopServer() {
  const running = server;
  if (!running) return;
  server = null;
  if (running.exitCode !== null) return;
  await Promise.race([
    new Promise<void>(resolve => {
      running.once('exit', () => resolve());
      running.kill('SIGTERM');
    }),
    delay(4000).then(() => { if (running.exitCode === null) running.kill('SIGKILL'); })
  ]);
}
async function newClient(browser: any, transport: 'ws' | 'lp' = 'ws') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:9891/');
  await page.waitForFunction(() => (window as any).subductionReady === true, { timeout: 45000 });
  await page.evaluate(async ({ws, http, service, transport}) => {
    const api = (window as any).subduction;
    const signer = await api.WebCryptoSigner.setup();
    const syncer = new api.Subduction({ signer, storage: new api.MemoryStorage() });
    const peer = transport === 'lp'
      ? await syncer.connectDiscoverLongPoll(http, service)
      : await syncer.connectDiscover(new URL(ws), service);
    (window as any).ccTest = {
      syncer, peer,
      sid: api.SedimentreeId.fromBytes(new Uint8Array(32).fill(53))
    };
  }, {ws: wsUrl, http: httpUrl, service: serviceName, transport});
  return {context, page};
}
async function reconnect(page: any, transport: 'ws' | 'lp' = 'ws') {
  await page.evaluate(async ({ws, http, service, transport}: any) => {
    const t = (window as any).ccTest;
    t.peer = transport === 'lp'
      ? await t.syncer.connectDiscoverLongPoll(http, service)
      : await t.syncer.connectDiscover(new URL(ws), service);
  }, {ws: wsUrl, http: httpUrl, service: serviceName, transport});
}
async function push(page: any, index: number) {
  return await page.evaluate(async ({change, prev}: any) => {
    const api = (window as any).subduction;
    const t = (window as any).ccTest;
    await t.syncer.addCommit(t.sid, new api.CommitId(new Uint8Array(change.head)),
      prev ? [new api.CommitId(new Uint8Array(prev.head))] : [],
      new Uint8Array(change.ciphertext));
    const result = await t.syncer.syncWithPeer(t.peer, t.sid, true, 15000);
    return {success: result.success, sent: result.stats.commitsSent,
      received: result.stats.commitsReceived};
  }, {change: fixtures.changes[index], prev: fixtures.changes[index - 1] ?? null});
}
async function pull(page: any) {
  return await page.evaluate(async () => {
    const t = (window as any).ccTest;
    const result = await t.syncer.syncWithPeer(t.peer, t.sid, true, 15000);
    const commits = await t.syncer.getCommits(t.sid);
    return {
      success: result.success, sent: result.stats.commitsSent,
      received: result.stats.commitsReceived,
      count: commits?.length ?? 0
    };
  });
}
// Subduction can finish an exchange before the relay propagates/apply-writes
// the commit to a second subscriber. Upstream relay_topology_sync.rs also
// polls until the receiving peer has the expected commits.
async function eventuallyPull(page: any, expectedCount: number) {
  const deadline = Date.now() + 18000;
  let last: Awaited<ReturnType<typeof pull>> | undefined;
  while (Date.now() < deadline) {
    last = await pull(page);
    if (last.success && last.count === expectedCount) return last;
    if (last.count > expectedCount) {
      throw new Error('Unexpected surplus commits: ' + JSON.stringify({expectedCount, last}));
    }
    await delay(150);
  }
  throw new Error('Timed out waiting for relay catch-up: ' +
    JSON.stringify({expectedCount, last, serverLog: serverLog.slice(-2500)}));
}
async function encryptedBlobs(page: any): Promise<number[][]> {
  return await page.evaluate(async () => {
    const t = (window as any).ccTest;
    const blobs = await t.syncer.getBlobs(t.sid);
    return blobs.map((item: Uint8Array) => Array.from(item));
  });
}
function verifyReconstructed(blobs: number[][], expectedKinds: string[]) {
  const decoded = new Map<string, Uint8Array>();
  for (const entry of blobs) {
    const bytes = Buffer.from(entry);
    const iv = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(fixtures.key), iv);
    cipher.setAuthTag(tag);
    const decrypted = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    const hash = createHash('sha256').update(decrypted).digest('hex');
    decoded.set(hash, new Uint8Array(decrypted));
  }
  let doc = Automerge.init();
  for (const change of fixtures.changes.filter(c => expectedKinds.includes(c.kind))) {
    const bytes = decoded.get(change.plainSha256);
    expect(bytes, 'Missing authenticated Automerge change ' + change.kind).toBeDefined();
    [doc] = Automerge.applyChanges(doc, [bytes!]);
  }
  if (expectedKinds.length === fixtures.changes.length) {
    expect(Automerge.toJS(doc)).toEqual(fixtures.expected);
  } else {
    const partial = Automerge.toJS(doc) as any;
    expect(partial.pantry?.[0]?.name).toBe('chickpeas (cooked)');
  }
  expect(decoded.size).toBe(expectedKinds.length);
}
function allFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap(name => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  port = await freePort();
  wsUrl = 'ws://127.0.0.1:' + port;
  httpUrl = 'http://127.0.0.1:' + port;
  await startServer();
});
test.afterAll(async () => {
  await stopServer();
  rmSync(testRoot, { recursive: true, force: true });
});

test('encrypted real Automerge updates: two browsers, durable offline catch-up, restart, incremental, dedup and HTTP long poll', async ({ browser }, testInfo) => {
  test.setTimeout(180000);
  const a = await newClient(browser);
  const b = await newClient(browser);
  let c: Awaited<ReturnType<typeof newClient>> | undefined;
  const evidence: Record<string, unknown> = {
    transport: 'WebSocket + HTTP long poll', storage: 'redb + fs',
    fixturePlainLengths: fixtures.changes.map(change => change.plainLength),
    encryptedBlobLengths: fixtures.changes.map(change => change.ciphertextLength)
  };
  try {
    const firstPush = await push(a.page, 0);
    console.log("Initial push stats: " + JSON.stringify(firstPush));
    expect(firstPush.success).toBe(true);
    const first = await eventuallyPull(b.page, 1);
    console.log("Initial receiver stats: " + JSON.stringify(first));
    expect(first.success).toBe(true);
    expect(first.count).toBe(1);
    verifyReconstructed(await encryptedBlobs(b.page), ['pantry']);
    evidence.first = { firstPush, firstPull: first };

    // B is disconnected. A edits, uploads and then goes completely offline.
    await b.page.evaluate(async () => (window as any).ccTest.syncer.disconnectAll());
    expect((await push(a.page, 1)).success).toBe(true);
    await a.page.evaluate(async () => (window as any).ccTest.syncer.disconnectAll());

    // Durable relay must outlive BOTH app peers and itself (same storage/key).
    await stopServer();
    expect(existsSync(join(dataDir, 'sedimentree.redb'))).toBe(true);
    await startServer();
    await reconnect(b.page);
    const catchup = await eventuallyPull(b.page, 2);
    expect(catchup.success).toBe(true);
    expect(catchup.count).toBe(2);
    verifyReconstructed(await encryptedBlobs(b.page), ['pantry', 'recipe']);
    evidence.catchupAfterRelayRestart = catchup;

    await reconnect(a.page);
    expect((await push(a.page, 2)).success).toBe(true);
    const delta = await eventuallyPull(b.page, 3);
    expect(delta.success).toBe(true);
    expect(delta.count).toBe(3);
    const idle = await pull(b.page);
    expect(idle.success).toBe(true);
    expect(idle.count).toBe(3);
    expect(idle.received).toBe(0);
    evidence.incremental = { delta, idle };

    // Duplicate identical commit (not a new JSON snapshot).
    expect((await push(a.page, 2)).success).toBe(true);
    const duplicate = await eventuallyPull(b.page, 3);
    expect(duplicate.success).toBe(true);
    expect(duplicate.count).toBe(3);
    evidence.duplicate = duplicate;

    verifyReconstructed(await encryptedBlobs(b.page), ['pantry', 'recipe', 'chat']);
    await b.page.evaluate(async () => (window as any).ccTest.syncer.disconnectAll());
    await reconnect(b.page);
    const reconnectRound = await eventuallyPull(b.page, 3);
    expect(reconnectRound.success).toBe(true);
    expect(reconnectRound.count).toBe(3);
    evidence.cleanReconnect = reconnectRound;

    c = await newClient(browser, 'lp');
    const longpoll = await eventuallyPull(c.page, 3);
    expect(longpoll.success).toBe(true);
    expect(longpoll.count).toBe(3);
    verifyReconstructed(await encryptedBlobs(c.page), ['pantry', 'recipe', 'chat']);
    evidence.httpLongPoll = longpoll;

    // Relay storage does not contain any app plaintext sentinel.
    const filenames = allFiles(dataDir);
    expect(filenames.some(file => file.endsWith('sedimentree.redb'))).toBe(true);
    for (const file of filenames) {
      const raw = readFileSync(file);
      for (const needle of fixtures.plaintextSentinels) {
        expect(raw.includes(Buffer.from(needle)), 'Plaintext in ' + file).toBe(false);
      }
    }
    evidence.relayFiles = filenames.map(file => file.replace(testRoot, '<test-dir>'));
    evidence.storagePlaintextSentinelsAbsent = true;
    console.log('CC_SUBDUCTION_EVIDENCE=' + JSON.stringify(evidence));
    await testInfo.attach('subduction-evidence.json', {
      body: JSON.stringify(evidence, null, 2), contentType: 'application/json'
    });
  } finally {
    if (c) await c.context.close();
    await a.context.close();
    await b.context.close();
  }
});
