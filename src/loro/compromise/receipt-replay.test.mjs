import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {openSQLiteStorage} from '../storage/sqlite.ts';
const key=(...x)=>JSON.stringify(x),bytes=(...x)=>new Uint8Array(x);
test('receipt replay requires a consistent retained monotonic acknowledgement',async()=>{
 const db=new DatabaseSync(':memory:'),conn={executeSync:(q,a=[])=>{const s=db.prepare(q);return {rows:q.startsWith('SELECT')?s.all(...a):(s.run(...a),[])}}},storage=openSQLiteStorage(conn);
 try {
  const c={expectedAuthority:{version:2,scope:{kind:'personal',id:'house'},record:null},scopeId:'house',operationId:'op',documents:[{documentId:'d',bytes:bytes(1),expectedRevision:null}],commands:[{version:1,commandId:'c',effectId:'e',documentId:'d',kind:'write',payload:bytes(2),dependencyEffectIds:[]}],outbound:[{object:{id:'o',bytes:bytes(3)},branchHead:'h',epochId:'e'}]};
  assert.equal((await storage.commitLocal(c)).ok,true);
  const stored={scopeId:'house',objectId:'o',receiptId:'s',destination:'peer',recipientId:'p',state:'stored',bytes:bytes(4)},applied={...stored,receiptId:'a',state:'applied',bytes:bytes(5)},stateKey=key('receipt-state','house','o','peer','p'),put=v=>db.prepare('INSERT OR REPLACE INTO loro_records VALUES (?,?)').run(stateKey,JSON.stringify(v)),del=()=>db.prepare('DELETE FROM loro_records WHERE key=?').run(stateKey),rows=()=>JSON.stringify(db.prepare('SELECT key,value FROM loro_records ORDER BY key').all());
  assert.equal((await storage.recordReceipt(stored)).value.replayed,false);del();let before=rows();assert.equal((await storage.recordReceipt(stored)).error,'CORRUPT');assert.equal(rows(),before);
  put('stored');assert.equal((await storage.recordReceipt(applied)).value.replayed,false);assert.equal((await storage.recordReceipt(stored)).value.replayed,true);assert.equal(JSON.parse(db.prepare('SELECT value FROM loro_records WHERE key=?').get(stateKey).value),'applied');
  for(const value of ['stored',undefined]){if(value===undefined)del();else put(value);before=rows();assert.equal((await openSQLiteStorage(conn).recordReceipt(applied)).error,'CORRUPT');assert.equal(rows(),before)}
  put('applied');assert.equal((await openSQLiteStorage(conn).recordReceipt(applied)).value.replayed,true);assert.equal((await openSQLiteStorage(conn).recordReceipt(stored)).value.replayed,true);
 } finally {db.close()}
});
