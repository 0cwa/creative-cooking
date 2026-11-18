/** Candidate only; persistent master and records are independent transaction domains. */
import type {TransactionRunner} from './core.ts';
export type LocalKeyIdentity={version:1;scope:{kind:'personal'|'household';id:string};deviceId:string;purpose:'device-signing'|'device-wrapping'|'data'|'recovery';epochId:string};
export type LocalKeyRecord={version:1;operationId:string;identity:LocalKeyIdentity;masterId:string;publicKey:Uint8Array|null;wrapped:Uint8Array};
export type ReadyMasterCatalog={version:1;state:'ready';id:string;check:Uint8Array};
type Tx={get(k:string):Promise<any>;put(k:string,v:any):Promise<void>;keys():Promise<string[]>};
type Master={provision(id:string):Promise<void>;ensure?(id:string):Promise<void>;wrap(id:string,p:Uint8Array,a:Uint8Array):Promise<Uint8Array>;unwrap(id:string,p:Uint8Array,a:Uint8Array):Promise<Uint8Array>};
const e=new TextEncoder(), key=(...x:string[])=>JSON.stringify(x), ck=key('local-master-catalog');
const sentinel=e.encode('creative-cooking/local-master-check/v1');
// Only known unrelated record namespaces may predate master provisioning.
const unrelated=new Set(['disclosure-pending','disclosure-active','policy-disclosure-head','policy-checkout-parent','disclosure-policy','disclosure-policy-archive','household-sealed-file','disclosure-source','disclosure-review','pairing-authority','pairing-release','pairing-guard','pairing-packet','pairing-outbox','document','document-owner','object','inbox','local','import','group','receipt-state','cursor','command','effect','applied','receipt','compromise-review','compromise-frozen-original','compromise-quarantine','compromise-notification','continuity-head','continuity-binding','compromise-intake','compromise-intake-item','projection-policy-seed','projection-seed','projection-seed-command','projection-seed-effect','recovery-readmission-challenge','recovery-challenge-consumed','recovery-install','recovery-device','recovery-reminder','recovery-generation','recovery-generation-head','recovery-generation-operation','recovery-custody-ack']);
function unrelatedRecordKey(k:string){try{const p=JSON.parse(k);return Array.isArray(p)&&p.length>0&&p.every((x:any)=>typeof x==='string')&&unrelated.has(p[0])}catch{return false}}
const shape=(x:any,n:string[])=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&!(x instanceof Uint8Array)&&Object.keys(x).length===n.length&&n.every(k=>Object.hasOwn(x,k));
const id=(x:any)=>typeof x==='string'&&x.length>0&&e.encode(x).length<=256;
const bytes=(x:any,min:number,max:number)=>x instanceof Uint8Array&&x.length>=min&&x.length<=max;
const eq=(a:any,b:any):boolean=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const canon=(x:any):any=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const same=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const copy=<T>(x:T):T=>structuredClone(x);
export function validLocalIdentity(x:any):x is LocalKeyIdentity{return shape(x,['version','scope','deviceId','purpose','epochId'])&&x.version===1&&shape(x.scope,['kind','id'])&&['personal','household'].includes(x.scope.kind)&&id(x.scope.id)&&id(x.deviceId)&&id(x.epochId)&&['device-signing','device-wrapping','data','recovery'].includes(x.purpose)}
export function validMasterCatalog(x:any):x is ReadyMasterCatalog{return shape(x,['version','state','id','check'])&&x.version===1&&x.state==='ready'&&id(x.id)&&bytes(x.check,29,1024)}
export function validLocalRecord(x:any):x is LocalKeyRecord{return shape(x,['version','operationId','identity','masterId','publicKey','wrapped'])&&x.version===1&&id(x.operationId)&&validLocalIdentity(x.identity)&&id(x.masterId)&&bytes(x.wrapped,29,1024)&&(['device-signing','device-wrapping'].includes(x.identity.purpose)?bytes(x.publicKey,32,32):x.publicKey===null)}
export const localKeySlot=(i:LocalKeyIdentity)=>key('local-key',i.scope.kind,i.scope.id,i.deviceId,i.purpose,i.epochId);
export const localKeyOperation=(op:string)=>key('local-key-operation',op);
const context=(i:LocalKeyIdentity)=>e.encode(JSON.stringify(['creative-cooking/local-key/v1',i.scope.kind,i.scope.id,i.deviceId,i.purpose,i.epochId]));
const masterContext=(id:string)=>e.encode(JSON.stringify(['creative-cooking/local-master/v1',id]));
/** Reads both independently stored copies; a partial record is never treated as absent. */
export async function findLocalKey(tx:Tx,operationId:string,identity:LocalKeyIdentity):Promise<LocalKeyRecord|null>{if(!id(operationId)||!validLocalIdentity(identity))throw Error('MALFORMED');const slot=await tx.get(localKeySlot(identity)),op=await tx.get(localKeyOperation(operationId));if(slot===undefined&&op===undefined)return null;if(!validLocalRecord(slot)||!validLocalRecord(op))throw Error('LOCKED');if(!same(slot,op)||slot.operationId!==operationId||!same(slot.identity,identity))throw Error('CONFLICT');return copy(slot)}
/** Call only after checking the catalog sentinel with the independent master. */
export async function installLocalKey(tx:Tx,record:LocalKeyRecord,catalog:ReadyMasterCatalog):Promise<{record:LocalKeyRecord;replayed:boolean}>{if(!validLocalRecord(record)||!validMasterCatalog(catalog)||record.masterId!==catalog.id)throw Error('MALFORMED');const now=await tx.get(ck);if(!validMasterCatalog(now)||!same(now,catalog))throw Error('LOCKED');const old=await findLocalKey(tx,record.operationId,record.identity);if(old){if(!same(old,record))throw Error('CONFLICT');return {record:old,replayed:true}}await tx.put(localKeySlot(record.identity),copy(record));await tx.put(localKeyOperation(record.operationId),copy(record));return {record:copy(record),replayed:false}}
export class LocalKeys {
 private run:TransactionRunner; private master:Master; private sodium:any; private afterCommit?:()=>void;
 constructor(run:TransactionRunner,master:Master,sodium:any,afterCommit?:()=>void){this.run=run;this.master=master;this.sodium=sodium;this.afterCommit=afterCommit;}
 async provision(masterId:string){
  if(!id(masterId))throw Error('MALFORMED');
  const reserved=(x:any)=>shape(x,['version','state','id'])&&x.version===1&&x.state==='reserved'&&x.id===masterId;
  const state=await this.run(true,async tx=>{
   const old=await tx.get(ck);
   if(validMasterCatalog(old)&&old.id===masterId)return 'ready';
   if(old!==undefined&&!reserved(old))throw Error('LOCKED');
   if(!(await tx.keys()).every(k=>k===ck||unrelatedRecordKey(k)))throw Error('LOCKED');
   if(old!==undefined)return 'reserved';
   await tx.put(ck,{version:1,state:'reserved',id:masterId});return 'new';
  });
  if(state==='ready'){await this.unlock();return;}
  // Resuming requires a provider operation that preserves an existing master.
  if(this.master.ensure)await this.master.ensure(masterId);
  else if(state==='new')await this.master.provision(masterId);
  else throw Error('LOCKED');
  const check=await this.master.wrap(masterId,sentinel,masterContext(masterId));
  if(!eq(await this.master.unwrap(masterId,check,masterContext(masterId)),sentinel))throw Error('LOCKED');
  await this.run(true,async tx=>{
   const old=await tx.get(ck);
   if(validMasterCatalog(old)&&old.id===masterId)return;
   if(!reserved(old))throw Error('LOCKED');
   await tx.put(ck,{version:1,state:'ready',id:masterId,check});
  });
  await this.unlock();
 }
 async unlock():Promise<ReadyMasterCatalog>{const c=await this.run(false,tx=>tx.get(ck));if(!validMasterCatalog(c))throw Error('LOCKED');try{if(!eq(await this.master.unwrap(c.id,c.check,masterContext(c.id)),sentinel))throw Error();}catch{throw Error('LOCKED')}return copy(c)}
 private async verify(r:LocalKeyRecord,c:ReadyMasterCatalog){if(!validLocalRecord(r)||r.masterId!==c.id)throw Error('LOCKED');let secret:Uint8Array|undefined;try{secret=await this.master.unwrap(c.id,r.wrapped,context(r.identity));const p=r.identity.purpose;if(p==='device-signing'){if(secret.length!==64)throw Error();const pair=this.sodium.crypto_sign_seed_keypair(secret.slice(0,32));const ok=eq(pair.publicKey,r.publicKey)&&eq(pair.privateKey,secret);pair.privateKey.fill(0);if(!ok)throw Error()}else if(p==='device-wrapping'){if(secret.length!==32||!eq(this.sodium.crypto_scalarmult_base(secret),r.publicKey))throw Error()}else if(secret.length!==32||r.publicKey!==null)throw Error()}catch{throw Error('LOCKED')}finally{secret?.fill(0)}}
 async generate(operationId:string,identity:LocalKeyIdentity){if(!id(operationId)||!validLocalIdentity(identity))throw Error('MALFORMED');identity=copy(identity);const c=await this.unlock();const old=await this.run(false,tx=>findLocalKey(tx,operationId,identity));if(old){await this.verify(old,c);return {publicKey:copy(old.publicKey),replayed:true}}let secret:Uint8Array,publicKey:Uint8Array|null=null;const p=identity.purpose;if(p==='device-signing'||p==='device-wrapping'){const pair=p==='device-signing'?this.sodium.crypto_sign_keypair():this.sodium.crypto_box_keypair();secret=pair.privateKey;publicKey=pair.publicKey}else secret=this.sodium.randombytes_buf(32);try{const wrapped=await this.master.wrap(c.id,secret,context(identity));const record:LocalKeyRecord={version:1,operationId,identity,masterId:c.id,publicKey,wrapped};const result=await this.run(true,async tx=>{const prior=await findLocalKey(tx,operationId,identity);if(prior)return {record:prior,replayed:true};return installLocalKey(tx,record,c)});this.afterCommit?.();await this.verify(result.record,c);return {publicKey:copy(result.record.publicKey),replayed:result.replayed}}finally{secret.fill(0)}}
 /** Prepare a recovered personal data key for atomic installation; caller must authenticate the recovery package and commit all records together. */
 async prepareRecoveredDataKey(operationId:string,identity:LocalKeyIdentity,secret:Uint8Array):Promise<{record:LocalKeyRecord;catalog:ReadyMasterCatalog}>{
  if(!id(operationId)||!validLocalIdentity(identity)||identity.scope.kind!=='personal'||identity.purpose!=='data'||!bytes(secret,32,32))throw Error('MALFORMED');
  identity=copy(identity);const material=new Uint8Array(secret);try{const catalog=await this.unlock();if(await this.run(false,tx=>findLocalKey(tx,operationId,identity)))throw Error('CONFLICT');const wrapped=await this.master.wrap(catalog.id,material,context(identity));const record:LocalKeyRecord={version:1,operationId,identity,masterId:catalog.id,publicKey:null,wrapped};if(!validLocalRecord(record))throw Error('LOCKED');return {record:copy(record),catalog:copy(catalog)}}finally{material.fill(0)}
 }
 /** Prepare an authenticated pairing key; caller must atomically bind verified admission. */
 async preparePairedDataKey(operationId:string,identity:LocalKeyIdentity,secret:Uint8Array):Promise<{record:LocalKeyRecord;catalog:ReadyMasterCatalog}>{
  if(!id(operationId)||!validLocalIdentity(identity)||identity.purpose!=='data'||!bytes(secret,32,32))throw Error('MALFORMED');
  identity=copy(identity);const material=new Uint8Array(secret);try{
   const catalog=await this.unlock(),old=await this.run(false,tx=>findLocalKey(tx,operationId,identity));
   if(old){await this.verify(old,catalog);await this.use(operationId,identity,key=>{if(!eq(key,material))throw Error('CONFLICT')});return {record:old,catalog};}
   const wrapped=await this.master.wrap(catalog.id,material,context(identity));return {record:{version:1,operationId,identity,masterId:catalog.id,publicKey:null,wrapped},catalog};
  }finally{material.fill(0)}
 }
 /** Trusted internal preparation: caller must withhold packet outputs until its atomic publication commits. */
 async prepareForAtomicInstall<T>(operationId:string,identity:LocalKeyIdentity,makePackets:(secret:Uint8Array)=>Promise<T>|T):Promise<{record:LocalKeyRecord;catalog:ReadyMasterCatalog;packets:T}>{if(!id(operationId)||!validLocalIdentity(identity)||!['data','recovery'].includes(identity.purpose)||typeof makePackets!=='function')throw Error('MALFORMED');identity=copy(identity);const catalog=await this.unlock();if(await this.run(false,tx=>findLocalKey(tx,operationId,identity)))throw Error('CONFLICT');const secret:Uint8Array=this.sodium.randombytes_buf(32);try{const wrapped=await this.master.wrap(catalog.id,secret,context(identity));const record:LocalKeyRecord={version:1,operationId,identity,masterId:catalog.id,publicKey:null,wrapped};const packets=await makePackets(secret);return {record:copy(record),catalog:copy(catalog),packets}}finally{secret.fill(0)}}
 /** Resolve only an exact durable identity and verify both catalog indexes before use. */
 async useIdentity<T>(identity:LocalKeyIdentity,fn:(secret:Uint8Array)=>Promise<T>|T):Promise<T>{
  if(!validLocalIdentity(identity))throw Error('MALFORMED');
  identity=copy(identity);const record=await this.run(false,tx=>tx.get(localKeySlot(identity)));
  if(record===undefined)throw Error('NOT_FOUND');
  if(!validLocalRecord(record)||!same(record.identity,identity))throw Error('LOCKED');
  return this.use(record.operationId,identity,fn);
 }
 async use<T>(operationId:string,identity:LocalKeyIdentity,fn:(secret:Uint8Array)=>Promise<T>|T):Promise<T>{if(!id(operationId)||!validLocalIdentity(identity))throw Error('MALFORMED');identity=copy(identity);const c=await this.unlock(),record=await this.run(false,tx=>findLocalKey(tx,operationId,identity));if(!record)throw Error('NOT_FOUND');await this.verify(record,c);let secret:Uint8Array;try{secret=await this.master.unwrap(c.id,record.wrapped,context(identity))}catch{throw Error('LOCKED')}try{return await fn(secret)}finally{secret.fill(0)}}
}
