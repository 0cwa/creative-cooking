import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
const output = process.argv[3];
const allowPartial = process.argv.includes('--allow-partial');
if (!input || !output) {
  throw new Error('usage: parse-native-log.mjs <log> <output> [--allow-partial]');
}
const log = fs.readFileSync(input, 'utf8');
const lines = log.split(/\r?\n/u);
fs.mkdirSync(path.dirname(output), { recursive: true });

function parseResult() {
  const tag = 'LORO_NATIVE_RESULT_V2:';
  const fragments = lines.filter((line) => line.includes(tag));
  if (fragments.length) {
    const sessions = new Map();
    for (const line of fragments) {
      const raw = line.slice(line.indexOf(tag) + tag.length).trim();
      const match = /^([A-Za-z0-9_-]+):([1-9]\d*)\/([1-9]\d*):([^\s]+)$/u.exec(raw);
      if (!match) throw new Error('Malformed/truncated LORO_NATIVE_RESULT_V2 frame: ' + raw.slice(0, 100));
      const [, id, indexString, countString, data] = match;
      const index = Number(indexString), count = Number(countString);
      if (!Number.isSafeInteger(count) || count > 10000 || index > count) {
        throw new Error('Invalid Loro native frame count/index');
      }
      if (!sessions.has(id)) sessions.set(id, { count, parts: new Map() });
      const session = sessions.get(id);
      if (session.count !== count) throw new Error('Native frame count changed within a session: ' + id);
      const before = session.parts.get(index);
      if (before !== undefined && before !== data) {
        throw new Error('Conflicting duplicate native frame ' + id + ':' + index);
      }
      session.parts.set(index, data);
    }
    // Last observed session MUST be complete: do not accept a stale previous PASS.
    const [id, latest] = Array.from(sessions.entries()).at(-1);
    if (latest.parts.size !== latest.count) {
      throw new Error('Incomplete latest native result ' + id + ': '
        + latest.parts.size + '/' + latest.count + ' frames');
    }
    const encoded = Array.from({ length: latest.count }, (_, i) => latest.parts.get(i + 1)).join('');
    return JSON.parse(decodeURIComponent(encoded));
  }
  // Read historical artifacts and regress Apple's real unified-log encoding.
  // New native builds emit only V2 framed results.
  const tagV1 = 'LORO_NATIVE_RESULT:';
  const legacy = lines.filter((line) => line.includes(tagV1));
  if (!legacy.length) throw new Error('No LORO_NATIVE_RESULT_V2 or legacy result marker found');
  const raw = legacy.at(-1).split(tagV1).slice(1).join(tagV1).trim();
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('Legacy LORO_NATIVE_RESULT does not contain JSON');
  const repaired = raw.slice(start).replace(/\\134(?=[\\/"bfnrtu])/gu, '\\');
  const result = JSON.parse(repaired);
  result.status ??= result.ok === true ? 'PASS' : 'FAIL';
  return result;
}

let result;
try {
  result = parseResult();
  if (!result || !['PASS', 'PARTIAL', 'FAIL'].includes(result.status)) {
    throw new Error('Native result is missing a valid explicit PASS/PARTIAL/FAIL status');
  }
  if (typeof result.ok !== 'boolean' || (result.status === 'PASS' && !result.ok)
      || (result.status === 'FAIL' && result.ok)) {
    throw new Error('Native result status contradicts ok flag');
  }
} catch (error) {
  result = {
    ok: false, status: 'FAIL', platform: 'collector',
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    inputLog: input
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS' && !(allowPartial && result.status === 'PARTIAL')) {
  throw new Error('native harness reported ' + result.status + ': '
    + (result.error ?? JSON.stringify(result.checks ?? {})));
}
