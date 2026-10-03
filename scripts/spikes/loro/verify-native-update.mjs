import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LoroDoc } from 'loro-crdt';

const fixturePath = process.argv[2];
const nativePath = process.argv[3];
if (!fixturePath || !nativePath) throw new Error('usage: verify-native-update.mjs <web-fixture> <native-result>');

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const native = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
assert.equal(native.ok, true);

const fromBase64 = (value) => new Uint8Array(Buffer.from(value, 'base64'));
const document = new LoroDoc();
document.import(fromBase64(fixture.snapshotBase64));
document.import(fromBase64(fixture.webUpdateBase64));
document.import(Uint8Array.from(native.nativeUpdateBytes));

const state = document.toJSON();
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

const result = {
  pass: true,
  platform: native.platform ?? 'native',
  webVersion: fixture.webPackage,
  nativeApi: native.platformApi,
  visibleWinner: state['recipe:recipe-1']?.portions,
  concurrent,
  alternatives: writes.map(({ value, changeId, message }) => ({ value, changeId, message })),
  snapshotImportedOnNative: native.importedWebSnapshot,
  nativeRestart: native.afterRestart,
  duplicateImportIdempotent: native.duplicateImportIdempotent
};
console.log(JSON.stringify(result, null, 2));
