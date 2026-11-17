import {copyFileSync, mkdirSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const source=join(root,'node_modules/loro-crdt/web/loro_wasm_bg.wasm');
const destination=join(root,'dist/_expo/static/js/web/loro_wasm_bg.wasm');
mkdirSync(dirname(destination),{recursive:true});copyFileSync(source,destination);
if(statSync(destination).size<1_000_000)throw Error('The Loro WebAssembly runtime was not copied correctly.');
console.log('Copied the Loro WebAssembly runtime into the static web bundle.');
