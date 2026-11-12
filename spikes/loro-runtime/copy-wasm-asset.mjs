import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = resolve(root, 'node_modules/loro-crdt/bundler/loro_wasm_bg.wasm');
const destination = resolve(root, 'dist/_expo/static/js/web/loro_wasm_bg.wasm');

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`Copied Loro WebAssembly asset to ${destination}`);
