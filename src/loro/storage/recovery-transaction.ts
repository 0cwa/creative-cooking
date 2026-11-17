import type {TransactionRunner} from './core.ts';
import {validLocalRecord,localKeySlot,localKeyOperation} from './local-keys.ts';
// Recovery may read the master marker and its own records and install personal LocalKeys.
// A caller must still authenticate the recovery package before invoking its provider.
export function recoveryTransaction(run:TransactionRunner):TransactionRunner {
 const readable=new Set(['local-master-catalog','local-key','local-key-operation','recovery-install','recovery-device','recovery-reminder','recovery-generation','recovery-generation-head','recovery-generation-operation','recovery-custody-ack','recovery-readmission-challenge']);
 const writable=new Set([...readable].filter(x=>x!=='local-master-catalog'));
 function valid(k:string,allowed:Set<string>){try{const parts=JSON.parse(k);return Array.isArray(parts)&&parts.length>0&&parts.every(x=>typeof x==='string')&&allowed.has(parts[0])}catch{return false}}
 return (write,body)=>run(write,tx=>body({keys:async()=>(await tx.keys()).filter(k=>valid(k,readable)),get:async k=>{if(!valid(k,readable))throw Error('UNAUTHORIZED_STORAGE');return tx.get(k)},put:async(k,v)=>{if(!write||!valid(k,writable))throw Error('UNAUTHORIZED_STORAGE');const ns=JSON.parse(k)[0];if(ns==='local-key'||ns==='local-key-operation'){if(!validLocalRecord(v)||v.identity.scope.kind!=='personal'||v.identity.purpose!=='data'||k!==(ns==='local-key'?localKeySlot(v.identity):localKeyOperation(v.operationId)))throw Error('UNAUTHORIZED_STORAGE');if(await tx.get(k)!==undefined)throw Error('CONFLICT')}await tx.put(k,v)}}));
}
