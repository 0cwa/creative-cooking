import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

async function bundle(contents) {
  const result = await build({
    stdin: {
      contents,
      sourcefile: 'entry.mjs',
      loader: 'js',
      resolveDir: process.cwd()
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: ['es2022'],
    minify: true,
    conditions: ['browser', 'import', 'default'],
    loader: { '.wasm': 'binary' },
    legalComments: 'none'
  });
  const bytes = result.outputFiles.reduce((sum, file) => sum + file.contents.byteLength, 0);
  const concatenated = Buffer.concat(result.outputFiles.map((file) => Buffer.from(file.contents)));
  return {
    outputFiles: result.outputFiles.map((file) => ({ path: file.path, bytes: file.contents.byteLength })),
    bytes,
    gzipBytes: gzipSync(concatenated).byteLength
  };
}

const baseline = await bundle('export const marker = 1;');
const automerge = await bundle(
  'import * as A from "@automerge/automerge"; export function smoke(){ let d=A.init(); d=A.change(d,x=>{x.ok=true}); return A.save(d).byteLength; }'
);

const output = {
  engine: '@automerge/automerge',
  version: '3.5.0',
  bundler: 'esbuild 0.28.0',
  generatedAt: new Date().toISOString(),
  baseline,
  automerge,
  incrementalBytes: automerge.bytes - baseline.bytes,
  incrementalGzipBytes: automerge.gzipBytes - baseline.gzipBytes,
  note: 'Isolated browser-production bundle delta. Creative Cooking production PWA still uses Expo web export; this spike does not add Automerge to the application bundle.'
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/bundle-impact.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
