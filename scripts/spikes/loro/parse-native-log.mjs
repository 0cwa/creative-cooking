import fs from 'node:fs';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) throw new Error('usage: parse-native-log.mjs <log> <output>');

const text = fs.readFileSync(input, 'utf8');
const lines = text.split(/\r?\n/u).filter((line) => line.includes('LORO_NATIVE_RESULT:'));
if (lines.length === 0) throw new Error('No LORO_NATIVE_RESULT marker found');

const line = lines.at(-1);
const marker = 'LORO_NATIVE_RESULT:';
const raw = line.slice(line.indexOf(marker) + marker.length).trim();
const start = raw.indexOf('{');
const result = JSON.parse(start >= 0 ? raw.slice(start) : raw);
if (!result.ok) throw new Error(`native harness reported failure: ${result.error ?? 'unknown'}`);
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
