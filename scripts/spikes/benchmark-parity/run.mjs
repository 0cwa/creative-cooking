import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fixture, TRACE, historyOps, checksum, expectedAfter, FIXTURE_SPEC } from './fixture.mjs';
import { backend, VERSIONS } from './adapters.mjs';

const OUT = process.env.BENCH_OUTPUT ?? 'artifacts/benchmark-parity';
const REPEATS = Number(process.env.BENCH_REPEATS ?? 5);
assert.ok(Number.isInteger(REPEATS) && REPEATS >= 3 && REPEATS <= 30, '3-30 measured trials required');
fs.mkdirSync(OUT, { recursive: true });
const expected = fixture(), fixtureChecksum = checksum(expected), traceChecksum = checksum(TRACE);
const metrics = { automerge: {}, loro: {} }, wireSamples = { automerge: {}, loro: {} };
const timing = (fn) => { const t = performance.now(); const value = fn(); return { value, ms: performance.now() - t }; };
function prove(actual, target, label) {
  assert.deepStrictEqual(actual, target, label);
  return checksum(actual);
}
function logMetric(engine, name, ms, extras = {}) {
  (metrics[engine][name] ??= []).push(Math.round(ms * 1000) / 1000);
  if (Object.keys(extras).length) (wireSamples[engine][name] ??= []).push(extras);
}
const percentile = (xs, p) => [...xs].sort((a,b) => a-b)[Math.max(0, Math.ceil(p*xs.length)-1)];
const median = xs => percentile(xs, 0.5);
const summary = values => ({ unit: 'ms', samples: values, median: median(values), p95: percentile(values, 0.95), min: Math.min(...values), max: Math.max(...values) });
function memory() {
  const m = process.memoryUsage(), usage = process.resourceUsage();
  return { rssBytes: m.rss, v8HeapUsedBytes: m.heapUsed, externalBytes: m.external,
    arrayBuffersBytes: m.arrayBuffers, linuxProcessMaxRssBytes: process.platform === 'linux' ? usage.maxRSS * 1024 : null };
}
function packageEvidence(name) {
  const base = path.resolve('node_modules', name);
  const packageJson = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const root = 'node_modules/' + name;
  const files = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  }
  walk(base);
  const crypto = awaitHash();
  for (const file of files.sort()) {
    crypto.update(path.relative(base, file)).update('\0').update(fs.readFileSync(file));
  }
  return { name, version: packageJson.version, npmIntegrity: lock.packages[root]?.integrity ?? null,
    installedTreeSha256: crypto.digest('hex'), installedFiles: files.length };
}
function awaitHash() { return requireHash(); }
// Explicit built-in import, without depending on a package's private internals.
import { createHash as requireHashFactory } from 'node:crypto';
function requireHash() { return requireHashFactory('sha256'); }
function loadModuleSamples(name) {
  const xs = [];
  for (let i = 0; i < 5; i++) {
    const code = "const t=performance.now(); await import(" + JSON.stringify(name) + "); console.log((performance.now()-t).toFixed(3))";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: process.cwd() });
    assert.equal(result.status, 0, result.stderr);
    xs.push(Number(result.stdout.trim()));
  }
  return { ...summary(xs), name: 'fresh process dynamic import, JS module loading and WASM setup together; not isolated pure WASM instantiation' };
}
const env = {
  generatedAt: new Date().toISOString(),
  node: process.version, nodeVersions: process.versions, v8: process.versions.v8,
  os: os.platform(), release: os.release(), arch: process.arch, cpus: os.cpus().length,
  cpuModel: os.cpus()[0]?.model ?? null, totalMemoryBytes: os.totalmem(),
  github: { runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    sha: process.env.GITHUB_SHA ?? null, runnerOs: process.env.RUNNER_OS ?? null, runnerArch: process.env.RUNNER_ARCH ?? null },
  packages: [packageEvidence('@automerge/automerge'), packageEvidence('loro-crdt')]
};
function captureMemory(label, base, last) {
  return { label, before: base, after: last, grossDeltaBytes: {
    rss: last.rssBytes - base.rssBytes, v8HeapUsed: last.v8HeapUsedBytes - base.v8HeapUsedBytes,
    external: last.externalBytes - base.externalBytes, arrayBuffers: last.arrayBuffersBytes - base.arrayBuffersBytes
  } };
}
const memSamples = { automerge: [], loro: [] };
function one(engine, trial, warmup = false) {
  const b = backend(engine);
  const report = (key, measurement, extra = {}) => {
    if (!warmup) logMetric(engine, key, measurement.ms, extra);
    return measurement.value;
  };
  global.gc?.();
  const before = memory();
  const seed = report('populate', timing(() => b.populate(b.init('seed'), expected)));
  assert.equal(prove(b.project(seed), expected, 'initial logical fixture ' + engine), fixtureChecksum);
  const snapshotMeasurement = timing(() => b.save(seed));
  const snapshot = report('saveSnapshot', snapshotMeasurement, { snapshotBytes: snapshotMeasurement.value.byteLength });
  const loaded = report('loadSnapshot', timing(() => b.load(snapshot, 'phone')));
  const projected = report('prepareLogicalView', timing(() => b.project(loaded)));
  prove(projected, expected, 'cold logical projection');
  const readChars = report('warmRead100Records', timing(() => b.read(loaded)));
  assert.equal(readChars, 12000, '100 x (48+32+40) characters from equivalent records');

  const edited = report('singleFieldEdit', timing(() => b.edit(b.clone(seed, 'phone'), TRACE.single, 'phone')));
  prove(b.project(edited), expectedAfter(expected, TRACE.single), 'single edit');
  const tiny = engine === 'automerge'
    ? (awaitLastChange(edited) ?? new Uint8Array())
    : edited.export({ mode: 'update', from: seed.oplogVersion() });
  if (!warmup) (wireSamples[engine].singleFieldEdit ??= []).push({ incrementalBytes: tiny.byteLength, logicalOperations: TRACE.single.length });
  const batch = report('smallBatchEdit', timing(() => b.edit(b.clone(seed, 'phone'), TRACE.batch, 'phone')));
  prove(b.project(batch), expectedAfter(expected, TRACE.batch), 'batch');

  const empty = b.init('laptop');
  const boot = report('coldSecondDeviceBootstrap', timing(() => b.bootstrap(b.clone(seed, 'phone'), empty)));
  prove(b.project(boot.b), expected, 'bootstrap at fresh device');
  if (!warmup) (wireSamples[engine].coldSecondDeviceBootstrap ??= []).push(boot.wire);

  // Use a prior *actual* device bootstrap, not identical local clones. Otherwise
  // Automerge SyncState may not have acknowledged shared heads and sends full history.
  let a = boot.a, c = boot.b, existing = boot.session;
  a = b.edit(a, TRACE.warmA, 'phone');
  c = b.edit(c, TRACE.warmB, 'laptop');
  const warm = report('warmIncrementalSync', timing(() => b.syncPair(a, c, existing)));
  // Do not erase the evidence if SyncState sends all of history even after a
  // successful bootstrap; this is a transport behavior to report, not a validity failure.
  const warmRetransmittedHistory = warm.wire.aToB >= boot.wire.aToB / 2;
  const warmExpected = expectedAfter(expected, [...TRACE.warmA, ...TRACE.warmB]);
  prove(b.project(warm.a), warmExpected, 'warm A');
  prove(b.project(warm.b), warmExpected, 'warm B');
  if (!warmup) (wireSamples[engine].warmIncrementalSync ??= []).push({ ...warm.wire,
    logicalOperations: TRACE.warmA.length + TRACE.warmB.length,
    retransmittedHistorySizedPayload: warmRetransmittedHistory });
  // A second genuine edit pair in the same established session makes first-round
  // retransmission vs steady-state delta behavior independently observable.
  const nextA = b.edit(b.clone(warm.a, 'phone'), TRACE.warmFollowupA, 'phone');
  const nextB = b.edit(b.clone(warm.b, 'laptop'), TRACE.warmFollowupB, 'laptop');
  const nextWarm = report('warmFollowupSync', timing(() => b.syncPair(nextA, nextB, warm.session)));
  const nextExpected = expectedAfter(warmExpected, [...TRACE.warmFollowupA, ...TRACE.warmFollowupB]);
  prove(b.project(nextWarm.a), nextExpected, 'followup warm A');
  prove(b.project(nextWarm.b), nextExpected, 'followup warm B');
  if (!warmup) (wireSamples[engine].warmFollowupSync ??= []).push({ ...nextWarm.wire,
    logicalOperations: TRACE.warmFollowupA.length + TRACE.warmFollowupB.length,
    retransmittedHistorySizedPayload: nextWarm.wire.aToB >= boot.wire.aToB / 2 });

  const eA = b.edit(b.clone(seed, 'phone'), TRACE.warmA, 'phone');
  const eB = b.edit(b.clone(seed, 'laptop'), TRACE.warmB, 'laptop');
  // Automerge merge/applyChanges can supersede immutable JS handle ownership.
  // Work from the untouched fork pair before doing an update exchange.
  const merged = report('documentMerge', timing(() => b.docMerge(eA, eB)));
  prove(b.project(merged), warmExpected, 'document merge');
  const exchange = report('rawUpdateExchange', timing(() => b.exchange(seed, eA, eB)));
  prove(b.project(exchange.a), warmExpected, 'raw exchange A');
  prove(b.project(exchange.b), warmExpected, 'raw exchange B');
  if (!warmup) (wireSamples[engine].rawUpdateExchange ??= []).push(exchange.wire);

  const offlineA = b.edit(b.clone(seed, 'phone'), TRACE.divergenceA, 'phone');
  const offlineB = b.edit(b.clone(seed, 'laptop'), TRACE.divergenceB, 'laptop');
  const diverged = report('longOfflineCatchUp', timing(() => b.exchange(seed, offlineA, offlineB)));
  const da = b.project(diverged.a), db = b.project(diverged.b);
  prove(da, db, 'divergence convergence');
  assert.ok([4,6].includes(da.recipesById['recipe-0045'].portions));
  const offlineExpected = expectedAfter(expected, [...TRACE.divergenceA, ...TRACE.divergenceB]);
  offlineExpected.recipesById['recipe-0045'].portions = da.recipesById['recipe-0045'].portions;
  prove(da, offlineExpected, 'conflicting scalar plus all nonconflicting edits');
  if (engine === 'automerge') {
    const conflicts = awaitConflicts(diverged.a);
    assert.deepStrictEqual(new Set(conflicts), new Set([4, 6]), 'Automerge alternatives');
  } else {
    const updates = diverged.a.exportJsonUpdates(undefined, undefined, false);
    const values = (updates.changes ?? []).flatMap(change => change.ops ?? [])
      .filter(op => op.container === 'cid:root-recipe:recipe-0045:Map' && op.content?.key === 'portions')
      .map(op => op.content.value);
    assert.ok(values.includes(4) && values.includes(6), 'Loro retained operation history has both values');
  }
  if (!warmup) (wireSamples[engine].longOfflineCatchUp ??= []).push({
    ...diverged.wire, logicalOperations: TRACE.divergenceA.length + TRACE.divergenceB.length,
    conflictValues: [4,6], visibleWinner: da.recipesById['recipe-0045'].portions
  });

  const third = report('thirdDeviceBootstrap', timing(() => b.bootstrap(b.clone(warm.a, 'phone'), b.init('tablet'))));
  prove(b.project(third.b), warmExpected, 'third device');
  if (!warmup) (wireSamples[engine].thirdDeviceBootstrap ??= []).push(third.wire);
  const trA = b.edit(b.clone(warm.a, 'phone'), TRACE.single, 'phone');
  const trB = b.clone(third.b, 'tablet');
  const dup = report('duplicateUpdateDelivery', timing(() => b.exchange(warm.a, trA, trB, true)));
  const dupExpected = expectedAfter(warmExpected, TRACE.single);
  prove(b.project(dup.a), dupExpected, 'duplicate A'); prove(b.project(dup.b), dupExpected, 'duplicate B');

  const persisted = b.save(batch);
  b.dispose(batch); // Prove a cold object can be reopened from bytes, not simply reused.
  let restarted = report('reloadAfterDispose', timing(() => b.load(persisted, 'phone')));
  prove(b.project(restarted), expectedAfter(expected, TRACE.batch), 'reload state');
  restarted = b.edit(restarted, TRACE.reload, 'phone');
  prove(b.project(restarted), expectedAfter(expected, [...TRACE.batch, ...TRACE.reload]), 'further post-reload edit');
  const reloadSync = report('syncAfterReload', timing(() => b.exchange(seed, restarted, b.clone(seed, 'laptop'))));
  prove(b.project(reloadSync.b), expectedAfter(expected, [...TRACE.batch, ...TRACE.reload]), 'post-reload sync');

  const sizes = [];
  let growing = b.clone(seed, 'phone');
  for (let block = 0; block < 3; block++) {
    const segment = historyOps(20).map((op, i) => ({ ...op, value: op.value.slice(0, 65) +
      String(block * 20 + i).padStart(5, '0') + ' '.repeat(10) }));
    const h = report('history20Edits', timing(() => {
      for (const op of segment) growing = b.edit(growing, [op], 'phone');
      return growing;
    }));
    const hSave = report('historySnapshotSave', timing(() => b.save(h)));
    sizes.push(hSave.byteLength);
  }
  const catchup = report('history60EditCatchUp', timing(() => b.exchange(seed, growing, b.clone(seed, 'laptop'))));
  prove(b.project(catchup.a), b.project(catchup.b), 'history catch up');
  assert.ok(sizes.every(n => n > 0), 'history serialized');
  if (!warmup) (wireSamples[engine].history60EditCatchUp ??= []).push({
    ...catchup.wire, snapshotBytesAtEdits20_40_60: sizes, logicalOperations: 60
  });
  global.gc?.();
  const after = memory();
  if (!warmup) memSamples[engine].push(captureMemory('whole trial allocation observed, not retained object size', before, after));
  return { snapshotBytes: snapshot.byteLength, fixtureChecksum, lastHistorySnapshotBytes: sizes.at(-1), readChars, trial };
}
// Tests inspect engine-specific metadata only after completing the equivalent measured operation.
import * as AM from '@automerge/automerge';
const awaitLastChange = d => AM.getLastLocalChange(d);
const awaitConflicts = d => Object.values(AM.getConflicts(d.recipesById['recipe-0045'], 'portions') ?? {});
console.log(JSON.stringify({ phase: 'fixture', spec: FIXTURE_SPEC, checksum: fixtureChecksum, traceChecksum }));
for (let trial = -1; trial < REPEATS; trial++) {
  const order = trial % 2 === 0 ? ['loro', 'automerge'] : ['automerge', 'loro'];
  for (const engine of order) {
    console.log('BENCH ' + engine + ' trial ' + trial + (trial === -1 ? ' warm-up' : ' measured'));
    const outcome = one(engine, trial, trial === -1);
    console.log(JSON.stringify({ engine, trial, snapshotBytes: outcome.snapshotBytes }));
  }
}
const output = {
  schemaVersion: 1, purpose: 'fair measurement, no engine ranking or winner',
  environment: env, fixture: FIXTURE_SPEC, fixtureSha256: fixtureChecksum, operationTraceSha256: traceChecksum,
  repetitions: { warmupTrials: 1, measuredTrials: REPEATS, runtimeOrder: 'alternates engines per trial' },
  engines: Object.fromEntries(['automerge', 'loro'].map(engine => [engine, {
    version: VERSIONS[engine],
    timings: Object.fromEntries(Object.entries(metrics[engine]).map(([key,x]) => [key, summary(x)])),
    scenarioEvidence: wireSamples[engine], memory: memSamples[engine],
    moduleInitialization: loadModuleSamples(engine === 'automerge' ? '@automerge/automerge' : 'loro-crdt')
  }])),
  interpretation: [
    'Initial bootstrap is an Automerge SyncState exchange versus a Loro full snapshot; wire protocol and framing are intentionally not equated.',
    'Warm incremental SyncState is only applicable to Automerge; Loro exchanges version-vector updates.',
    'Raw Automerge getChanges/applyChanges is not its SyncState protocol.',
    'Memory observations include live JS objects and WASM/native allocations; RSS is not the V8 heap.',
    'Node module initialization includes JS import and WASM setup; document loading is timed separately.',
    'Conflict winner ordering may differ; both values and all independent edits are validated.'
  ]
};
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(output, null, 2) + '\n');
const rows = ['engine,metric,unit,median,p95,min,max,samples'];
for (const [engine, e] of Object.entries(output.engines)) for (const [metric,x] of Object.entries(e.timings)) {
  rows.push([engine,metric,'ms',x.median,x.p95,x.min,x.max,JSON.stringify(x.samples).replaceAll(',',';')].join(','));
}
fs.writeFileSync(path.join(OUT, 'results.csv'), rows.join('\n') + '\n');
console.log(JSON.stringify({ valid: true, fixtureSha256: fixtureChecksum,
  mediansMs: Object.fromEntries(Object.entries(output.engines).map(([name, v]) =>
    [name, Object.fromEntries(Object.entries(v.timings).map(([key, val]) => [key, val.median]))])) }, null, 2));
