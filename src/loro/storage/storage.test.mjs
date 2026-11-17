import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openSQLiteStorage } from './sqlite.ts';

const b = (...x) => new Uint8Array(x);
const child = (scope,op,doc,revision=null) => ({scopeId:scope,operationId:op,documents:[{documentId:doc,bytes:b(1),expectedRevision:revision}],commands:[{version:1,commandId:op,effectId:op,documentId:doc,kind:'write',payload:b(2),dependencyEffectIds:[]}],outbound:[{object:{id:op,bytes:b(3)},branchHead:'h',epochId:'e'}]});
const connection = () => { const db = new DatabaseSync(':memory:'); return {db, executeSync:(sql,params=[]) => { const s=db.prepare(sql); return {rows:sql.startsWith('SELECT') ? s.all(...params) : (s.run(...params),[])}; }}; };
test('SQLite group rollback, replay, identity conflicts, staging, import and receipts', async () => {
 const conn=connection(); let fault='child'; const s=openSQLiteStorage(conn, x=>{if(x===fault) throw Error('fault')});
 const group={groupId:'g',children:[child('personal','a','chef'),child('household','b','effect')]};
 assert.equal((await s.commitLocalGroup(group)).ok,false);
 assert.equal((await s.reopenDocument('personal','chef')).value,null);
 fault='group'; assert.equal((await s.commitLocalGroup(group)).ok,false);
 assert.equal((await s.reopenDocument('household','effect')).value,null);
 fault=''; assert.equal((await s.commitLocalGroup(group)).value.replayed,false);
 assert.equal((await s.commitLocalGroup(group)).value.replayed,true);
 assert.equal((await s.commitLocalGroup({...group,children:[child('personal','a','chef',0),group.children[1]]})).error.code,'CONFLICT');
 assert.equal((await s.commitLocalGroup({groupId:'new',children:group.children})).error.code,'CONFLICT');
 const item={scopeId:'household',object:{id:'incoming',bytes:b(5)},source:'relay',expectedCursor:null,cursor:'opaque'};
 fault='inbox'; assert.equal((await s.stageInbox(item)).ok,false); fault=''; assert.equal((await s.stageInbox(item)).ok,true);
 assert.equal((await s.stageInbox({...item,object:{id:'other',bytes:b(6)}})).error,'CONFLICT');
 const imp={scopeId:'household',operationId:'import',itemId:'incoming',documents:[{documentId:'effect',bytes:b(8),expectedRevision:0}],effectIds:['remote']};
 fault='import-documents'; assert.equal((await s.commitImport(imp)).ok,false); assert.equal((await s.reopenDocument('household','effect')).value.revision,0);
 fault=''; assert.equal((await s.commitImport(imp)).value.replayed,false); assert.equal((await s.commitImport(imp)).value.replayed,true);
 const receipt={scopeId:'household',objectId:'b',receiptId:'r1',destination:'peer',recipientId:'peer',state:'applied',bytes:b(7)};
 assert.equal((await s.recordReceipt(receipt)).error,'CONFLICT');
 assert.equal((await s.recordReceipt({...receipt,receiptId:'r0',state:'stored'})).ok,true);
 assert.equal((await s.recordReceipt(receipt)).ok,true); assert.equal((await s.recordReceipt(receipt)).value.replayed,true);
 assert.equal((await s.recordReceipt({...receipt,bytes:b(8)})).error,'CONFLICT');
 conn.db.close();
});

test('every group write rolls back, and a partial identity prevents replay', async () => {
 const group={groupId:'g',children:[child('personal','a','chef'),child('household','b','effect')]};
 for(let boundary=1;boundary<=11;boundary++) {
  const conn=connection(); let writes=0; const s=openSQLiteStorage(conn,x=>{if(x==='write' && ++writes===boundary)throw Error('injected')});
  assert.equal((await s.commitLocalGroup(group)).ok,false,`write ${boundary}`);
  assert.equal((await s.reopenDocument('personal','chef')).value,null);
  assert.equal((await s.reopenDocument('household','effect')).value,null);
  assert.equal(conn.db.prepare('SELECT count(*) AS n FROM loro_records').get().n,0); conn.db.close();
 }
 const conn=connection(); const s=openSQLiteStorage(conn); assert.equal((await s.commitLocalGroup(group)).ok,true);
 conn.db.prepare('DELETE FROM loro_records WHERE key = ?').run(JSON.stringify(['effect','personal','a']));
 assert.equal((await s.commitLocalGroup(group)).error.code,'CONFLICT'); conn.db.close();
});

test('retry keeps original revision after subsequent writes and import faults retain staged bytes', async () => {
 const conn=connection(); let n=0, failAt=0; const s=openSQLiteStorage(conn,x=>{if(x==='write' && ++n===failAt)throw Error('injected')});
 const first=child('scope','one','d'); assert.equal((await s.commitLocal(first)).value.outcome.revisions[0].revision,0);
 assert.equal((await s.commitLocal(child('scope','two','d',0))).value.outcome.revisions[0].revision,1);
 assert.equal((await s.commitLocal(first)).value.outcome.revisions[0].revision,0);
 const item={scopeId:'scope',object:{id:'i',bytes:b(4)},source:'s',expectedCursor:null,cursor:'c'}; assert.equal((await s.stageInbox(item)).ok,true);
 const imp={scopeId:'scope',operationId:'iop',itemId:'i',documents:[{documentId:'d',bytes:b(9),expectedRevision:1}],effectIds:['ie']};
 for(let boundary=1;boundary<=4;boundary++) { n=0;failAt=boundary;assert.equal((await s.commitImport(imp)).ok,false);assert.equal((await s.reopenDocument('scope','d')).value.revision,1); }
 failAt=0;assert.equal((await s.commitImport(imp)).ok,true);assert.equal((await s.commitImport(imp)).value.replayed,true);conn.db.close();
});

test('corrupt SQLite records fail closed without overwriting or false replay', async () => {
 const conn=connection();const s=openSQLiteStorage(conn);const put=(k,v)=>conn.db.prepare('INSERT OR REPLACE INTO loro_records (key,value) VALUES (?,?)').run(JSON.stringify(k),JSON.stringify(v));
 put(['document','s','d'],{revision:0});
 assert.equal((await s.reopenDocument('s','d')).error,'CORRUPT');assert.equal((await s.commitLocal(child('s','bad','d',0))).error.code,'CORRUPT');
 for(const byte of [256,-1,1.5,'2',null]) { put(['document','s','d'],{revision:0,bytes:{__storageBytes:[byte]}});assert.equal((await s.reopenDocument('s','d')).error,'CORRUPT'); }
 conn.db.prepare('DELETE FROM loro_records').run();const c=child('s','ok','d');assert.equal((await s.commitLocal(c)).ok,true);assert.equal((await s.commitLocal(c)).value.replayed,true);
 const op=JSON.parse(conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(JSON.stringify(['local','s','ok'])).value);op.outcome.revisions=[];put(['local','s','ok'],op);assert.equal((await s.commitLocal(c)).error.code,'CORRUPT');assert.equal((await s.reopenDocument('s','d')).value.revision,0);conn.db.close();
});
