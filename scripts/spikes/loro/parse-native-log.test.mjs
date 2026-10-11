import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const parser = fileURLToPath(new URL('./parse-native-log.mjs', import.meta.url));

function run(log, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-cooking-loro-parser-'));
  try {
    const input = path.join(dir, 'native.log');
    const output = path.join(dir, 'result.json');
    fs.writeFileSync(input, log);
    const proc = spawnSync(process.execPath, [parser, input, output, ...args], { encoding: 'utf8' });
    const parsed = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
    return { proc, parsed };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function frames(value, id = 'ios_123') {
  const content = encodeURIComponent(JSON.stringify(value));
  const parts = content.match(/.{1,73}/gu) ?? [''];
  return parts.map((part, i) =>
    '2026-10-12 [com.facebook.react.log:javascript] LORO_NATIVE_RESULT_V2:'
      + id + ':' + (i + 1) + '/' + parts.length + ':' + part + '\n');
}

test('Apple unified logs can contain the actual octal-escaped newline sequence', () => {
  const value = { ok: false, error: 'duplicate import failed\n    at runHarness (main.jsbundle:100777:52)' };
  const raw = JSON.stringify(value).replaceAll('\\n', '\\134n');
  const { proc, parsed } = run('2026-10-11 I LORO_NATIVE_RESULT:' + raw + '\n');
  assert.notEqual(proc.status, 0);
  assert.equal(parsed.status, 'FAIL');
  assert.equal(parsed.error, value.error);
  assert.doesNotMatch(proc.stderr, /Bad escaped character/u);
});
test('reassembles unordered and duplicated log-safe frames with unicode and line breaks', () => {
  const value = { ok: true, status: 'PASS', platform: 'ios',
    error: 'a slash \\ plus newline\nand café', nativeUpdateBytes: [0, 1, 255] };
  const original = frames(value);
  const lines = [original.at(-1), ...original.slice(0, -1), original[0]];
  const { proc, parsed } = run(lines.join(''));
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(parsed, value);
});
test('fails closed and writes FAIL artifact for missing marker', () => {
  const { proc, parsed } = run('unrelated native log line\n');
  assert.notEqual(proc.status, 0);
  assert.equal(parsed.status, 'FAIL');
  assert.match(parsed.error, /No LORO_NATIVE_RESULT/u);
});
test('fails closed for interrupted latest session rather than accepting stale PASS', () => {
  const success = frames({ ok: true, status: 'PASS' }, 'older').join('');
  const partial = frames({ ok: true, status: 'PASS', data: 'long result' }, 'newer');
  const { proc, parsed } = run(success + partial[0]);
  assert.notEqual(proc.status, 0);
  assert.equal(parsed.status, 'FAIL');
  assert.match(parsed.error, /Incomplete latest native result/u);
});
test('detects conflicting duplicate fragments', () => {
  const value = { ok: true, status: 'PASS' };
  const first = frames(value);
  const corrupted = first[0].slice(0, -2)
    + (first[0].at(-2) === 'A' ? 'B' : 'A') + '\n';
  const { proc, parsed } = run(first.join('') + corrupted);
  assert.notEqual(proc.status, 0);
  assert.equal(parsed.status, 'FAIL');
});
test('PARTIAL requires explicit permission for first process launch only', () => {
  const lines = frames({ ok: true, status: 'PARTIAL', checks: { processRestart: 'PARTIAL' } }).join('');
  assert.notEqual(run(lines).proc.status, 0);
  assert.equal(run(lines, ['--allow-partial']).proc.status, 0);
});
test('a false PASS is rejected even if JSON parses', () => {
  const { proc, parsed } = run(frames({ ok: false, status: 'PASS' }).join(''));
  assert.notEqual(proc.status, 0);
  assert.equal(parsed.status, 'FAIL');
  assert.match(parsed.error, /contradicts ok flag/u);
});
test('the last complete legacy JSON result wins', () => {
  const lines = 'LORO_NATIVE_RESULT:{"ok":false}\n'
    + 'LORO_NATIVE_RESULT:{"ok":true,"platform":"android"}\n';
  const { proc, parsed } = run(lines);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.status, 'PASS');
});
