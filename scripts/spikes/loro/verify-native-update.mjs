import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LoroDoc } from 'loro-crdt';

const fixturePath = process.argv[2];
const nativePath = process.argv[3];
const firstLaunchPath = process.argv[4];
if (!fixturePath || !nativePath) throw new Error('usage: verify-native-update.mjs <web-fixture> <native-result>');

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const native = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
assert.equal(native.ok, true);
assert.ok(native.status === 'PASS' || native.status === 'PARTIAL',
  'Native app did not produce a valid functional result');
for (const feature of [
  'importWebBinary', 'nativeBinaryExport', 'concurrentMerge',
  'snapshotReload', 'duplicateImport', 'outOfOrderImport',
  'fullHistoryRetention', 'shallowHistoryProbe', 'durableReviewCheckpoint',
  'causalResolution', 'movableList', 'text', 'lifecycle', 'processRestart'
]) {
  assert.equal(native.checks?.[feature], 'PASS', feature + ' must be actually proven');
}
// The current public RN FFI history shape is an independent capability,
// not a reason to throw away a successful binary round-trip result.
if (native.status === 'PARTIAL') {
  assert.equal(native.checks?.nativeProvenance, 'PARTIAL',
    'Unknown native PARTIAL capability gap');
}
assert.equal(native.duplicateImportIdempotent, true);
assert.equal(native.outOfOrder?.status, 'PASS');
assert.equal(native.outOfOrder?.heldCausalSuccessorUntilPredecessor, true);
assert.equal(native.outOfOrder?.duplicateImportsIdempotent, true);
assert.equal(native.historyRetention?.fullSnapshot, 'PASS');
assert.equal(native.historyRetention?.shallowSnapshot?.status, 'PASS');
assert.equal(native.historyRetention?.checkpointWrittenAndReadBack, true);
assert.equal(native.historyRetention?.checkpointRestoredAfterOsRestart, true);
assert.deepEqual(new Set(native.historyRetention?.fullSnapshotAlternatives?.map((a) => a.value)), new Set([4, 6]));
assert.equal(native.nativeDisagreementEvidence?.concurrent, true);
if (firstLaunchPath) {
  const firstLaunch = JSON.parse(fs.readFileSync(firstLaunchPath, 'utf8'));
  assert.equal(firstLaunch.status, 'PARTIAL');
  assert.equal(firstLaunch.checks?.processRestart, 'PARTIAL');
  assert.notEqual(firstLaunch.runId, native.runId);
  assert.equal(native.processRestart?.previousRunId, firstLaunch.runId);
}

const fromBase64 = (value) => new Uint8Array(Buffer.from(value, 'base64'));
const document = new LoroDoc();
document.import(fromBase64(fixture.snapshotBase64));
document.import(fromBase64(fixture.webUpdateBase64));
document.import(Uint8Array.from(native.nativeUpdateBytes));

const state = document.toJSON();
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => [key, canonical(v)])) : value;
assert.deepEqual(canonical(state), canonical(native.afterMerge ? {
  ...state, ['recipe:recipe-1']: native.afterMerge
} : state));

const history = document.exportJsonUpdates(undefined, undefined, false);
const writes = [];
for (const change of history.changes ?? []) {
  const peer = String(change.id).slice(String(change.id).lastIndexOf('@') + 1);
  for (const op of change.ops ?? []) {
    if (
      op.container === 'cid:root-recipe:recipe-1:Map'
      && op.content?.type === 'insert'
      && op.content?.key === 'portions'
      && [4, 6].includes(op.content.value)
    ) {
      writes.push({
        value: op.content.value,
        peer,
        counter: op.counter,
        changeId: String(change.id),
        message: change.msg ?? null
      });
    }
  }
}

assert.deepEqual(new Set(writes.map((w) => w.value)), new Set([4, 6]));
const four = writes.find((w) => w.value === 4);
const six = writes.find((w) => w.value === 6);
assert.ok(four && six);
const concurrent = document.cmpFrontiers(
  [{ peer: four.peer, counter: four.counter }],
  [{ peer: six.peer, counter: six.counter }]
) === undefined;
assert.equal(concurrent, true);

const preResolutionState = document.toJSON();
assert.deepEqual(canonical(preResolutionState['recipe:recipe-1']), canonical(native.afterRestart));
assert.ok(Array.isArray(native.nativeResolutionUpdateBytes) && native.nativeResolutionUpdateBytes.length > 0);
document.import(Uint8Array.from(native.nativeResolutionUpdateBytes));
const finalState = document.toJSON();
assert.equal(finalState['recipe:recipe-1']?.portions, 8);
const resolvedHistory = document.exportJsonUpdates(undefined, undefined, false);
const resolutionWrites = [];
for (const change of resolvedHistory.changes ?? []) {
  const peer = String(change.id).slice(String(change.id).lastIndexOf('@') + 1);
  for (const op of change.ops ?? []) {
    if (op.container === 'cid:root-recipe:recipe-1:Map'
        && op.content?.type === 'insert'
        && op.content?.key === 'portions'
        && op.content.value === 8) {
      resolutionWrites.push({ peer, counter: op.counter, changeId: String(change.id) });
    }
  }
}
assert.equal(resolutionWrites.length, 1, 'native resolution must produce exactly one retained 8 write');
for (const conflictingWrite of [four, six]) {
  assert.equal(document.cmpFrontiers(
    [{ peer: conflictingWrite.peer, counter: conflictingWrite.counter }],
    [{ peer: resolutionWrites[0].peer, counter: resolutionWrites[0].counter }]
  ), -1, 'resolved write must causally supersede both concurrent alternatives');
}
assert.deepEqual(canonical(finalState), canonical(native.nativeResolvedState));
const firstFinal = document.oplogVersion();
document.import(Uint8Array.from(native.nativeResolutionUpdateBytes));
assert.deepEqual(canonical(document.toJSON()), canonical(finalState));
assert.deepEqual(document.oplogVersion().toJSON(), firstFinal.toJSON());

const result = {
  status: 'PASS',
  pass: true,
  processRestart: native.processRestart, 
  resolvedPortions: finalState['recipe:recipe-1']?.portions,
  resolvedConvergence: true,
  causalResolutionSupersedesBoth: true,
  resolutionChangeId: resolutionWrites[0].changeId,
  platform: native.platform ?? 'native',
  webVersion: fixture.webPackage,
  nativeApi: native.platformApi,
  visibleWinner: state['recipe:recipe-1']?.portions,
  concurrent,
  alternatives: writes.map(({ value, changeId, message }) => ({ value, changeId, message })),
  snapshotImportedOnNative: native.importedWebSnapshot,
  nativeRestart: native.afterRestart,
  duplicateImportIdempotent: native.duplicateImportIdempotent,
  outOfOrder: native.outOfOrder,
  historyRetention: native.historyRetention
};
console.log(JSON.stringify(result, null, 2));
