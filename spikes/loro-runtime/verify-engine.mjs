import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoroDoc } from 'loro-crdt';
import { runLoroScenario } from './engine.shared.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.LORO_SPIKE_DATA_DIR;
assert(dataDirectory, 'set LORO_SPIKE_DATA_DIR to the task scratch directory');
await mkdir(dataDirectory, { recursive: true });

const report = runLoroScenario(LoroDoc, 'loro-crdt');
const snapshotPath = resolve(dataDirectory, 'portable-recipe.snapshot');
await writeFile(snapshotPath, report.snapshot);
const reopen = spawnSync(process.execPath, ['--experimental-strip-types', resolve(here, 'reopen-snapshot.mjs'), snapshotPath], {
  encoding: 'utf8',
});
process.stdout.write(reopen.stdout);
process.stderr.write(reopen.stderr);
assert.equal(reopen.status, 0, 'separate-process snapshot restore failed');
console.log(JSON.stringify({
  adapter: report.adapter,
  sameFieldWinner: report.sameFieldWinner,
  removeVsEdit: 'removed=true and edited amount=900 ml both retained',
  differentOrdersConverged: report.differentOrdersConverged,
  portableRoundTrip: report.portableRoundTrip,
  updateBytes: report.updateBytes,
  snapshotBytes: report.snapshotBytes,
  scenarioStartupMs: report.startupMs,
  savedFileBytes: report.snapshot.length,
}, null, 2));
