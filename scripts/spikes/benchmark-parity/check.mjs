import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, TRACE, FIXTURE_SPEC, checksum } from './fixture.mjs';
const dir = process.env.BENCH_OUTPUT ?? 'artifacts/benchmark-parity';
const data = JSON.parse(fs.readFileSync(path.join(dir,'results.json'), 'utf8'));
const expected = checksum(fixture());
assert.equal(data.fixtureSha256, expected, 'fixture checksum');
assert.deepStrictEqual(data.fixture, FIXTURE_SPEC);
assert.equal(data.operationTraceSha256, checksum(TRACE));
assert.equal(data.purpose, 'fair measurement, no engine ranking or winner');
assert.equal(data.environment.packages.length, 2);
const n = data.repetitions.measuredTrials;
const required = ['populate','saveSnapshot','loadSnapshot','prepareLogicalView','warmRead100Records',
  'singleFieldEdit','smallBatchEdit','coldSecondDeviceBootstrap','warmIncrementalSync',
  'warmFollowupSync','rawUpdateExchange','documentMerge','longOfflineCatchUp','thirdDeviceBootstrap',
  'duplicateUpdateDelivery','reloadAfterDispose','syncAfterReload',
  'history20Edits','historySnapshotSave','history60EditCatchUp'];
for (const engine of ['automerge','loro']) {
  const e = data.engines[engine];
  assert.ok(e);
  for (const key of required) {
    const metric = e.timings[key];
    assert.ok(metric, engine + ' missing ' + key);
    const count = ['history20Edits','historySnapshotSave'].includes(key) ? n * 3 : n;
    assert.equal(metric.samples.length, count, engine + ' insufficient samples ' + key);
    assert.ok(metric.samples.every(x => Number.isFinite(x) && x >= 0), engine + ' invalid time ' + key);
    assert.ok(metric.p95 >= metric.median, key + ' tail below median');
  }
  assert.equal(e.memory.length, n);
  assert.equal(e.moduleInitialization.samples.length, 5);
  for (const key of ['coldSecondDeviceBootstrap','warmIncrementalSync','warmFollowupSync','rawUpdateExchange','longOfflineCatchUp','thirdDeviceBootstrap','duplicateUpdateDelivery','syncAfterReload','history60EditCatchUp']) {
    const samples = e.scenarioEvidence[key];
    assert.equal(samples.length, n, engine + ' missing transfer samples ' + key);
    for (const sample of samples) {
      assert.ok(sample.aToB > 0, engine + ' expected transferred bytes for ' + key);
      assert.ok(sample.bToA >= 0 && sample.messages > 0);
      assert.ok(sample.rounds >= 1);
    }
  }
  assert.ok(e.scenarioEvidence.singleFieldEdit.every(s => s.incrementalBytes > 0));
  assert.ok(e.scenarioEvidence.history60EditCatchUp.every(s =>
    s.snapshotBytesAtEdits20_40_60.length === 3 &&
    s.historyMemoryByBlock.length === 3 &&
    s.historyMemoryByBlock.every(m => m.rssBytes > 0 && m.v8HeapUsedBytes > 0)));
  assert.ok(e.scenarioEvidence.longOfflineCatchUp.every(s =>
    JSON.stringify(s.conflictValues) === JSON.stringify([4,6])));
}
assert.ok(data.engines.automerge.scenarioEvidence.warmIncrementalSync.every(s =>
  s.kind === 'Automerge SyncState protocol'));
assert.ok(data.engines.loro.scenarioEvidence.coldSecondDeviceBootstrap.every(s =>
  s.kind === 'Loro full snapshot bootstrap' && s.bToA === 0));
const csv = fs.readFileSync(path.join(dir, 'results.csv'), 'utf8');
assert.ok(csv.includes('automerge,coldSecondDeviceBootstrap,ms'));
assert.ok(csv.includes('loro,warmIncrementalSync,ms'));
console.log('BENCHMARK VALIDITY PASS ' + expected + ' repetitions=' + n);
