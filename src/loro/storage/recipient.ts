import {installLocalKey,validLocalRecord,validMasterCatalog} from './local-keys.ts';
import { StorageFailure, validPersonalSelection } from './core.ts';
import type { PersonalSelection, TransactionRunner } from './core.ts';
import type { StorageError, Result } from '../contracts/index.ts';

import {isPolicyDocumentId} from '../authority/validator.mjs';
import { pairingReleaseKey, validatePairingAuthority } from '../contracts/pairing.ts';
import type { RecipientAcceptanceIdentity as RecipientIdentity, RecipientInstall as RecipientSaved } from '../contracts/pairing.ts';
const k=(...parts:string[])=>JSON.stringify(parts);
type PersonalCopyInstall = {
 documentId:string;
 revision:number|null;
 bytes:Uint8Array|null;
 fileHash:string;
 pin:string;
 identities:{commandId:string;effectId:string}[];
 selection:PersonalSelection|null;
 latest?:{documentId:string;bytes:Uint8Array;revision:number}|null;
};
const digest=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const obj=(x:any)=>x!==null && typeof x==='object' && !Array.isArray(x) && !(x instanceof Uint8Array);
const shape=(x:any,n:string[])=>obj(x) && Object.keys(x).length===n.length && n.every(a=>Object.hasOwn(x,a));
const id=(x:any)=>typeof x==='string' && x.length>0 && new TextEncoder().encode(x).length<=256;
const equalBytes=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const bytes=(x:any,max=1024*1024)=>x instanceof Uint8Array && x.length>0 && x.length<=max;
const validIdentity=(x:any):x is RecipientIdentity=>{
 if(!shape(x,['version','operationId','scope','guardId','direction','purpose','epochId','packetId','packetDigest','transcript','recipientDevice']) || x.version!==1 || !id(x.operationId) || !id(x.guardId) || !id(x.epochId) || !bytes(x.packetDigest,256) || !id(x.recipientDevice)) return false;
 const t=x.transcript,g={version:1,guardId:x.guardId,scope:x.scope,direction:x.direction,purpose:x.purpose};
 return !!t && x.scope?.kind===t.scope?.kind && x.scope?.id===t.scope?.id && x.purpose===t.purpose && x.recipientDevice===(x.direction==='initiator-to-responder'?t.responder?.deviceId:t.initiator?.deviceId) && pairingReleaseKey({version:1,operationId:x.operationId,transcript:t,guard:g,expectedAuthorityRevision:0,packet:{id:x.packetId,bytes:x.packetDigest},outbox:{destination:x.recipientDevice,objectId:x.packetId},outcome:{recipientDevice:x.recipientDevice,packetId:x.packetId}}).ok;
};
const validSaved=(x:any):x is RecipientSaved=>shape(x,['identity','keyRef','masterKeyId','wrappedLocalKey','acceptanceReceipt']) && validIdentity(x.identity) && id(x.keyRef) && id(x.masterKeyId) && bytes(x.wrappedLocalKey) && bytes(x.acceptanceReceipt);
const snap=<T>(x:T):T=>structuredClone(x);
// Ordered fields, not a wire encoding or authentication.
const canonical=(x:unknown):unknown=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canonical):obj(x)?Object.fromEntries(Object.keys(x as object).sort().map(k=>[k,canonical((x as any)[k])])):x;
const stable=(x:unknown)=>JSON.stringify(canonical(x));
const fail=(e:unknown):StorageError=>e instanceof StorageFailure?e.code:e instanceof Error && (e.name==='QuotaExceededError'||/SQLITE_FULL|database or disk is full/i.test(e.message))?'CAPACITY':'IO';
const bad=():never=>{throw new StorageFailure('CORRUPT')};
const conflict=():never=>{throw new StorageFailure('CONFLICT')};
const ids=(x:RecipientIdentity)=>({op:k('recipient-op',x.scope.kind,x.scope.id,x.operationId), guard:k('recipient-guard',x.guardId),packet:k('recipient-packet',x.scope.kind,x.scope.id,x.packetId),slot:k('recipient-key',x.scope.kind,x.scope.id,x.purpose,x.epochId), receipt:k('recipient-receipt',x.scope.kind,x.scope.id,x.operationId)});
export class RecipientRecords {
 private readonly run:TransactionRunner; private readonly fault?: (boundary:string)=>void;
 constructor(run:TransactionRunner, fault?:(boundary:string)=>void) {this.run=run;this.fault=fault;}
 private async complete(tx:any, x:RecipientIdentity, old:any) {
  if(!validSaved(old)) bad(); const i=ids(x); if(stable(old.identity)!==stable(x)) conflict();
  const slot=await tx.get(i.slot),receipt=await tx.get(i.receipt),guard=await tx.get(i.guard),packet=await tx.get(i.packet);
  if(!shape(slot,['keyRef','masterKeyId','wrappedLocalKey']) || !id(slot.keyRef) || !id(slot.masterKeyId) || !bytes(slot.wrappedLocalKey) || !bytes(receipt) || stable(slot)!==stable({keyRef:old.keyRef,masterKeyId:old.masterKeyId,wrappedLocalKey:old.wrappedLocalKey}) || stable(receipt)!==stable(old.acceptanceReceipt) || guard!==i.op || packet!==i.op) bad();
  return snap(old) as RecipientSaved;
 }
 /** Call only after the real verifier authenticates the complete identity. */
 async findRecipient(identity:RecipientIdentity):Promise<Result<{keyRef:string;acceptanceReceipt:Uint8Array}|null,StorageError>> { if(!validIdentity(identity)) return {ok:false,error:'MALFORMED'}; const x=snap(identity); try{return await this.run(false,async tx=>{const i=ids(x), old=await tx.get(i.op); if(old===undefined) {if(await tx.get(i.guard)!==undefined || await tx.get(i.packet)!==undefined) conflict();return {ok:true,value:null};} const v=await this.complete(tx,x,old);return {ok:true,value:{keyRef:v.keyRef,acceptanceReceipt:v.acceptanceReceipt}};});}catch(e){return {ok:false,error:fail(e)}} }
 async readWrapped(identity:RecipientIdentity,keyRef:string):Promise<Result<{masterKeyId:string;wrappedLocalKey:Uint8Array}|null,StorageError>> {if(!validIdentity(identity)||!id(keyRef))return {ok:false,error:'MALFORMED'};const x=snap(identity);try{return await this.run(false,async tx=>{const old=await tx.get(ids(x).op);if(old===undefined)return {ok:true,value:null};const v=await this.complete(tx,x,old);if(v.keyRef!==keyRef)conflict();return {ok:true,value:{masterKeyId:v.masterKeyId,wrappedLocalKey:v.wrappedLocalKey}};});}catch(e){return {ok:false,error:fail(e)}}}
 /** Caller checks a durable master and authenticates the receipt before entry. */
 async installAndReceipt(saved:RecipientSaved):Promise<Result<{keyRef:string;acceptanceReceipt:Uint8Array;replayed:boolean},StorageError>> { if(!validSaved(saved)) return {ok:false,error:'MALFORMED'}; const v=snap(saved), x=v.identity, i=ids(x); try{return await this.run(true,async tx=>{const old=await tx.get(i.op);if(old!==undefined){const prior=await this.complete(tx,x,old);if(stable(prior)!==stable(v)) conflict();return {ok:true,value:{keyRef:prior.keyRef,acceptanceReceipt:prior.acceptanceReceipt,replayed:true}};} for(const key of [i.guard,i.packet,i.slot,i.receipt]) if(await tx.get(key)!==undefined) conflict(); for(const [key,value] of [[i.slot,{keyRef:v.keyRef,masterKeyId:v.masterKeyId,wrappedLocalKey:v.wrappedLocalKey}],[i.receipt,v.acceptanceReceipt],[i.guard,i.op],[i.packet,i.op],[i.op,v]] as const){await tx.put(key,value);this.fault?.('write');}return {ok:true,value:{keyRef:v.keyRef,acceptanceReceipt:snap(v.acceptanceReceipt),replayed:false}};});}catch(e){return {ok:false,error:fail(e)}} }

 async findPersonalRecipient(identity:RecipientIdentity,expected:{scope:{kind:'personal';id:string};record:{revision:number;acceptedParent:string;authorizationSnapshot:string}}):Promise<Result<{keyRef:string;acceptanceReceipt:Uint8Array}|null,StorageError>> {
  if(!validIdentity(identity)||!expected||expected.scope.kind!=='personal'||identity.scope.kind!=='personal'||expected.scope.id!==identity.scope.id||!Number.isSafeInteger(expected.record?.revision)||expected.record.revision<0||!id(expected.record.acceptedParent)||!id(expected.record.authorizationSnapshot)||identity.transcript.acceptedParent!==expected.record.acceptedParent||identity.transcript.authorizationSnapshot!==expected.record.authorizationSnapshot)return {ok:false,error:'MALFORMED'};
  const x=snap(identity),a=snap(expected);try{return await this.run(false,async tx=>{const authority=await tx.get(k('pairing-authority','personal',a.scope.id));if(!authority||authority.revision!==a.record.revision||authority.acceptedParent!==a.record.acceptedParent||authority.authorizationSnapshot!==a.record.authorizationSnapshot)conflict();const i=ids(x),old=await tx.get(i.op);if(old===undefined){if(await tx.get(i.guard)!==undefined||await tx.get(i.packet)!==undefined)conflict();return {ok:true,value:null}}const v=await this.complete(tx,x,old);return {ok:true,value:{keyRef:v.keyRef,acceptanceReceipt:v.acceptanceReceipt}};});}catch(e){return {ok:false,error:fail(e)}}
 }
 /** Compare the pinned personal authority in the same transaction as receipt installation. */
 async installPersonalAndReceipt(saved:RecipientSaved, expected:{scope:{kind:'personal';id:string};record:{revision:number;acceptedParent:string;authorizationSnapshot:string}}):Promise<Result<{keyRef:string;acceptanceReceipt:Uint8Array;replayed:boolean},StorageError>> {
  if(!validSaved(saved)||!expected||expected.scope.kind!=='personal'||saved.identity.scope.kind!=='personal'||expected.scope.id!==saved.identity.scope.id||!Number.isSafeInteger(expected.record?.revision)||expected.record.revision<0||!id(expected.record.acceptedParent)||!id(expected.record.authorizationSnapshot)||saved.identity.transcript.acceptedParent!==expected.record.acceptedParent||saved.identity.transcript.authorizationSnapshot!==expected.record.authorizationSnapshot)return {ok:false,error:'MALFORMED'};
  const v=snap(saved),x=v.identity,i=ids(x),a=snap(expected);try{return await this.run(true,async tx=>{const authority=await tx.get(k('pairing-authority','personal',a.scope.id));if(!authority||authority.revision!==a.record.revision||authority.acceptedParent!==a.record.acceptedParent||authority.authorizationSnapshot!==a.record.authorizationSnapshot)conflict();const old=await tx.get(i.op);if(old!==undefined){const prior=await this.complete(tx,x,old);if(stable(prior)!==stable(v))conflict();return {ok:true,value:{keyRef:prior.keyRef,acceptanceReceipt:prior.acceptanceReceipt,replayed:true}};}for(const key of [i.guard,i.packet,i.slot,i.receipt])if(await tx.get(key)!==undefined)conflict();for(const [key,value] of [[i.slot,{keyRef:v.keyRef,masterKeyId:v.masterKeyId,wrappedLocalKey:v.wrappedLocalKey}],[i.receipt,v.acceptanceReceipt],[i.guard,i.op],[i.packet,i.op],[i.op,v]] as const){await tx.put(key,value);this.fault?.('write');}return {ok:true,value:{keyRef:v.keyRef,acceptanceReceipt:snap(v.acceptanceReceipt),replayed:false}};});}catch(e){return {ok:false,error:fail(e)}}
 }

 /** The verifier binds the optional personal copy before entry. A fresh copy
  * claims a previously absent scope and selects it with the key and receipt. */
 async installPersonalAdmissionAndReceipt(saved:RecipientSaved,expected:any,next:any,localKey:any,copy?:PersonalCopyInstall):Promise<Result<{keyRef:string;acceptanceReceipt:Uint8Array;replayed:boolean},StorageError>> {
  if(!validSaved(saved)||!localKey||!validLocalRecord(localKey.record)||!validMasterCatalog(localKey.catalog)||
   localKey.record.operationId!=='personal-pairing:'+saved.identity.packetId||localKey.record.masterId!==saved.masterKeyId||
   localKey.catalog.id!==saved.masterKeyId||localKey.record.identity.scope.kind!=='personal'||
   localKey.record.identity.scope.id!==saved.identity.scope.id||localKey.record.identity.deviceId!==saved.identity.recipientDevice||
   localKey.record.identity.purpose!=='data'||localKey.record.identity.epochId!==saved.identity.epochId||
   !validatePairingAuthority(expected).ok||!validatePairingAuthority(next).ok||
   expected.scope.kind!=='personal'||next.scope.kind!=='personal'||expected.scope.id!==saved.identity.scope.id||
   next.scope.id!==expected.scope.id||next.revision!==expected.revision+1||
   expected.acceptedParent!==saved.identity.transcript.acceptedParent||
   expected.authorizationSnapshot!==saved.identity.transcript.authorizationSnapshot||next.acceptedParent!==expected.acceptedParent)
   return {ok:false,error:'MALFORMED'};
  if(copy&&(!id(copy.documentId)||isPolicyDocumentId(copy.documentId)||!digest(copy.fileHash)||!digest(copy.pin)||
   !(copy.revision===null?copy.bytes===null:Number.isSafeInteger(copy.revision)&&copy.revision>=0&&bytes(copy.bytes,2_097_152))||
   (copy.selection!==null&&!validPersonalSelection(copy.selection))||
   !Array.isArray(copy.identities)||copy.identities.length>4096||
   (copy.bytes===null&&copy.identities.length!==0)||
   !Array.from(copy.identities).every(row=>shape(row,['commandId','effectId'])&&id(row.commandId)&&id(row.effectId))||
   new Set(copy.identities.map(row=>row.commandId)).size!==copy.identities.length||
   new Set(copy.identities.map(row=>row.effectId)).size!==copy.identities.length))return {ok:false,error:'MALFORMED'};
  const v=snap(saved),x=v.identity,i=ids(x),before=snap(expected),after=snap(next),local=snap(localKey),seed=snap(copy);
  try{return await this.run(true,async tx=>{
   const put=async(key:string,value:any)=>{await tx.put(key,value);this.fault?.('personal-admission-install')};
   const install=()=>installLocalKey({...tx,put},local.record,local.catalog);
   const scope=x.scope.id,authorityKey=k('pairing-authority','personal',scope);
   const authority=await tx.get(authorityKey),old=await tx.get(i.op);
   const selectionKey=k('personal-selection',x.recipientDevice),guardKey=k('pairing-guard',x.guardId);
   const copyKey=k('personal-pairing-copy',scope,x.operationId),copyRecord=await tx.get(copyKey);
   const docKey=k('document',scope,seed?.documentId??''),ownerKey=k('document-owner',scope,seed?.documentId??'');
   const indexes=seed?.identities.flatMap(({commandId,effectId})=>[
    k('projection-seed-command',scope,seed.documentId,commandId),k('projection-seed-effect',scope,seed.documentId,effectId)
   ])??[];
   const savedSelection={scopeId:scope,pin:seed?.pin};
   const applySelection=async()=>{
    const current=(await tx.get(selectionKey))??null;
    if(stable(current)===stable(savedSelection))return;
    if(stable(current)!==stable(seed!.selection))conflict();
    await put(selectionKey,savedSelection);
   };
   if(old!==undefined){
    if(stable(authority)!==stable(after))conflict();
    const prior=await this.complete(tx,x,old);
    if(stable(prior)!==stable(v)||!(seed?copyRecord===seed.fileHash:copyRecord===undefined))conflict();
    const installed=await install();
    if(!installed.replayed)bad();
    if(seed){
     if(await tx.get(guardKey)!==i.op)bad();
     const doc=await tx.get(docKey),owner=await tx.get(ownerKey);
     if(doc===undefined ? seed.revision!==null||owner!==undefined :
      !bytes(doc.bytes,Number.MAX_SAFE_INTEGER)||!Number.isSafeInteger(doc.revision)||doc.revision<0||
      owner!==after.acceptedParent||(seed.revision!==null&&(doc.revision<seed.revision||
       (doc.revision===seed.revision&&!equalBytes(doc.bytes,seed.bytes!)))))bad();
     if(seed.latest===undefined||(seed.latest===null?doc!==undefined:
       !doc||seed.latest.documentId!==seed.documentId||seed.latest.revision!==doc.revision||
       !(seed.latest.bytes instanceof Uint8Array)||!equalBytes(seed.latest.bytes,doc.bytes)))conflict();
     for(const index of indexes)if(await tx.get(index)!==x.operationId)bad();
     await applySelection();
    }
    return {ok:true,value:{keyRef:prior.keyRef,acceptanceReceipt:prior.acceptanceReceipt,replayed:true}};
   }
   if(seed?authority!==undefined||await tx.get(k('pairing-authority','household',scope))!==undefined:
    stable(authority)!==stable(before))conflict();
   if(copyRecord!==undefined)conflict();
   const installed=await install();
   if(installed.replayed)conflict();
   for(const slot of [i.guard,i.packet,i.slot,i.receipt])if(await tx.get(slot)!==undefined)conflict();
   if(seed){
    if(seed.latest!==undefined)conflict();
    for(const slot of [docKey,ownerKey,guardKey,...indexes])if(await tx.get(slot)!==undefined)conflict();
    for(const row of seed.identities)if(await tx.get(k('command',scope,row.commandId))!==undefined||
     await tx.get(k('effect',scope,row.effectId))!==undefined)conflict();
    if(seed.bytes){
     await put(docKey,{bytes:seed.bytes,revision:seed.revision});
     await put(ownerKey,after.acceptedParent);
    }
    for(const index of indexes)await put(index,x.operationId);
    await put(copyKey,seed.fileHash);
    await put(guardKey,i.op);
    await applySelection();
   }
   for(const [slot,value] of [[i.slot,{keyRef:v.keyRef,masterKeyId:v.masterKeyId,wrappedLocalKey:v.wrappedLocalKey}],
    [i.receipt,v.acceptanceReceipt],[i.guard,i.op],[i.packet,i.op],[i.op,v],[authorityKey,after]] as const)await put(slot,value);
   return {ok:true,value:{keyRef:v.keyRef,acceptanceReceipt:snap(v.acceptanceReceipt),replayed:false}};
  });}catch(e){return {ok:false,error:fail(e)}}
 }
}
