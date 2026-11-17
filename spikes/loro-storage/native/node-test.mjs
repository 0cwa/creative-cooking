// Supplemental SQLite transaction test; the Android/Hermes binding requires its own proof.
import {DatabaseSync} from 'node:sqlite';
import {LoroDoc as WebLoroDoc} from '../node_modules/loro-crdt/nodejs/index.js';
import {run} from './scenario.js';
import {unlinkSync} from 'node:fs';
import assert from 'node:assert/strict';
const path=process.env.S1_SQLITE_PATH;
assert(path, 'Set S1_SQLITE_PATH to an isolated disposable database path');
class LoroDoc extends WebLoroDoc {
  import_(bytes) { return this.import(new Uint8Array(bytes)); }
  export(options) { return super.export(options.mode === 'updates' ? {mode:'update'} : options); }
}
const openDb=()=>{
  const db=new DatabaseSync(path);
  return {close:()=>db.close(), executeSync:(sql,params=[])=>{
    const statement=db.prepare(sql);
    const args=params.map(p=>p instanceof ArrayBuffer ? Buffer.from(p) : ArrayBuffer.isView(p) ? Buffer.from(p.buffer,p.byteOffset,p.byteLength) : p);
    return {rows:sql.startsWith('SELECT')?statement.all(...args):(statement.run(...args),[])};
  }};
};
try { assert.match(run(LoroDoc,openDb),/^PASS FIRST/); assert.match(run(LoroDoc,openDb),/^PASS RESTORED/); console.log('PASS Node SQLite + Loro: first and reopened scenarios'); } finally { try { unlinkSync(path); } catch {} }
