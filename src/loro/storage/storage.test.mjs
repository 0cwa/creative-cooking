import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openSQLiteStorage } from './sqlite.ts';

const b = (...x) => new Uint8Array(x);
const child = (scope,op,doc,revision=null) => ({expectedAuthority:{version:2,scope:{kind:'personal',id:scope},record:null},scopeId:scope,operationId:op,documents:[{documentId:doc,bytes:b(1),expectedRevision:revision}],commands:[{version:1,commandId:op,effectId:op,documentId:doc,kind:'write',payload:b(2),dependencyEffectIds:[]}],outbound:[{object:{id:op,bytes:b(3)},branchHead:'h',epochId:'e'}]});
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
 const imp={version:2,expectedAuthority:{version:2,scope:{kind:'personal',id:'household'},record:null},scopeId:'household',operationId:'import',itemId:'incoming',documents:[{documentId:'effect',bytes:b(8),expectedRevision:0}],commands:[{version:1,commandId:'import-remote',effectId:'remote',documentId:'effect',kind:'write',payload:b(1),dependencyEffectIds:[]}],effectIds:['remote']};
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
 const imp={version:2,expectedAuthority:{version:2,scope:{kind:'personal',id:'scope'},record:null},scopeId:'scope',operationId:'iop',itemId:'i',documents:[{documentId:'d',bytes:b(9),expectedRevision:1}],commands:[{version:1,commandId:'import-ie',effectId:'ie',documentId:'d',kind:'write',payload:b(1),dependencyEffectIds:[]}],effectIds:['ie']};
 for(let boundary=1;boundary<=5;boundary++) { n=0;failAt=boundary;assert.equal((await s.commitImport(imp)).ok,false);assert.equal((await s.reopenDocument('scope','d')).value.revision,1); }
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

test('listRecords returns scoped durable records without exposing stored bytes', async () => {
 const conn=connection();const s=openSQLiteStorage(conn);assert.equal((await s.commitLocal(child('a','one','d'))).ok,true);assert.equal((await s.commitLocal(child('b','two','d'))).ok,true);
 const list=await s.listRecords('document','a');assert.equal(list.ok,true);assert.equal(list.value.length,1);assert.deepEqual(list.value[0].identity,['d']);list.value[0].value.bytes[0]=42;assert.deepEqual((await s.reopenDocument('a','d')).value.bytes,b(1));conn.db.close();
});

test('pairing authority CAS and release survive reopen and reject reuse or stale authority', async () => {
 const {fixturePairingRelease:p}=await import('../contracts/fixtures.ts'); const conn=connection(); let s=openSQLiteStorage(conn);
 const authority={scope:p.transcript.scope,revision:0,acceptedParent:p.transcript.acceptedParent,authorizationSnapshot:p.transcript.authorizationSnapshot,authorityState:b(9)};
 assert.equal((await s.compareAndSwapPairingAuthority({expectedRevision:null,record:authority})).ok,true);
 const release={...p,expectedAuthorityRevision:0};
 assert.equal((await s.commitPairingRelease({...release,expectedAuthorityRevision:1})).error.code,'CONFLICT');
 assert.equal((await s.findPairingRelease(authority.scope,p.operationId)).value,null);
 assert.equal((await s.commitPairingRelease(release)).value.replayed,false);
 s=openSQLiteStorage(conn); const found=(await s.findPairingRelease(authority.scope,p.operationId)).value; assert.deepEqual(found,release);
 assert.equal((await s.compareAndSwapPairingAuthority({expectedRevision:0,record:{...authority,revision:1}})).ok,true);
 assert.equal((await s.commitPairingRelease(release)).value.replayed,true);
 assert.equal((await s.commitPairingRelease({...release,packet:{...release.packet,bytes:b(8)}})).error.code,'CONFLICT');
 assert.equal((await s.commitPairingRelease({...release,operationId:'other',packet:{...release.packet,id:'other'},outbox:{...release.outbox,objectId:'other'},outcome:{...release.outcome,packetId:'other'}})).error.code,'CONFLICT');
 const next={...release,operationId:'next',guard:{...release.guard,guardId:'next'},packet:{...release.packet,id:'next'},outbox:{...release.outbox,objectId:'next'},outcome:{...release.outcome,packetId:'next'}};
 assert.equal((await s.commitPairingRelease(next)).error.code,'CONFLICT');
 assert.equal((await s.compareAndSwapPairingAuthority({expectedRevision:0,record:{...authority,revision:1}})).error,'CONFLICT');
 const scope={kind:'household',id:authority.scope.id}; assert.equal((await s.readPairingAuthority(scope)).value,null);
 const mismatched=structuredClone(next); mismatched.guard.direction='responder-to-initiator'; assert.equal((await s.commitPairingRelease(mismatched)).error.code,'MALFORMED');
 mismatched.guard.direction='initiator-to-responder'; mismatched.guard.purpose='different'; assert.equal((await s.commitPairingRelease(mismatched)).error.code,'MALFORMED');
 conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(JSON.stringify(['pairing-guard',release.guard.guardId]));
 assert.equal((await s.findPairingRelease(authority.scope,release.operationId)).error,'CORRUPT'); assert.equal((await s.commitPairingRelease(release)).error.code,'CORRUPT'); conn.db.close();
});

test('each pairing release write rolls back completely', async () => {
 const {fixturePairingRelease:p}=await import('../contracts/fixtures.ts');
 for(let boundary=1;boundary<=4;boundary++) {
  const conn=connection(); let n=0, enabled=false; const s=openSQLiteStorage(conn,x=>{if(enabled && x==='write' && ++n===boundary) throw Error('injected')});
  const authority={scope:p.transcript.scope,revision:0,acceptedParent:p.transcript.acceptedParent,authorizationSnapshot:p.transcript.authorizationSnapshot,authorityState:b(1)};
  assert.equal((await s.compareAndSwapPairingAuthority({expectedRevision:null,record:authority})).ok,true); enabled=true;
  assert.equal((await s.commitPairingRelease({...p,expectedAuthorityRevision:0})).error.code,'IO');
  assert.equal((await s.findPairingRelease(authority.scope,p.operationId)).value,null);
  assert.equal(conn.db.prepare('SELECT count(*) AS n FROM loro_records').get().n,1); conn.db.close();
 }
});

test('typed runtime reads recover scoped records and recipient state as copies', async () => {
 const conn=connection(),s=openSQLiteStorage(conn); assert.equal((await s.commitLocal(child('a','o','d'))).ok,true); assert.equal((await s.commitLocal(child('b','other','d'))).ok,true);
 assert.equal((await s.stageInbox({scopeId:'a',object:{id:'in',bytes:b(8)},source:'relay',expectedCursor:null,cursor:'cur'})).ok,true);
 assert.equal((await s.recordReceipt({scopeId:'a',objectId:'o',receiptId:'r',destination:'peer',recipientId:'p',state:'stored',bytes:b(4)})).ok,true);
 const docs=(await s.listDocuments('a')).value; assert.equal(docs.length,1); docs[0].bytes[0]=77; assert.equal((await s.listDocuments('a')).value[0].bytes[0],1);
 assert.deepEqual((await s.listOutboundObjects('a')).value.map(x=>x.objectId),['o']);
 assert.deepEqual((await s.listStagedInbox('a')).value.map(x=>x.itemId),['in']);
 assert.deepEqual((await s.listCursors('a')).value,[{source:'relay',cursor:'cur'}]);
 assert.deepEqual((await s.listReceiptStates('a')).value,[{objectId:'o',destination:'peer',recipientId:'p',state:'stored'}]);
 conn.db.prepare('INSERT INTO loro_records (key,value) VALUES (?,?)').run(JSON.stringify(['receipt-state','a','o','invalid','p']),JSON.stringify('stored')); assert.equal((await s.listReceiptStates('a')).error,'CORRUPT'); conn.db.close();
});

test('recovery reads exact saved local operation and applied inbox outcome', async () => {
 const conn=connection(),s=openSQLiteStorage(conn),c=child('s','one','d'); assert.equal((await s.getLocalOperation('s','one')).value,null); assert.equal((await s.commitLocal(c)).ok,true);
 const saved=(await s.getLocalOperation('s','one')).value; assert.deepEqual(saved.commit,c); saved.commit.documents[0].bytes[0]=99; assert.deepEqual((await s.getLocalOperation('s','one')).value.commit,c);
 const item={scopeId:'s',object:{id:'in',bytes:b(1)},source:'p',expectedCursor:null,cursor:'c'}; await s.stageInbox(item); assert.equal((await s.getInboxApplication('s','in')).value,null);
 const imp={version:2,expectedAuthority:{version:2,scope:{kind:'personal',id:'s'},record:null},scopeId:'s',operationId:'imp',itemId:'in',documents:[{documentId:'d',bytes:b(5),expectedRevision:0}],commands:[{version:1,commandId:'import-e',effectId:'e',documentId:'d',kind:'write',payload:b(1),dependencyEffectIds:[]}],effectIds:['e']}; await s.commitImport(imp); assert.equal((await s.getInboxApplication('s','in')).value.operationId,'imp');
 conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(JSON.stringify(['effect','s','e'])); assert.equal((await s.getInboxApplication('s','in')).error,'CORRUPT'); conn.db.close();
});

test('pairing rejects misrouted packets in either direction without consuming guard', async () => {
 const {fixturePairingRelease:p}=await import('../contracts/fixtures.ts'); const conn=connection(),s=openSQLiteStorage(conn); const authority={scope:p.transcript.scope,revision:0,acceptedParent:p.transcript.acceptedParent,authorizationSnapshot:p.transcript.authorizationSnapshot,authorityState:b(1)};
 await s.compareAndSwapPairingAuthority({expectedRevision:null,record:authority});
 for (const direction of ['initiator-to-responder','responder-to-initiator']) { const recipient=direction==='initiator-to-responder' ? p.transcript.responder.deviceId : p.transcript.initiator.deviceId; const release={...p,expectedAuthorityRevision:0,operationId:direction,guard:{...p.guard,guardId:direction,direction},packet:{...p.packet,id:direction},outbox:{destination:'unrelated',objectId:direction},outcome:{recipientDevice:recipient,packetId:direction}};
 assert.equal((await s.commitPairingRelease(release)).error.code,'MALFORMED'); assert.equal((await s.findPairingRelease(authority.scope,direction)).value,null); assert.equal((await s.commitPairingRelease({...release,outbox:{...release.outbox,destination:recipient}})).ok,true); }
 conn.db.close();
});

test('saved local recovery reports corrupt missing effect', async () => {
 const conn=connection(),s=openSQLiteStorage(conn); await s.commitLocal(child('s','op','d')); conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(JSON.stringify(['effect','s','op'])); assert.equal((await s.getLocalOperation('s','op')).error,'CORRUPT'); conn.db.close();
});

test('authority revisions guard local, import and every group child inside transaction', async () => {
 const conn=connection(),s=openSQLiteStorage(conn); const scope={kind:'household',id:'h'}, rec={scope,revision:0,acceptedParent:'head',authorizationSnapshot:'snap',authorityState:b(1)}; await s.compareAndSwapPairingAuthority({expectedRevision:null,record:rec});
 const expect={version:2,scope,record:{revision:0,acceptedParent:'head',authorizationSnapshot:'snap'}}; const c={...child('h','o','d'),expectedAuthority:expect};
 assert.equal((await s.commitLocal(c)).ok,true); await s.compareAndSwapPairingAuthority({expectedRevision:0,record:{...rec,revision:1}});
 assert.equal((await s.commitLocal(c)).value.replayed,true); const stale={...child('h','stale','next'),expectedAuthority:expect}; assert.equal((await s.commitLocal(stale)).error.code,'CONFLICT'); assert.equal((await s.reopenDocument('h','next')).value,null);
 const item={scopeId:'h',object:{id:'in',bytes:b(4)},source:'p',expectedCursor:null,cursor:'c'}; await s.stageInbox(item);
 const imp={version:2,scopeId:'h',operationId:'imp',itemId:'in',documents:[{documentId:'d',bytes:b(2),expectedRevision:0}],commands:[{version:1,commandId:'import-e',effectId:'e',documentId:'d',kind:'write',payload:b(1),dependencyEffectIds:[]}],effectIds:['e'],expectedAuthority:expect}; assert.equal((await s.commitImport(imp)).error.code,'CONFLICT'); assert.equal((await s.getInboxApplication('h','in')).value,null);
 const group={groupId:'authority-group',children:[child('p','p','d'),stale]}; assert.equal((await s.commitLocalGroup(group)).error.code,'CONFLICT'); assert.equal((await s.reopenDocument('p','d')).value,null);
 const absent=child('h','bootstrap','x'); absent.expectedAuthority.scope=scope; assert.equal((await s.commitLocal(absent)).error.code,'CONFLICT');
 const changed={...c,expectedAuthority:{...expect,record:{...expect.record,acceptedParent:'other'}}}; assert.equal((await s.commitLocal(changed)).error.code,'CONFLICT'); conn.db.close();
});

test('legacy operations are retained but recovery reports unsupported version', async () => {
 const conn=connection(),s=openSQLiteStorage(conn),c=child('s','old','d'); await s.commitLocal(c); const k=JSON.stringify(['local','s','old']); const old=JSON.parse(conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(k).value); const input=JSON.parse(old.inputKey); delete input[1].expectedAuthority; old.inputKey=JSON.stringify(input); conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(old),k); assert.equal((await s.getLocalOperation('s','old')).error,'UNSUPPORTED_VERSION'); assert.ok(conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(k)); conn.db.close();
});

test('imports reserve shared command and effect identities across all operations', async () => {
 const conn=connection(),s=openSQLiteStorage(conn),scope='s'; let cursor=null;
 const stage=async id=>{assert.equal((await s.stageInbox({scopeId:scope,object:{id,bytes:b(1)},source:'peer',expectedCursor:cursor,cursor:id})).ok,true);cursor=id;};
 const cmd=(id,effect,payload=1)=>({version:1,commandId:id,effectId:effect,documentId:'d',kind:'purchase',payload:b(payload),dependencyEffectIds:[]});
 const imp=(id,item,command,rev=null)=>({version:2,expectedAuthority:{version:2,scope:{kind:'personal',id:scope},record:null},scopeId:scope,operationId:id,itemId:item,documents:[{documentId:'d',bytes:b(1),expectedRevision:rev}],commands:[command],effectIds:[command.effectId]});
 await stage('i1');const first=imp('first','i1',cmd('shared','effect1')); assert.equal((await s.commitImport(first)).ok,true);
 await stage('i2');const next=imp('second','i2',cmd('shared','effect2',2),0);assert.equal((await s.commitImport(next)).error.code,'CONFLICT');assert.equal((await s.getInboxApplication(scope,'i2')).value,null);assert.equal((await s.reopenDocument(scope,'d')).value.revision,0);
 const local=child(scope,'local','other');local.commands[0].commandId='shared';assert.equal((await s.commitLocal(local)).error.code,'CONFLICT');assert.equal((await s.reopenDocument(scope,'other')).value,null);
 const separate=child(scope,'local2','other');assert.equal((await s.commitLocal(separate)).ok,true); await stage('i3'); const third=imp('third','i3',cmd('local2','effect3'),0);assert.equal((await s.commitImport(third)).error.code,'CONFLICT');
 assert.equal((await s.commitImport({...first,commands:[cmd('shared','effect1',9)]})).error.code,'CONFLICT'); assert.equal((await s.compareAndSwapPairingAuthority({expectedRevision:null,record:{scope:{kind:'personal',id:'s'},revision:0,acceptedParent:'h',authorizationSnapshot:'p',authorityState:b(1)}})).ok,true); assert.equal((await openSQLiteStorage(conn).commitImport(first)).value.replayed,true);
 conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(JSON.stringify(['command','s','shared'])); assert.equal((await s.getInboxApplication(scope,'i1')).error,'CORRUPT');assert.equal((await s.commitImport(first)).error.code,'CONFLICT'); conn.db.close();
});

test('legacy import records are retained and report unsupported for recovery', async () => {
 const conn=connection(),s=openSQLiteStorage(conn);const put=(k,v)=>conn.db.prepare('INSERT INTO loro_records (key,value) VALUES (?,?)').run(JSON.stringify(k),JSON.stringify(v));
 const input={expectedAuthority:{version:2,scope:{kind:'personal',id:'s'},record:null},scopeId:'s',operationId:'old',itemId:'i',documents:[{documentId:'d',bytes:[1],expectedRevision:null}],effectIds:['e']};
 put(['inbox','s','i'],{bytes:{__storageBytes:[1]}});put(['applied','s','i'],'old');put(['import','s','old'],{inputKey:JSON.stringify(['import',input]),outcome:{state:'saved',revisions:[{documentId:'d',revision:0}]}});
 assert.equal((await s.getInboxApplication('s','i')).error,'UNSUPPORTED_VERSION'); assert.equal(conn.db.prepare('SELECT count(*) AS n FROM loro_records').get().n,3); conn.db.close();
});

test('maximum candidate plaintext envelope stages, commits, imports and reopens within object limits', async () => {
 const sodium=(await import('libsodium-wrappers')).default; await sodium.ready;
 const {candidateCodec,SUITE,LIMIT,ENCODED_LIMIT}=await import('../crypto/candidate.mjs'); const {testProvider}=await import('../crypto/test-provider.mjs'); const {STORAGE_LIMITS,validateInboxItem}=await import('../contracts/index.ts');
 assert.equal(STORAGE_LIMITS.objectBytes,ENCODED_LIMIT); assert.equal(STORAGE_LIMITS.totalBytes,8*ENCODED_LIMIT);
 const signing=sodium.crypto_sign_keypair(),recipient=sodium.crypto_box_keypair(),initialKey=sodium.randombytes_buf(32); const provider=testProvider(sodium,{signing,recipient,publicSigning:signing.publicKey,publicRecipient:recipient.publicKey,initialKey});
 const id='\u0001'.repeat(256),refs=Array.from({length:64},(_,i)=>String(i).padStart(3,'0')+'\u0001'.repeat(253));
 const header={version:1,suiteId:SUITE,scopeId:id,documentId:id,documentGeneration:Number.MAX_SAFE_INTEGER,branchHead:id,policyHashes:refs,epochId:id,authorDevice:'sender',deviceSequence:Number.MAX_SAFE_INTEGER,predecessorRefs:refs,semanticEffectIds:refs,payloadKind:id};
 const envelope=await candidateCodec(provider).sealContent(header,new Uint8Array(LIMIT),'data'); assert.equal(envelope.bytes.length,2398002); assert.ok(envelope.bytes.length > STORAGE_LIMITS.itemBytes);
 const conn=connection(),s=openSQLiteStorage(conn),op=child('scope','large','doc'); op.outbound[0].object=envelope;
 assert.equal((await s.commitLocal(op)).ok,true); assert.deepEqual((await s.listOutboundObjects('scope')).value[0].bytes,envelope.bytes);
 const inbox={scopeId:'scope',object:envelope,source:'peer',expectedCursor:null,cursor:'c'}; assert.equal((await s.stageInbox(inbox)).ok,true);
 const imp={version:2,commands:[{version:1,commandId:'large-command',effectId:'remote',documentId:'doc',kind:'write',payload:b(1),dependencyEffectIds:[]}],expectedAuthority:{version:2,scope:{kind:'personal',id:'scope'},record:null},scopeId:'scope',operationId:'import-large',itemId:envelope.id,documents:[{documentId:'doc',bytes:b(8),expectedRevision:0}],effectIds:['remote']};
 assert.equal((await s.commitImport(imp)).ok,true); const reopened=openSQLiteStorage(conn); assert.deepEqual((await reopened.listStagedInbox('scope')).value[0].bytes,envelope.bytes); assert.equal((await reopened.getInboxApplication('scope',envelope.id)).value.operationId,'import-large');
 const bound={...inbox,object:{id:'bound',bytes:new Uint8Array(ENCODED_LIMIT)},expectedCursor:'c'}; assert.equal(validateInboxItem(bound).ok,true); const tooLarge={...bound,object:{id:'over',bytes:new Uint8Array(ENCODED_LIMIT+1)}}; assert.equal((await s.stageInbox(tooLarge)).error,'TOO_LARGE'); const invalid=child('scope','too-large','other'); invalid.outbound[0].object=tooLarge.object; assert.equal((await s.commitLocal(invalid)).error.code,'TOO_LARGE'); assert.equal((await s.reopenDocument('scope','other')).value,null); assert.equal((await s.listStagedInbox('scope')).value.length,1); conn.db.close();
});

test('recover completed group input and reject damaged child associations',async()=>{
 const conn=connection(),store=openSQLiteStorage(conn),group={groupId:'recover-group',children:[child('personal','one','d1'),child('shared','two','d2')]};
 assert.equal((await store.getLocalGroup(group.groupId)).value,null);
 assert.equal((await store.commitLocalGroup(group)).ok,true);
 const reopened=openSQLiteStorage(conn), recovered=await reopened.getLocalGroup(group.groupId);
 assert.deepEqual(recovered.value.group,group); assert.equal(recovered.value.outcomes.length,2);
 assert.equal((await reopened.commitLocalGroup(recovered.value.group)).value.replayed,true);
 const gkey=JSON.stringify(['group',group.groupId]), saved=conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(gkey).value;
 const record=JSON.parse(saved), parsed=JSON.parse(record.inputKey); parsed[1].reverse(); record.inputKey=JSON.stringify(parsed);
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(record),gkey);
 assert.equal((await reopened.getLocalGroup(group.groupId)).error,'CORRUPT');
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(saved,gkey);
 conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(JSON.stringify(['local','personal','one']));
 assert.equal((await reopened.getLocalGroup(group.groupId)).error,'CORRUPT'); conn.db.close();
});

test('legacy group lookup explicitly rejects missing authority without deleting records',async()=>{
 const conn=connection(), store=openSQLiteStorage(conn), group={groupId:'legacy-group',children:[child('scope','op','doc')]};
 assert.equal((await store.commitLocalGroup(group)).ok,true);
 const k=JSON.stringify(['group',group.groupId]), original=conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(k).value, record=JSON.parse(original), parsed=JSON.parse(record.inputKey), old=JSON.parse(parsed[1][0]); delete old[1].expectedAuthority; parsed[1][0]=JSON.stringify(old); record.inputKey=JSON.stringify(parsed);
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(record),k);
 assert.equal((await store.getLocalGroup(group.groupId)).error,'UNSUPPORTED_VERSION');
 assert.ok(conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(k)); conn.db.close();
});

test('projection publication commits atomically, survives lost acknowledgement and rejects changed input',async()=>{
 const conn=connection(); let failAt=0,writes=0; const store=openSQLiteStorage(conn,x=>{if(x==='write' && ++writes===failAt)throw Error('injected')});
 const scope={kind:'household',id:'h'}, parent={scope,revision:0,acceptedParent:'parent',authorizationSnapshot:'snapshot',authorityState:b(1)};
 assert.equal((await store.compareAndSwapPairingAuthority({expectedRevision:null,record:parent})).ok,true);
 assert.equal((await store.commitLocal(child('old-scope','old-edit','old-doc'))).ok,true);
 const source={...child('h','source-op','source-doc'),expectedAuthority:{version:2,scope,record:{revision:0,acceptedParent:'parent',authorizationSnapshot:'snapshot'}}};
 assert.equal((await store.commitLocal(source)).ok,true);
 const catalog={version:1,state:'ready',id:'master',check:new Uint8Array(32).fill(1)};
 conn.db.prepare('INSERT INTO loro_records(key,value) VALUES(?,?)').run(JSON.stringify(['local-master-catalog']),JSON.stringify({...catalog,check:{__storageBytes:Array.from(catalog.check)}}));
 const localKey={record:{version:1,operationId:'keyop',identity:{version:1,scope,deviceId:'local',purpose:'data',epochId:'new-epoch'},masterId:'master',publicKey:null,wrapped:new Uint8Array(32).fill(2)},catalog};
 const input={version:1,operationId:'pub',guardId:'guard',sourceDocument:{documentId:'source-doc',revision:0},expectedAuthority:{version:2,scope,record:{revision:0,acceptedParent:'parent',authorizationSnapshot:'snapshot'}},nextAuthority:{scope,revision:1,acceptedParent:'child',authorizationSnapshot:'next',authorityState:b(2)},admissionEventHash:'admission',grantHash:'grant',manifest:{id:'manifest',bytes:b(3)},epochId:'new-epoch',documents:[{documentId:'fresh',generation:2,bytes:b(4)}],packages:[{id:'package',recipientDevice:'new-device',bytes:b(5)}],localKey,pendingEdits:[{scopeId:'old-scope',operationId:'old-edit'}]};
 assert.equal((await store.publishProjection({...input,sourceDocument:{documentId:'source-doc',revision:1}})).error,'CONFLICT');
 const pendingKey=JSON.stringify(['local','old-scope','old-edit']), initial=conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(pendingKey).value, bad=JSON.parse(initial);bad.inputKey='bad-json';
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(bad),pendingKey);assert.equal((await store.publishProjection(input)).error,'CORRUPT');assert.equal((await store.readPairingAuthority(scope)).value.revision,0);
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(initial,pendingKey);
 const effectKey=JSON.stringify(['effect','old-scope','old-edit']), savedEffect=conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(effectKey).value;
 conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(effectKey);assert.equal((await store.publishProjection(input)).error,'CORRUPT');
 conn.db.prepare('INSERT INTO loro_records(key,value) VALUES(?,?)').run(effectKey,savedEffect);
 for(let n=1;n<=12;n++){ writes=0; failAt=n; const r=await store.publishProjection(input);assert.equal(r.ok,false,`write ${n}`);assert.equal((await store.readPairingAuthority(scope)).value.revision,0);assert.equal((await store.reopenDocument('h','fresh')).value,null);assert.equal((await store.getProjectionPublication('h','pub')).value,null); }
 failAt=0; writes=0; assert.equal((await store.publishProjection(input)).value.replayed,false);
 const reopened=openSQLiteStorage(conn); assert.deepEqual((await reopened.getProjectionPublication('h','pub')).value,input);
 assert.equal((await reopened.publishProjection(input)).value.replayed,true);
 const guardKey=JSON.stringify(['pairing-guard','guard']), savedGuard=conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(guardKey).value;
 conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(guardKey); assert.equal((await reopened.publishProjection(input)).error,'CORRUPT');
 conn.db.prepare('INSERT INTO loro_records(key,value) VALUES(?,?)').run(guardKey,savedGuard);
 assert.equal((await reopened.publishProjection({...input,grantHash:'different'})).error,'CONFLICT');
 assert.equal((await reopened.publishProjection({...input,operationId:'other'})).error,'CONFLICT');
 assert.equal((await reopened.readPairingAuthority(scope)).value.acceptedParent,'child');
 const catalogKey=JSON.stringify(['local-master-catalog']), savedCatalog=conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(catalogKey).value;
 conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(catalogKey);
 assert.equal((await reopened.getProjectionPublication('h','pub')).error,'CORRUPT');assert.equal((await reopened.publishProjection(input)).error,'CORRUPT');
 conn.db.prepare('INSERT INTO loro_records(key,value) VALUES(?,?)').run(catalogKey,savedCatalog);
 const replacement=JSON.parse(savedCatalog);replacement.id='different';conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(replacement),catalogKey);
 assert.equal((await reopened.getProjectionPublication('h','pub')).error,'CORRUPT');assert.equal((await reopened.publishProjection(input)).error,'CORRUPT');
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(savedCatalog,catalogKey);
 const localRecordKey=JSON.stringify(['local','old-scope','old-edit']), savedLocal=conn.db.prepare('SELECT value FROM loro_records WHERE key=?').get(localRecordKey).value, corrupted=JSON.parse(savedLocal);corrupted.inputKey='bad-json';
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(corrupted),localRecordKey);
 assert.equal((await reopened.getProjectionPublication('h','pub')).error,'CORRUPT');assert.equal((await reopened.publishProjection(input)).error,'CORRUPT');
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(savedLocal,localRecordKey);
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify('mismatch'),effectKey);assert.equal((await reopened.getProjectionPublication('h','pub')).error,'CORRUPT');assert.equal((await reopened.publishProjection(input)).error,'CORRUPT');
 conn.db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(savedEffect,effectKey);
 conn.db.prepare('DELETE FROM loro_records WHERE key=?').run(JSON.stringify(['projection-package','h','package']));
 assert.equal((await reopened.getProjectionPublication('h','pub')).error,'CORRUPT'); conn.db.close();
});

test('effect dependencies are checked atomically within the same scope and group order',async()=>{
 const conn=connection(),store=openSQLiteStorage(conn);
 const first=child('scope','first','d1'), second=child('scope','second','d2'); second.commands[0].dependencyEffectIds=['first'];
 assert.equal((await store.commitLocal(second)).error.code,'CONFLICT');
 assert.equal((await store.reopenDocument('scope','d2')).value,null);
 assert.equal((await store.commitLocalGroup({groupId:'good',children:[first,second]})).ok,true);
 const wrong=child('other','third','d3');wrong.commands[0].dependencyEffectIds=['first'];
 assert.equal((await store.commitLocal(wrong)).error.code,'CONFLICT');
 const a=child('scope','a','a'),z=child('scope','z','z');a.commands[0].dependencyEffectIds=['z'];
 assert.equal((await store.commitLocalGroup({groupId:'forward',children:[a,z]})).error.code,'CONFLICT');
 assert.equal((await store.reopenDocument('scope','a')).value,null);conn.db.close();
});
