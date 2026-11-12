import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { LoroDoc } from 'loro-crdt';

const spikeDir = path.dirname(fileURLToPath(import.meta.url));
const taskScratch = process.env.LORO_WIRE_SCRATCH
  ?? path.join(os.homedir(), 'agent-scratch/creative-cooking/sync-implementation/loro-wire-phase');
const hostProject = path.join(taskScratch, 'wire-rust');
const targetDir = path.join(taskScratch, 'rust-target');
const exchangeDir = path.join(taskScratch, 'exchange');
const manifest = path.join(hostProject, 'Cargo.toml');
const appPackage = JSON.parse(readFileSync(path.join(spikeDir, '..', '..', 'package.json'), 'utf8'));
const lockText = readFileSync(path.join(spikeDir, 'wire-rust', 'Cargo.lock'), 'utf8');

assert.equal(appPackage.dependencies['loro-crdt'], '1.17.1');
assert.match(lockText, /name = "loro"\nversion = "1\.10\.3"/);
mkdirSync(taskScratch, { recursive: true });
mkdirSync(exchangeDir, { recursive: true });
cpSync(path.join(spikeDir, 'wire-rust'), hostProject, { recursive: true, force: true });

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runRust(...args) {
  if (process.env.LORO_WIRE_RUN_CARGO_DIRECT === '1') {
    const rustc = execFileSync('rustup', ['which', 'rustc'], { encoding: 'utf8' }).trim();
    return execFileSync('cargo', [
      'run', '--locked', '--quiet',
      '--manifest-path', manifest,
      '--',
      ...args,
    ], {
      cwd: taskScratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, CARGO_TARGET_DIR: targetDir, RUSTC: rustc },
    }).trim();
  }
  const rustc = execFileSync('host-exec', ['sh', '-lc', 'rustup which rustc'], {
    cwd: taskScratch,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  const command = [
    `RUSTC=${shellQuote(rustc)}`,
    `CARGO_TARGET_DIR=${shellQuote(targetDir)}`,
    'cargo run --locked --quiet',
    `--manifest-path ${shellQuote(manifest)}`,
    '--',
    ...args.map(shellQuote),
  ].join(' ');
  return execFileSync('host-exec', ['sh', '-lc', command], {
    cwd: taskScratch,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

runRust('seed', exchangeDir);
const baseSnapshot = new Uint8Array(readFileSync(path.join(exchangeDir, 'rust-base.snapshot')));

const webStarted = performance.now();
const web = new LoroDoc();
web.import(baseSnapshot);
web.setPeerId('202');
const importedBase = web.toJSON();
assert.equal(importedBase.recipe.title, 'Soupe de lentilles — 東京 🍲');
assert.deepEqual(importedBase['ingredient-order'], ['ing-onion-7', 'ing-stock-8', 'ing-lentils-9']);
assert.equal(importedBase['step:step-prep-1'].text, 'Émincer l’oignon 🧅');
const baseVersion = web.oplogVersion();
web.getMap('recipe').set('title', 'Web recipe 🥘 — café');
web.getMap('ingredient:ing-stock-8').set('amount', '900 ml');
web.getMovableList('step-order').move(0, 2);
web.getMovableList('step-order').delete(1, 1);
web.getMovableList('step-order').insert(1, 'step-serve-4');
web.getMap('step:step-serve-4').set('id', 'step-serve-4');
web.getMap('step:step-serve-4').set('text', 'Ajouter du persil 🌿 — 東京');
web.getMap('recipe').set('web-note', 'crème brûlée ☕');
const webUpdate = web.export({ mode: 'update', from: baseVersion });
const webSnapshot = web.export({ mode: 'snapshot' });
writeFileSync(path.join(exchangeDir, 'web-update.bin'), webUpdate);
writeFileSync(path.join(exchangeDir, 'web.snapshot'), webSnapshot);
const webRuntimeMs = performance.now() - webStarted;

const rustSummaryText = runRust(
  'merge',
  path.join(exchangeDir, 'rust-base.snapshot'),
  path.join(exchangeDir, 'web-update.bin'),
  path.join(exchangeDir, 'web.snapshot'),
  exchangeDir,
);
const rustSummary = JSON.parse(rustSummaryText.split('\n').at(-1));
const rustUpdate = new Uint8Array(readFileSync(path.join(exchangeDir, 'rust-update.bin')));
const rustFinalSnapshot = new Uint8Array(readFileSync(path.join(exchangeDir, 'rust-final.snapshot')));
const rustState = JSON.parse(readFileSync(path.join(exchangeDir, 'rust-final.json'), 'utf8'));

const withRustUpdate = new LoroDoc();
withRustUpdate.import(baseSnapshot);
withRustUpdate.importBatch([webUpdate, rustUpdate]);
assert.deepEqual(sortKeys(withRustUpdate.toJSON()), sortKeys(rustState));

const reverseOrder = new LoroDoc();
reverseOrder.import(baseSnapshot);
reverseOrder.importBatch([rustUpdate, webUpdate, rustUpdate]);
assert.deepEqual(sortKeys(reverseOrder.toJSON()), sortKeys(rustState));

const fromRustSnapshot = new LoroDoc();
fromRustSnapshot.import(rustFinalSnapshot);
assert.deepEqual(sortKeys(fromRustSnapshot.toJSON()), sortKeys(rustState));
assert.deepEqual(sortKeys(fromRustSnapshot.toJSON()), sortKeys(withRustUpdate.toJSON()));
const portableRoundTrip = new LoroDoc();
portableRoundTrip.import(fromRustSnapshot.export({ mode: 'snapshot' }));
assert.deepEqual(sortKeys(portableRoundTrip.toJSON()), sortKeys(rustState));

const finalState = fromRustSnapshot.toJSON();
assert.deepEqual(finalState['ingredient-order'], ['ing-stock-8', 'ing-lentils-9', 'ing-onion-7']);
assert.deepEqual(finalState['step-order'], ['step-simmer-2', 'step-serve-4', 'step-prep-1']);
assert.equal(finalState['ingredient:ing-stock-8'].id, 'ing-stock-8');
assert.equal(finalState['ingredient:ing-stock-8'].deleted, true);
assert.equal(finalState['ingredient:ing-stock-8'].amount, '900 ml');
assert.equal(finalState['step:step-serve-4'].text, 'Ajouter du persil 🌿 — 東京');
assert.equal(finalState['step:step-prep-1'].text, 'Émincer l’oignon 🧅');
assert.ok(['Rust recipe 🍲 — 東京', 'Web recipe 🥘 — café'].includes(finalState.recipe.title));
assert.equal(finalState.recipe['rust-note'], 'naïve 🌾');
assert.equal(finalState.recipe['web-note'], 'crème brûlée ☕');

console.log(JSON.stringify({
  rustCore: 'loro 1.10.3 (the core dependency declared by loro-ffi 1.10.3)',
  webSdk: `loro-crdt ${appPackage.dependencies['loro-crdt']}`,
  proofScope: 'wire compatibility between Rust core and web WASM SDK; not a React Native runtime pass',
  exchanges: {
    rustBaseSnapshotToWebImport: 'passed and fixture IDs/Unicode verified',
    webUpdateToRustImport: 'passed',
    webSnapshotToRustImport: 'passed and matched web update state',
    rustUpdateToWebImport: 'passed and matched merged state',
    rustFinalSnapshotToWebImport: 'passed and matched update merge',
    exportedSnapshotReopen: 'passed',
  },
  assertions: {
    stableIngredientAndStepIds: 'preserved in movable-list values and keyed maps',
    listMoves: 'Rust ingredient move and web step move preserved',
    listDeletion: 'web deleted one step, then inserted a different stable step ID',
    removeVsEdit: 'deleted=true retained alongside amount=900 ml',
    sameFieldConflict: finalState.recipe.title,
    unicode: 'accents, CJK, emoji, and combining text preserved',
    duplicateAndOrder: 'passed in Rust and web replicas',
  },
  bytes: {
    rustBaseSnapshot: baseSnapshot.byteLength,
    webUpdate: webUpdate.byteLength,
    webSnapshot: webSnapshot.byteLength,
    rustUpdate: rustUpdate.byteLength,
    rustFinalSnapshot: rustFinalSnapshot.byteLength,
  },
  runtimeMs: {
    webImportEditAndExportAfterModuleLoad: Number(webRuntimeMs.toFixed(2)),
    rustCoreMergeImportEditExport: Number(rustSummary.mergeRuntimeMs.toFixed(2)),
  },
  rustChecks: rustSummary.duplicateAndOrderChecks,
}, null, 2));

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}
