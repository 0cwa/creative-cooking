import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {CompromiseReviews} from './review.mjs';import {webcrypto} from 'node:crypto';
globalThis.crypto??=webcrypto;
const hash=async b=>Buffer.from(await crypto.subtle.digest('SHA-256',b)).toString('hex');
function runner(db){db.exec('CREATE TABLE IF NOT EXISTS records(k TEXT PRIMARY KEY,v TEXT)');return async(write,fn)=>{db.exec(write?'BEGIN IMMEDIATE':'BEGIN');try{const v=await fn({get:async k=>{const r=db.prepare('SELECT v FROM records WHERE k=?').get(k);return r?JSON.parse(r.v,(_k,x)=>x&&Array.isArray(x.__storageBytes)?Uint8Array.from(x.__storageBytes):x):undefined},put:async(k,v)=>db.prepare('INSERT OR REPLACE INTO records VALUES (?,?)').run(k,JSON.stringify(v,(_k,x)=>x instanceof Uint8Array?{__storageBytes:Array.from(x)}:x)),keys:async()=>db.prepare('SELECT k FROM records').all().map(x=>x.k)});db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}}}
test('intake bounds precede crypto and quarantine and summaries roll back',async()=>{const db=new DatabaseSync(':memory:'),run=runner(db),r=new CompromiseReviews(run),f=new CompromiseReviews(run,()=>{throw Error('FAULT')}),checkpoint=new Uint8Array(),context={kind:'household',scopeId:'s',authorityHead:'h',authoritySnapshot:'a',authorityRevision:0,checkpointHash:await hash(checkpoint)};await assert.rejects(r.freeze({reviewId:'r',context,report:{},runtime:{},objects:[{sourceId:'inbox',objectId:'o',bytes:new Uint8Array(1048577)}],checkpointBytes:checkpoint}),/TOO_LARGE/);await assert.rejects(f.quarantine('s','d'),/FAULT/);assert.equal(await r.isQuarantined('s','d'),false);await r.quarantine('s','d');assert.equal(await r.isQuarantined('s','d'),true);await assert.rejects(f.noteRejected('s','src','TOO_LARGE'),/FAULT/);assert.equal(await r.noteRejected('s','src','TOO_LARGE'),true);assert.equal(await r.noteRejected('s','src','TOO_LARGE'),false);db.close()});

test('quarantine intake is bounded, idempotent and rolls back every write',async()=>{const db=new DatabaseSync(':memory:'),run=runner(db),r=new CompromiseReviews(run),input={scopeId:'s',sourceId:'peer',objectId:'one',bytes:new Uint8Array([1,2])};for(let target=1;target<=3;target++){let writes=0;const f=new CompromiseReviews(run,()=>{if(++writes===target)throw Error('FAULT')});await assert.rejects(f.stageEvidence(input),/FAULT/);assert.equal((await run(false,tx=>tx.keys())).length,0)}assert.deepEqual(await r.stageEvidence(input),{accepted:true,replayed:false});assert.deepEqual(await r.stageEvidence(input),{accepted:true,replayed:true});await assert.rejects(r.stageEvidence({...input,bytes:new Uint8Array([3])}),/CONFLICT/);assert.deepEqual(await r.stageEvidence({...input,objectId:'too-big',bytes:new Uint8Array(1048577)}),{accepted:false,reason:'TOO_LARGE'});assert.equal((await run(false,tx=>tx.keys())).length,3);db.close()});

test('local collection stops at its evidence budget without reading the remaining originals',async()=>{
 const keys=['a','b','c'].map(id=>JSON.stringify(['object','s',id]));
 let reads=0;
 const review=new CompromiseReviews(async(_write,use)=>use({
  keys:async()=>keys,
  get:async()=>({bytes:new Uint8Array(++reads===1?6:1048576)})
 }));
 const captured=await review.reviewCandidates('s');
 assert.equal(reads,2);
 assert.deepEqual(captured,{objects:[{sourceId:'outbound',objectId:'a',bytes:new Uint8Array(6)}],truncated:true});
});
