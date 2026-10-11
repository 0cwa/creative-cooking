import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) throw new Error('usage: parse-native-log.mjs <log> <output>');

const log = fs.readFileSync(input, 'utf8');
const marker = 'LORO_NATIVE_RESULT:';
const lines = log.split(/\r?\n/u).filter((line) => line.includes(marker));
if (lines.length === 0) throw new Error('No LORO_NATIVE_RESULT marker found');

const line = lines.at(-1);
const raw = line.slice(line.indexOf(marker) + marker.length).trim();
const start = raw.indexOf('{');
if (start < 0) throw new Error('LORO_NATIVE_RESULT does not contain a JSON object');

// Apple unified logging encodes a backslash as octal \134. A JSON stack trace
// containing a newline escape therefore arrives as \134n, which is invalid JSON.
// Only restore octal-escaped backslashes in recognizable JSON escape sequences.
const encoded = raw.slice(start);
const json = encoded.replace(/\\134(?=[\\/"bfnrtu])/gu, '\\');
const result = JSON.parse(json);

// Persist failed native results too, so Actions artifacts contain the evidence.
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.ok) throw new Error('native harness reported failure: ' + (result.error ?? 'unknown'));
