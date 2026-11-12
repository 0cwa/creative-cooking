import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'node_modules/@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm');
const destination = join(root, 'dist/_expo/static/js/web/wa-sqlite-async.wasm');
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (statSync(destination).size < 1_000_000) {
  throw new Error('The PowerSync SQLite WebAssembly runtime was not copied correctly.');
}
console.log('Copied the PowerSync SQLite WebAssembly runtime into the static web bundle.');
