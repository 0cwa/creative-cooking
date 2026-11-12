import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LoroDoc } from 'loro-crdt';

const bytes = new Uint8Array(await readFile(process.argv[2]));
const started = performance.now();
const restored = new LoroDoc();
restored.import(bytes);
const elapsedMs = Number((performance.now() - started).toFixed(2));
const state = restored.toJSON();
assert.equal(state['ingredient:stock'].removed, true);
assert.equal(state['ingredient:stock'].amount, '900 ml');
assert.equal(state['ingredient:lentils'].amount, '250 g');
assert.equal(state.steps[1], 'Simmer for 25 minutes.');
console.log(JSON.stringify({ restoredInNewProcess: true, importMs: elapsedMs, bytes: bytes.length }));
