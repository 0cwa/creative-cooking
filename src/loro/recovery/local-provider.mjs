// Candidate adapter. The caller supplies a trusted, owner-bound mapping from catalog references
// to existing LocalKeys identities; it must derive this mapping from accepted local state.
import {findLocalKey,installLocalKey,validLocalIdentity} from '../storage/local-keys.ts';
const enc=new TextEncoder(), hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const slot=(owner,op)=>JSON.stringify(['recovery-install',owner,op]);
export function localRecoveryProvider({keys,run,sodium,owner,scopeId,operationId,lookup,hasObject}){
 if(typeof owner!=='string'||!owner||typeof scopeId!=='string'||!scopeId||typeof operationId!=='string'||!operationId||typeof lookup!=='function'||typeof hasObject!=='function')throw Error('INVALID_CONTEXT');
 function mapping(ref){const m=lookup(ref);if(!m||typeof m.operationId!=='string'||!m.operationId||!validLocalIdentity(m.identity)||m.identity.scope.kind!=='personal'||m.identity.scope.id!==scopeId||m.identity.purpose!=='data')throw Error('UNAUTHORIZED_KEY');return structuredClone(m)}
 return {
 async exportPersonalDataKey(requestOwner,ref){if(requestOwner!==owner)throw Error('UNAUTHORIZED_KEY');const m=mapping(ref);return keys.use(m.operationId,m.identity,key=>({owner,scope:'personal',purpose:'data',ref,key:new Uint8Array(key)}))},
 async installPersonalDataKeys(requestOwner,items,catalog){if(requestOwner!==owner||!catalog||catalog.owner!==owner||!Array.isArray(items)||!Array.isArray(catalog.keyRefs)||items.length!==catalog.keyRefs.length||items.some((x,i)=>!x||x.ref!==catalog.keyRefs[i]||!(x.key instanceof Uint8Array)||x.key.length!==32)||new Set(items.map(x=>x.ref)).size!==items.length)throw Error('UNAUTHORIZED_KEY');catalog=structuredClone(catalog);items=items.map(x=>({ref:x.ref,key:new Uint8Array(x.key)}));try{const mapped=items.map(item=>({item,m:mapping(item.ref)}));if(new Set(mapped.map(x=>JSON.stringify(x.m.identity))).size!==mapped.length||new Set(mapped.map(x=>x.m.operationId)).size!==mapped.length)throw Error('CONFLICT');const input=hex(sodium.crypto_generichash(32,enc.encode(JSON.stringify([catalog,mapped.map(({item,m})=>[item.ref,m,hex(item.key)])]))));const recordKey=slot(owner,operationId);
 const replay=await run(false,async tx=>{const old=await tx.get(recordKey);if(old===undefined)return false;if(old.input!==input)throw Error('CONFLICT');for(const x of mapped)if(!await findLocalKey(tx,x.m.operationId,x.m.identity))throw Error('LOCKED');return true});if(replay){for(const x of mapped)await keys.use(x.m.operationId,x.m.identity,secret=>{if(!sodium.memcmp(secret,x.item.key))throw Error('LOCKED')});return;}
 const prepared=[];for(const x of mapped)prepared.push(await keys.prepareRecoveredDataKey(x.m.operationId,x.m.identity,x.item.key));
 await run(true,async tx=>{const old=await tx.get(recordKey);if(old!==undefined)throw Error('CONFLICT');for(const p of prepared)await installLocalKey(tx,p.record,p.catalog);await tx.put(recordKey,{version:1,input,catalog:structuredClone(catalog)})});
 }finally{for(const item of items)item.key.fill(0)}
 },
 async hasEncryptedObject(requestOwner,ref){if(requestOwner!==owner)throw Error('UNAUTHORIZED_KEY');const present=await hasObject(ref);if(typeof present!=='boolean')throw Error('INVALID_AVAILABILITY');return present}
 };
}
