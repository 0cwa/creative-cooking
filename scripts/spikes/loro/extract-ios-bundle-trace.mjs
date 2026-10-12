// Diagnostic-only: do not upload a whole built application or private source map.
// Extract compact unminified JS context for stack lines reported by Hermes.
import fs from 'node:fs';
import path from 'node:path';

const [bundlePath, resultPath, outPath] = process.argv.slice(2);
if (!bundlePath || !resultPath || !outPath) {
  throw new Error('usage: extract-ios-bundle-trace.mjs <unminified-jsbundle> <native-result.json> <output.txt>');
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const output = [];
if (!fs.existsSync(resultPath)) {
  output.push('No first-result.json was produced; native test did not reach a parsable log frame.');
} else {
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  output.push('Native status: ' + result.status);
  output.push('Native error: ' + String(result.error ?? '(none)').slice(0, 3000));
  if (!fs.existsSync(bundlePath)) {
    output.push('Unminified JS source not found at: ' + bundlePath);
  } else {
    const lines = fs.readFileSync(bundlePath, 'utf8').split(/\r?\n/u);
    output.push('Unminified JS source lines: ' + lines.length);
    const positions = [...String(result.error ?? '').matchAll(/main\.jsbundle:(\d+):(\d+)/gu)]
      .map((m) => ({ line: Number(m[1]), column: Number(m[2]) }));
    for (const { line, column } of positions.slice(0, 8)) {
      output.push('\n-- main.jsbundle line ' + line + ', column ' + column + ' --');
      if (line > lines.length) {
        output.push('Line exceeds source length: original error may target Hermes-transformed bundle');
        continue;
      }
      for (let index = Math.max(0, line - 9); index < Math.min(lines.length, line + 8); index++) {
        output.push((index + 1) + ': ' + lines[index].slice(0, 650));
      }
    }
  }
}
fs.writeFileSync(outPath, output.join('\n') + '\n');
console.log(output.join('\n').slice(0, 3500));
