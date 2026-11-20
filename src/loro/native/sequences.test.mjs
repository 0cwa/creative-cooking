import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {openNativeSequences} from './sequences.mjs';
const conn=()=>{const db=new DatabaseSync(':memory:');return {db,executeSync:(q,p=[])=>{const s=db.prepare(q);return {rows:q.startsWith('SELECT')?s.all(...p):(s.run(...p),[])}}}};
test('sequence initialization, idempotent allocation, exhaustion and missing state',async()=>{const c=conn();assert.throws(()=>openNativeSequences(c,['a'],false),/MISSING_SEQUENCES/);const s=openNativeSequences(c,['a','b'],true);assert.deepEqual(await Promise.all([s.reserve('a','one'),s.reserve('a','two'),s.reserve('a','one'),s.reserve('b','one')]),[1,2,1,1]);assert.throws(()=>openNativeSequences(c,['a'],false),/MISSING_SEQUENCES/);c.db.prepare('UPDATE loro_sequence_counters SET value=? WHERE scope=?').run(Number.MAX_SAFE_INTEGER,'a');await assert.rejects(s.reserve('a','new'),/SEQUENCE_EXHAUSTED/);c.db.close()});
test('corrupt allocation fails before reserving',async()=>{const c=conn(),s=openNativeSequences(c,['a'],true);await s.reserve('a','one');c.db.exec('UPDATE loro_sequence_counters SET value=0');await assert.rejects(s.reserve('a','two'),/SEQUENCE_CORRUPT/);c.db.close()});

test('reservations use indexed scope reads after one complete open inspection',async()=>{
 const c=conn(),queries=[],tracked={executeSync(q,p){queries.push(q);return c.executeSync(q,p)}},s=openNativeSequences(tracked,['a','b'],true);
 try{assert.equal(queries.filter(q=>q==='SELECT scope, operation, value FROM loro_sequence_allocations').length,1);queries.length=0;
 for(let i=0;i<200;i++)assert.equal(await s.reserve('a',`operation-${i}`),i+1);
 assert.equal(await s.reserve('a','operation-0'),1);assert.equal(await s.reserve('b','operation-0'),1);
 assert.equal(queries.filter(q=>q==='SELECT scope, operation, value FROM loro_sequence_allocations').length,0);
 c.db.prepare('UPDATE loro_sequence_counters SET value=1 WHERE scope=?').run('a');const before=c.db.prepare('SELECT count(*) AS n FROM loro_sequence_allocations').get().n;
 await assert.rejects(s.reserve('a','next'),/SEQUENCE_CORRUPT/);assert.equal(c.db.prepare('SELECT count(*) AS n FROM loro_sequence_allocations').get().n,before);
 }finally{c.db.close()}
});
