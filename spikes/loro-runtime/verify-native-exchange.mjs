import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LoroDoc } from 'loro-crdt';
import { createNativeWebFixture } from './prepare-native-web-fixture.mjs';

const logPath = process.argv[2];
assert(logPath, 'usage: node --experimental-strip-types spikes/loro-runtime/verify-native-exchange.mjs <native-logcat.txt>');
const log = await readFile(logPath, 'utf8');
const updates = [...log.matchAll(/LORO_NATIVE_UPDATE_BASE64=([A-Za-z0-9+/=]+)/g)];
assert(updates.length > 0, 'Android log did not contain a native Loro update');
const nativeUpdate = new Uint8Array(Buffer.from(updates.at(-1)[1], 'base64'));
const fixture = createNativeWebFixture();

function makeReplica(updateOrder) {
  const doc = new LoroDoc();
  doc.import(fixture.baseSnapshot);
  for (const update of updateOrder) doc.import(update);
  return doc;
}

const first = makeReplica([nativeUpdate, fixture.update, nativeUpdate]);
const second = makeReplica([fixture.update, nativeUpdate, fixture.update]);
assert.deepEqual(first.toJSON(), second.toJSON(), 'native/web updates did not converge across duplicate delivery');

const state = first.toJSON();
assert.ok(['Lentil soup (A) 🧪', 'Lentil soup (B) 🍲'].includes(state.recipe.title));
assert.deepEqual(state['ingredient-order'], ['ing-lentils-7', 'ing-stock-8']);
assert.equal(state['ingredient:ing-lentils-7'].id, 'ing-lentils-7');
assert.equal(state['ingredient:ing-lentils-7'].amount, '250 g');
assert.equal(state['ingredient:ing-stock-8'].id, 'ing-stock-8');
assert.equal(state['ingredient:ing-stock-8'].deleted, true);
assert.equal(state['ingredient:ing-stock-8'].amount, '900 ml');
assert.deepEqual(state['step-order'], ['step-rinse-1', 'step-simmer-25m-3']);
assert.equal(state['step:step-simmer-25m-3'].id, 'step-simmer-25m-3');
assert.equal(state['step:step-simmer-25m-3'].text, 'Simmer for 25 minutes — 🍲');

const reopened = new LoroDoc();
reopened.import(first.export({ mode: 'snapshot' }));
assert.deepEqual(reopened.toJSON(), state, 'web snapshot re-import changed the merged native state');

console.log(JSON.stringify({
  nativeUpdateBytes: nativeUpdate.byteLength,
  webUpdateBytes: fixture.update.byteLength,
  convergedWithDuplicatesAndDifferentOrders: true,
  stableIngredientAndStepIds: true,
  logicalDeleteConcurrentAmountEdit: true,
  sameFieldWinner: state.recipe.title,
  portableSnapshotReopen: true,
}, null, 2));
