import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {openSQLiteStorage} from '../../storage/sqlite.ts';
import {createGuardianPreparation} from './guardian-preparation.mjs';

test('invalid guardian input writes nothing and an undrafted old reservation can be corrected',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const storage=openSQLiteStorage({executeSync(sql,params=[]){const statement=db.prepare(sql);return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])}}});
  const run=storage.recoveryTransaction,slot=JSON.stringify(['recovery-generation-operation','app-pending','owner']);
  let locks=0,calls=0;
  const prepare=createGuardianPreparation({run,owner:'owner',workspaceName:'test',locks:{async request(_name,_options,fn){locks++;return fn()}},async createGeneration(input){calls++;return input}});
  await assert.rejects(()=>prepare(['alice','bob'],3),/INVALID_INPUT/);
  await assert.rejects(()=>prepare(['alice','alice'],2),/INVALID_INPUT/);
  assert.equal(locks,0);assert.equal(calls,0);
  assert.equal(await run(false,tx=>tx.get(slot)),undefined);
  await run(true,tx=>tx.put(slot,{operationId:'old-operation',holders:['alice','bob'],threshold:3}));
  const corrected=await prepare(['alice','bob'],2);
  assert.deepEqual(corrected,{operationId:'old-operation',holders:['alice','bob'],threshold:2});
  assert.deepEqual(await run(false,tx=>tx.get(slot)),corrected);
 }finally{db.close()}
});
