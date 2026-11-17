// Checks the bytes emitted by the Hermes compatibility probe using Loro 1.17.1.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';
const result=JSON.parse(readFileSync(process.argv[2],'utf8'));
for (const name of ['nativeSnapshot','nativeUpdate']) {
 const bytes=Uint8Array.from(result[name]);
 const doc=new LoroDoc();const status=doc.import(bytes);
 assert.equal(status.pending?.size || 0,0);
 assert.deepEqual(doc.toJSON(),{recipe:{title:'native',visible:false}});
 assert.equal(decodeImportBlobMeta(bytes,true).mode,name==='nativeSnapshot'?'snapshot':'update');
}
console.log('PASS Loro 1.17.1 imports native 1.10.3 snapshot and update');
