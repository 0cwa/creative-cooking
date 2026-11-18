// The bindings supplied here come from the accepted local workspace, never from a recovery package.
import {localRecoveryProvider} from '../recovery/local-provider.mjs';
import {createPersonal,authenticatePersonal} from '../recovery/recovery.mjs';
import {restoreWithFreshDevice} from '../recovery/fresh-device.mjs';
import {validLocalIdentity} from '../storage/local-keys.ts';

const enc = new TextEncoder();
const id = value => typeof value === 'string' && value.length > 0 && enc.encode(value).length <= 256;
const aad = (owner,scopeId,operationId) => enc.encode(JSON.stringify(['creative-cooking/recovery-continuity/v1',owner,scopeId,operationId]));
const recordKey = (owner,operationId) => JSON.stringify(['recovery-install',owner,`continuity:${operationId}`]);

/** Bind a recovery provider to independently accepted personal key identities and scoped ciphertext. */
export function personalRecovery({sodium,keys,run,storage,master,masterId,owner,scopeId,bindings,operationId}) {
 if (![owner,scopeId,masterId,operationId].every(id) || operationId.length > 128 || !Array.isArray(bindings) || !bindings.length || typeof run !== 'function' || typeof storage?.listOutboundObjects !== 'function' || typeof master?.wrap !== 'function' || typeof master?.unwrap !== 'function') throw Error('INVALID_CONTEXT');
 const trusted = new Map();
 for (const binding of structuredClone(bindings)) {
  if (!binding || !id(binding.ref) || !id(binding.operationId) || !validLocalIdentity(binding.identity) || binding.identity.scope.kind !== 'personal' || binding.identity.scope.id !== scopeId || binding.identity.purpose !== 'data' || trusted.has(binding.ref)) throw Error('INVALID_CONTEXT');
  trusted.set(binding.ref,{operationId:binding.operationId,identity:binding.identity});
 }
 const values=[...trusted.values()];
 if (new Set(values.map(v=>v.operationId)).size!==values.length || new Set(values.map(v=>JSON.stringify(v.identity))).size!==values.length) throw Error('INVALID_CONTEXT');
 const lookup=ref=>trusted.get(ref);
 const hasObject=async ref=>{
  if (!id(ref)) throw Error('INVALID_CONTEXT');
  const result=await storage.listOutboundObjects(scopeId);
  if (!result.ok) throw Error(result.error);
  return result.value.some(object=>object.objectId===ref);
 };
 const makeProvider = lookup => localRecoveryProvider({keys,run,sodium,owner,scopeId,operationId,lookup,hasObject});
 const provider=makeProvider(lookup);
 return {
  async create(catalog){
   if (catalog?.owner!==owner || !Array.isArray(catalog.keyRefs) || catalog.keyRefs.length!==trusted.size || catalog.keyRefs.some(ref=>!trusted.has(ref))) throw Error('INVALID_CONTEXT');
   return createPersonal(sodium,catalog,provider);
  },
  // This check can be called before opening or creating the destination workspace.
  authenticate(pkg,code,generation){authenticatePersonal(sodium,pkg,code,{owner,generation});},
  async restore(pkg,code,generation){
   const result=await restoreWithFreshDevice({sodium,run,keys,owner,scopeId,operationId,package:pkg,code,generation,providerForDevice:deviceId=>makeProvider(ref=>{const source=trusted.get(ref);if(!source)return undefined;const digest=sodium.to_hex(sodium.crypto_generichash(32,enc.encode(ref)));return {operationId:`recovery-data:${deviceId}:${digest}`,identity:{...source.identity,deviceId}}})});
   // Keep the continuity seed wrapped under the destination master, including across retries.
   const key=recordKey(owner,operationId),context=aad(owner,scopeId,operationId),plain=enc.encode(result.continuityCredential);
   try {
    const old=await run(false,tx=>tx.get(key));
    if (old!==undefined) {
     if (!old || old.version!==1 || old.scopeId!==scopeId || !(old.wrapped instanceof Uint8Array)) throw Error('LOCKED');
     const restored=await master.unwrap(masterId,old.wrapped,context);
     try {if (!sodium.memcmp(restored,plain)) throw Error('CONFLICT')} finally {restored.fill(0)}
    } else {
     const wrapped=await master.wrap(masterId,plain,context);
     await run(true,async tx=>{if(await tx.get(key)!==undefined)throw Error('CONFLICT');await tx.put(key,{version:1,scopeId,wrapped});});
    }
   } finally {plain.fill(0)}
   const {continuityCredential:_,...status}=result;
   return status;
  }
 };
}

/** Use the imported seed only within the destination workspace. */
export async function withRecoveredContinuity({run,master,masterId,owner,scopeId,operationId},use){
 const record=await run(false,tx=>tx.get(recordKey(owner,operationId)));
 if(!record||record.version!==1||record.scopeId!==scopeId||!(record.wrapped instanceof Uint8Array))throw Error('MISSING_RECOVERY');
 const plain=await master.unwrap(masterId,record.wrapped,aad(owner,scopeId,operationId));
 try{return await use(new TextDecoder('utf-8',{fatal:true}).decode(plain))}
 finally{plain.fill(0)}
}
