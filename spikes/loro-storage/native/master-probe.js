import {open} from '@op-engineering/op-sqlite';
import {nativeMaster as master} from './native-master';
const encode=s=>new TextEncoder().encode(s);
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
async function reject(f){let failed=false;try{await f()}catch{failed=true}if(!failed)throw Error('master accepted invalid input');}
export async function masterProbe(){
 const id='fixture-master-v1',aad=encode('fixture/master/v1'), plain=encode('public test payload');
 const db=open({name:'master-proof.sqlite'});
 try{
  db.executeSync('CREATE TABLE IF NOT EXISTS proof (id INTEGER PRIMARY KEY, wrapped BLOB NOT NULL)');
  const rows=db.executeSync('SELECT wrapped FROM proof WHERE id=1').rows;
  if(rows.length){const saved=new Uint8Array(rows[0].wrapped);if(!equal(await master.unwrap(id,saved,aad),plain))throw Error('master reopen');const info=await master.describe(id);if(!info.encodedNull||info.keySize!==256)throw Error('master key properties');return 'PASS master restored without provisioning '+JSON.stringify(info);}
  await reject(()=>master.unwrap('missing-fixture-master',new Uint8Array(28),aad));
  await Promise.all(Array.from({length:8},()=>master.ensure(id)));
  const info=await master.describe(id);if(!info.encodedNull||info.keySize!==256)throw Error('master key properties');
  await reject(()=>master.provision(id));
  const values=await Promise.all(Array.from({length:8},()=>master.wrap(id,plain,aad)));
  if(new Set(values.map(x=>Array.from(x).join(','))).size!==8)throw Error('nonce reuse');
  for(const value of values) if(!equal(await master.unwrap(id,value,aad),plain))throw Error('concurrent key mismatch');
  const tamper=values[0].slice();tamper[tamper.length-1]^=1;
  await reject(()=>master.unwrap(id,tamper,aad));await reject(()=>master.unwrap(id,values[0],encode('wrong-domain')));
  db.executeSync('INSERT INTO proof VALUES (?,?)',[1,values[0]]);
  return 'PASS master concurrent ensure, nonce uniqueness, wrong context and tamper rejection '+JSON.stringify(info);
 } finally {db.close();}
}
