import {open} from '@op-engineering/op-sqlite';
import {LocalKeys} from './compat-domain/local-keys.ts';
import {nativeMaster} from './native-master';
import {sodium} from './native-sodium';
const encode=v=>JSON.stringify(v,(_k,x)=>x instanceof Uint8Array?{__storageBytes:Array.from(x)}:x);
const decode=s=>JSON.parse(s,(_k,x)=>x&&Array.isArray(x.__storageBytes)?Uint8Array.from(x.__storageBytes):x);
const identity={version:1,scope:{kind:'personal',id:'fixture'},deviceId:'fixture-device',purpose:'data',epochId:'fixture-epoch'};
export async function localKeysProbe(){
 const db=open({name:'local-keys-proof.sqlite'});db.executeSync('CREATE TABLE IF NOT EXISTS loro_records (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)');
 let pending=Promise.resolve(),failReady=false;
 const run=(write,body)=>{const execute=async()=>{db.executeSync(write?'BEGIN IMMEDIATE':'BEGIN');try{const r=await body({keys:async()=>db.executeSync('SELECT key FROM loro_records').rows.map(x=>x.key),get:async k=>{const row=db.executeSync('SELECT value FROM loro_records WHERE key=?',[k]).rows[0];return row?decode(row.value):undefined},put:async(k,v)=>{if(failReady&&v?.state==='ready'){failReady=false;throw Error('injected ready fault')}db.executeSync('INSERT OR REPLACE INTO loro_records VALUES (?,?)',[k,encode(v)])}});db.executeSync('COMMIT');return r}catch(e){db.executeSync('ROLLBACK');throw e}};const next=pending.then(execute);pending=next.then(()=>{},()=>{});return next};
 try {
  const keys=new LocalKeys(run,nativeMaster,sodium);const existing=db.executeSync('SELECT key FROM loro_records').rows.length>0;
  if(!existing){failReady=true;let rejected=false;try{await keys.provision('local-keys-master')}catch{rejected=true}if(!rejected)throw Error('fault not injected');
   await Promise.all([keys.provision('local-keys-master'),keys.provision('local-keys-master')]);
   await keys.generate('data-operation',identity);
  } else await keys.unlock();
  const replay=await keys.generate('data-operation',identity);if(!replay.replayed)throw Error('key replay');
  await keys.useIdentity(identity,secret=>{if(secret.length!==32)throw Error('bad data key');const raw=db.executeSync('SELECT value FROM loro_records').rows.map(x=>x.value).join('');if(raw.includes(JSON.stringify(Array.from(secret))))throw Error('plaintext secret persisted')});
  return existing?'PASS local keys unlocked after process restart':'PASS interrupted provisioning recovered, concurrent provisioning and wrapped key replay';
 } finally {db.close()}
}
