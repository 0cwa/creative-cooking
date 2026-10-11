import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const parser = fileURLToPath(new URL('./parse-native-log.mjs', import.meta.url));

function run(log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-cooking-loro-parser-'));
  try {
    const input = path.join(dir, 'native.log');
    const output = path.join(dir, 'result.json');
    fs.writeFileSync(input, log);
    const result = spawnSync(process.execPath, [parser, input, output], { encoding: 'utf8' });
    const parsed = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
    return { result, parsed };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('parses successful native result with host log prefix', () => {
  const value = { ok: true, platform: 'ios', duplicateImportIdempotent: true };
  const { result, parsed } = run('2026-10-12 blah LORO_NATIVE_RESULT:' + JSON.stringify(value) + '\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parsed, value);
});

test('decodes Apple unified-logging octal backslash escaping in error stacks', () => {
  const value = { ok: false, error: 'native import mismatch\n    at runHarness (...)' };
  const appleLog = JSON.stringify(value).replaceAll('\\n', '\\134n');
  const { result, parsed } = run('LORO_NATIVE_RESULT:' + appleLog + '\n');
  assert.notEqual(result.status, 0);
  assert.deepEqual(parsed, value);
  assert.match(result.stderr, /native harness reported failure/u);
  assert.doesNotMatch(result.stderr, /Bad escaped character/u);
});

test('does not report a missing marker as a runtime success', () => {
  const { result, parsed } = run('some unrelated log line\n');
  assert.notEqual(result.status, 0);
  assert.equal(parsed, null);
  assert.match(result.stderr, /No LORO_NATIVE_RESULT marker/u);
});

test('uses the last completed result marker', () => {
  const { result, parsed } = run(
    'LORO_NATIVE_RESULT:{"ok":false,"error":"obsolete"}\n'
    + 'LORO_NATIVE_RESULT:{"ok":true,"platform":"android"}\n'
  );
  assert.equal(result.status, 0);
  assert.equal(parsed.platform, 'android');
});
