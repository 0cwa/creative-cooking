import {resolvePersonalAuthority} from '../authority/personal.mjs';
import {validLocalRecord} from '../storage/local-keys.ts';
import {personalRecovery} from './personal-recovery.mjs';
import {createRecoveryArchive} from './recovery-archive.mjs';
/** Called by an open, accepted workspace. Resolve authority and durable key indexes at the time of export. */
export function workspaceRecovery({sodium,keys,run,storage,master,masterId,scopeId,deviceId,pin,provider}){
 return {async create({generation=0,previousCatalogHash=null}={}){
  const resolved=await resolvePersonalAuthority(storage,{kind:'personal',id:scopeId},pin,provider,deviceId);
  const found=await run(false,async tx=>{const matches=[];for(const slot of await tx.keys()){let parts;try{parts=JSON.parse(slot)}catch{continue}if(parts[0]!=='local-key'||parts[1]!=='personal'||parts[2]!==scopeId||parts[3]!==deviceId||parts[4]!=='data'||parts[5]!==resolved.scope.epochId)continue;const record=await tx.get(slot);if(!validLocalRecord(record))throw Error('LOCKED');matches.push(record)}return matches});
  if(found.length!==1)throw Error('MISSING_KEY');const record=found[0];await keys.use(record.operationId,record.identity,()=>undefined);
  const bindings=[{ref:resolved.scope.epochId,operationId:record.operationId,identity:record.identity}],objects=await storage.listOutboundObjects(scopeId);if(!objects.ok)throw Error(objects.error);
  const catalog={version:1,owner:resolved.scope.ownerId,generation,previousCatalogHash,keyRefs:[resolved.scope.epochId],encryptedObjectRefs:objects.value.filter(o=>o.epochId===resolved.scope.epochId).map(o=>o.objectId),trustedCheckpoints:[],custodyLocations:[]};
  const recovery=personalRecovery({sodium,keys,run,storage,master,masterId,owner:resolved.scope.ownerId,scopeId,bindings,operationId:`export:${crypto.randomUUID()}`});
  const kit=await recovery.create(catalog);const archive=await createRecoveryArchive({sodium,storage,keys,scopeId,owner:resolved.scope.ownerId,deviceId,pin,catalog,bindings,kit,includeObjects:true,includeSnapshot:true});
  return {code:kit.code,archive};
 }};
}
