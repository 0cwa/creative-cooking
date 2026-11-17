// Experimental transaction seam, not an authorization verifier. Must only be
// invoked by a verifier that has authenticated the whole admission and packet.
import {findLocalKey,installLocalKey,validLocalRecord,validMasterCatalog} from './local-keys.ts';
import type {LocalKeyRecord,ReadyMasterCatalog} from './local-keys.ts';
type Tx={get(k:string):Promise<any>;put(k:string,v:any):Promise<void>;keys():Promise<string[]>};
type Runner=<T>(write:boolean,fn:(tx:Tx)=>Promise<T>)=>Promise<T>;
type RecordInput={version:1;operationId:string;scopeId:string;guardId:string;documentId:string;generation:number;expectedAuthority:any;nextAuthority:any;manifest:{id:string;bytes:Uint8Array};seed:{seedId:string;identities:{effectId:string;commandId:string}[]};policySeed:{bundle:any;bundleHash:string}|null;snapshot:Uint8Array;packet:Uint8Array;receiptBody:any;receipt:Uint8Array;localKey:{record:LocalKeyRecord;catalog:ReadyMasterCatalog}};
const k=(...x:string[])=>JSON.stringify(x),id=(x:any)=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=256;
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Uint8Array);
const dense=(v:any)=>Array.isArray(v)&&Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean);
const exact=(v:any,n:string[])=>object(v)&&Object.keys(v).length===n.length&&n.every(x=>Object.hasOwn(v,x));
const canon=(x:any):any=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canon):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const equal=(a:any,b:any)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const fail=(s:string):never=>{throw Error(s)};
function valid(x:any):x is RecordInput {
 if(!exact(x,['version','operationId','scopeId','guardId','documentId','generation','expectedAuthority','nextAuthority','manifest','seed','policySeed','snapshot','packet','receiptBody','receipt','localKey'])||x.version!==1||![x.operationId,x.scopeId,x.guardId,x.documentId].every(id)||!Number.isSafeInteger(x.generation)||x.generation<1||!exact(x.manifest,['id','bytes'])||!id(x.manifest.id)||!(x.manifest.bytes instanceof Uint8Array)||!x.manifest.bytes.length||!(x.snapshot instanceof Uint8Array)||!x.snapshot.length||x.snapshot.length>1048576||!(x.packet instanceof Uint8Array)||!x.packet.length||x.packet.length>16384||!object(x.receiptBody)||!(x.receipt instanceof Uint8Array)||x.receipt.length!==64||!exact(x.seed,['seedId','identities'])||!id(x.seed.seedId)||!dense(x.seed.identities)||x.seed.identities.length>256||!x.seed.identities.every((v:any)=>exact(v,['effectId','commandId'])&&id(v.effectId)&&id(v.commandId))||new Set(x.seed.identities.map((v:any)=>v.effectId)).size!==x.seed.identities.length||new Set(x.seed.identities.map((v:any)=>v.commandId)).size!==x.seed.identities.length||(x.policySeed!==null&&(!exact(x.policySeed,['bundle','bundleHash'])||!object(x.policySeed.bundle)||!id(x.policySeed.bundleHash)||!dense(x.policySeed.bundle.policies)))||!exact(x.localKey,['record','catalog'])||!validLocalRecord(x.localKey.record)||!validMasterCatalog(x.localKey.catalog))return false;
 const r=x.localKey.record,i=r.identity,a=x.expectedAuthority,n=x.nextAuthority;
 return i.scope.kind==='household'&&i.scope.id===x.scopeId&&i.purpose==='data'&&r.masterId===x.localKey.catalog.id&&object(a)&&object(n)&&equal(a.scope,{kind:'household',id:x.scopeId})&&equal(n.scope,a.scope)&&Number.isSafeInteger(a.revision)&&a.revision>=0&&n.revision===a.revision+1&&id(a.acceptedParent)&&id(n.acceptedParent)&&id(a.authorizationSnapshot)&&id(n.authorizationSnapshot)&&a.authorityState instanceof Uint8Array&&n.authorityState instanceof Uint8Array&&(x.policySeed===null||(x.policySeed.bundle.seedId===x.seed.seedId&&x.policySeed.bundle.scopeId===x.scopeId&&x.policySeed.bundle.policies.every((p:any)=>exact(p,['policy','policyHash','approvals'])&&id(p.policyHash)&&object(p.policy)&&Array.isArray(p.approvals))&&new Set(x.policySeed.bundle.policies.map((p:any)=>p.policyHash)).size===x.policySeed.bundle.policies.length));
}
/** Internal storage seam. All input is snapshotted before entering the runner. */
export class HouseholdRecipientTransaction {
 private run:Runner; private fault?: (boundary:string)=>void;
 constructor(run:Runner,fault?:(boundary:string)=>void){this.run=run;this.fault=fault}
 async find(scopeId:string,operationId:string){
  if(!id(scopeId)||!id(operationId))return {ok:false as const,error:'MALFORMED'};
  try{return await this.run(false,async tx=>{const p=await tx.get(k('recipient-admission',scopeId,operationId));if(p===undefined)return {ok:true as const,value:null};if(!exact(p,['fingerprint','input'])||!valid(p.input)||p.input.scopeId!==scopeId||p.input.operationId!==operationId||p.fingerprint!==JSON.stringify(canon(p.input)))fail('CORRUPT');return {ok:true as const,value:structuredClone(p.input)}})}catch(e){return {ok:false as const,error:e instanceof Error&&e.message==='CORRUPT'?'CORRUPT':'IO'}}
 }
 async findByEvent(scopeId:string,eventHash:string){
  if(!id(scopeId)||!id(eventHash))return {ok:false as const,error:'MALFORMED'};
  try{const op=await this.run(false,tx=>tx.get(k('recipient-admission-event',scopeId,eventHash)));if(op===undefined)return {ok:true as const,value:null};if(!id(op))return {ok:false as const,error:'CORRUPT'};const result=await this.find(scopeId,op);if(!result.ok||!result.value||result.value.nextAuthority.acceptedParent!==eventHash)return {ok:false as const,error:'CORRUPT'};return result}catch{return {ok:false as const,error:'IO'}}
 }
 async check(input:RecordInput){
  if(!valid(input))return {ok:false as const,error:'MALFORMED'};const p=structuredClone(input),fp=JSON.stringify(canon(p)),scope=p.scopeId,op=k('recipient-admission',scope,p.operationId);
  try{return await this.run(false,async tx=>{const saved=await tx.get(op);if(!exact(saved,['fingerprint','input'])||saved.fingerprint!==fp||!equal(saved.input,p))fail('CORRUPT');const now=await tx.get(k('pairing-authority','household',scope)),d=await tx.get(k('document',scope,p.documentId));if(!now||!equal(now.scope,p.nextAuthority.scope)||!Number.isSafeInteger(now.revision)||now.revision<p.nextAuthority.revision||(now.revision===p.nextAuthority.revision&&!equal(now,p.nextAuthority))||!d||!Number.isSafeInteger(d.revision)||d.revision<0||!(d.bytes instanceof Uint8Array)||(d.revision===0&&!equal(d.bytes,p.snapshot))||!equal(await tx.get(k('document-owner',scope,p.documentId)),p.nextAuthority.acceptedParent)||!equal(await tx.get(k('projection-document',scope,p.documentId)),{generation:p.generation,operationId:p.operationId})||!equal(await tx.get(k('projection-seed',scope,p.documentId)),p.seed)||(p.policySeed===null?await tx.get(k('projection-policy-seed',scope,p.documentId))!==undefined:!equal(await tx.get(k('projection-policy-seed',scope,p.documentId)),p.policySeed))||!equal(await tx.get(k('projection-manifest',scope,p.manifest.id)),p.manifest.bytes)||await tx.get(k('pairing-guard',p.guardId))!==op||await tx.get(k('recipient-admission-event',scope,p.nextAuthority.acceptedParent))!==p.operationId||!equal(await tx.get(k('local-master-catalog')),p.localKey.catalog))fail('CORRUPT');for(const x of p.seed.identities)if(await tx.get(k('projection-seed-command',scope,p.documentId,x.commandId))!==p.seed.seedId||await tx.get(k('projection-seed-effect',scope,p.documentId,x.effectId))!==p.seed.seedId)fail('CORRUPT');for(const a of p.policySeed?.bundle.policies??[])if(!equal(await tx.get(k('disclosure-policy-archive',scope,a.policyHash)),a))fail('CORRUPT');let local;try{local=await findLocalKey(tx,p.localKey.record.operationId,p.localKey.record.identity)}catch{fail('CORRUPT')}if(!equal(local,p.localKey.record))fail('CORRUPT');return {ok:true as const,value:true}})}catch(e){return {ok:false as const,error:e instanceof Error&&e.message==='CORRUPT'?'CORRUPT':'IO'}}
 }
 async install(input:RecordInput){
  if(!valid(input))return {ok:false as const,error:'MALFORMED'};const p=structuredClone(input),fp=JSON.stringify(canon(p)),scope=p.scopeId,op=k('recipient-admission',scope,p.operationId),guard=k('pairing-guard',p.guardId),doc=k('document',scope,p.documentId),owner=k('document-owner',scope,p.documentId),meta=k('projection-document',scope,p.documentId),seed=k('projection-seed',scope,p.documentId),sidecar=k('projection-policy-seed',scope,p.documentId),manifest=k('projection-manifest',scope,p.manifest.id),authority=k('pairing-authority','household',scope);
  const eventIndex=k('recipient-admission-event',scope,p.nextAuthority.acceptedParent);
  const reservations=p.seed.identities.flatMap(i=>[[k('projection-seed-command',scope,p.documentId,i.commandId),p.seed.seedId],[k('projection-seed-effect',scope,p.documentId,i.effectId),p.seed.seedId]] as [string,string][]),policies=(p.policySeed?.bundle.policies??[]).map((a:any)=>[k('disclosure-policy-archive',scope,a.policyHash),a] as [string,any]);
  const write=async(tx:Tx,key:string,value:any)=>{await tx.put(key,value);this.fault?.('write')};
  try{return await this.run(true,async tx=>{
   const prior=await tx.get(op);
   if(prior!==undefined){
    if(!exact(prior,['fingerprint','input'])||typeof prior.fingerprint!=='string'||!valid(prior.input)||prior.fingerprint!==JSON.stringify(canon(prior.input)))fail('CORRUPT');
    if(prior.fingerprint!==fp)fail('CONFLICT');
    const now=await tx.get(authority),d=await tx.get(doc);
    if(!equal(now,p.nextAuthority)||!d||!Number.isSafeInteger(d.revision)||d.revision<0||!(d.bytes instanceof Uint8Array)||(d.revision===0&&!equal(d.bytes,p.snapshot))||!equal(await tx.get(owner),p.nextAuthority.acceptedParent)||!equal(await tx.get(meta),{generation:p.generation,operationId:p.operationId})||!equal(await tx.get(seed),p.seed)||(p.policySeed===null?await tx.get(sidecar)!==undefined:!equal(await tx.get(sidecar),p.policySeed))||!equal(await tx.get(manifest),p.manifest.bytes)||await tx.get(guard)!==op||await tx.get(eventIndex)!==p.operationId||!equal(await tx.get(k('local-master-catalog')),p.localKey.catalog))fail('CORRUPT');
    for(const [slot,value] of [...reservations,...policies])if(!equal(await tx.get(slot),value))fail('CORRUPT');
    let existing;try{existing=await findLocalKey(tx,p.localKey.record.operationId,p.localKey.record.identity)}catch{fail('CORRUPT')}if(!equal(existing,p.localKey.record))fail('CORRUPT');return {ok:true as const,value:{replayed:true,receipt:p.receipt}};
   }
   if(!equal(await tx.get(authority),p.expectedAuthority))fail('CONFLICT');
   for(const slot of [guard,doc,owner,meta,seed,sidecar,manifest,eventIndex,...reservations.map(x=>x[0])])if(await tx.get(slot)!==undefined)fail('CONFLICT');
   for(const [slot,value] of policies){const old=await tx.get(slot);if(old!==undefined&&!equal(old,value))fail('CONFLICT')}
   const installed=await installLocalKey({get:tx.get,keys:async()=>[],put:async(slot,value)=>write(tx,slot,value)},p.localKey.record,p.localKey.catalog);if(installed.replayed)fail('CONFLICT');
   await write(tx,manifest,p.manifest.bytes);await write(tx,seed,p.seed);if(p.policySeed!==null)await write(tx,sidecar,p.policySeed);for(const [slot,value] of reservations)await write(tx,slot,value);for(const [slot,value] of policies)if(await tx.get(slot)===undefined)await write(tx,slot,value);
   await write(tx,owner,p.nextAuthority.acceptedParent);await write(tx,doc,{bytes:p.snapshot,revision:0});await write(tx,meta,{generation:p.generation,operationId:p.operationId});await write(tx,guard,op);await write(tx,eventIndex,p.operationId);await write(tx,authority,p.nextAuthority);await write(tx,op,{fingerprint:fp,input:p});return {ok:true as const,value:{replayed:false,receipt:p.receipt}};
  })}catch(e){const code=e instanceof Error&&['MALFORMED','CONFLICT','CORRUPT','LOCKED'].includes(e.message)?e.message:'IO';return {ok:false as const,error:code}}
 }
}
