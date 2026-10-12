// Real p2panda process orchestration using only localhost/LAN mDNS.
// Isolated; no public relay, no fixture accounts; best-effort on CI runners.
// Demonstrates separate OS processes and actual A death, never merely Node::drop().
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const bin = resolve(process.argv[2] || 'experiments/p2panda/rust/target/debug/peer');
const topic = randomBytes(32).toString('hex');
const root = await mkdtemp(join(tmpdir(), 'cc-p2panda-processes-'));
const all = new Set();
const delay = ms => new Promise(r => setTimeout(r, ms));

function start(label, index, reuseName = label) {
  const db = join(root, reuseName + '.sqlite');
  const seed = index.toString(16).padStart(2, '0').repeat(32);
  const proc = spawn(bin, [topic, db, seed], { stdio: ['pipe', 'pipe', 'pipe'] });
  all.add(proc);
  const state = { label, proc, lines: [], listeners: new Set(), stderr: '' };
  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', s => {
    state.stderr += s;
    if (state.stderr.length > 10000) state.stderr = state.stderr.slice(-10000);
  });
  proc.stdout.on('data', str => {
    buffer += str;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      state.lines.push(line);
      if (state.lines.length > 250) state.lines.shift();
      console.log('[' + label + '] ' + line);
      for (const callback of state.listeners) callback(line);
    }
  });
  proc.on('exit', (code, signal) => {
    for (const callback of state.listeners) callback('PROCESS_EXITED:' + (signal || code));
  });
  return state;
}
function waitFor(peer, predicate, timeoutMs = 75000) {
  const found = peer.lines.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.listeners.delete(check);
      reject(new Error('Timed out waiting on ' + peer.label +
        '; recent output: ' + peer.lines.slice(-7).join(' | ') + '; stderr: ' + peer.stderr));
    }, timeoutMs);
    const check = line => {
      if (line.startsWith('PROCESS_EXITED:')) {
        clearTimeout(timeout);
        peer.listeners.delete(check);
        reject(new Error(peer.label + ' exited before condition: ' + line +
          '; stderr: ' + peer.stderr));
      } else if (predicate(line)) {
        clearTimeout(timeout);
        peer.listeners.delete(check);
        resolve(line);
      }
    };
    peer.listeners.add(check);
  });
}
async function stop(peer) {
  if (!peer.proc.killed && peer.proc.exitCode === null) {
    const exited = new Promise(r => peer.proc.once('exit', r));
    peer.proc.kill('SIGKILL');
    await exited;
  }
  all.delete(peer.proc);
}
async function ready(peer) {
  await waitFor(peer, line => line.startsWith('topic=') && line.includes(' node='));
}
function payload(randomLength) {
  return new Uint8Array(randomBytes(randomLength));
}
function push(peer, bytes) {
  if (peer.proc.exitCode !== null) throw new Error(peer.label + ' has exited');
  peer.proc.stdin.write('hex:' + Buffer.from(bytes).toString('hex') + '\n');
}
function received(peer, bytes) {
  const signature = 'bytes=[' + Array.from(bytes).join(', ') + ']';
  return waitFor(peer, line =>
    line.includes('received from=') && line.includes('doc=test/native-peer') &&
    line.includes(signature));
}

try {
  // Case A: update created before B starts; A remains online.
  const a = start('A', 1);
  await ready(a);
  const fixtureA = payload(41);
  push(a, fixtureA);
  await delay(800);
  const b = start('B', 2);
  await ready(b);
  await received(b, fixtureA);
  console.log('PASS A: B received exact frame while A stayed online');
  await stop(b);

  // Case B/C: A writes while C is online; no user device stays online.
  const c = start('C', 3);
  await ready(c);
  const fixtureC = payload(63);
  push(a, fixtureC);
  await received(c, fixtureC);
  console.log('C stored A-authored update before A disappears');
  await delay(800);
  await stop(a); // SIGKILL: origin definitely not serving B.
  await stop(c); // The intermediary also disappears, then restarts from SQLite.
  console.log('Origin A and intermediary C both terminated before late reader starts');

  const restartedC = start('C-restarted', 3, 'C');
  await ready(restartedC);
  const lateB = start('B-late', 4);
  await ready(lateB);
  await received(lateB, fixtureC);
  console.log('PASS B/C: late B recovered exact update from restarted persistent C; A stayed dead');
  await stop(lateB);
  await stop(restartedC);
} finally {
  await Promise.all([...all].map(async proc => {
    if (proc.exitCode === null) {
      const done = new Promise(r => proc.once('exit', r));
      proc.kill('SIGKILL');
      await done;
    }
  }));
  await rm(root, { recursive: true, force: true });
}
