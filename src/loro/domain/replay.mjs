import {validate,operations,checkPreconditions,apply,bytes,validateOperations as validateOperationsForReplay} from './registry.mjs';
const LIMIT=256, MAX_BYTES=1024*1024;
const dense=a=>Array.isArray(a) && Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
/**
 * Reconstruct into a disposable Loro document from an authenticated checkpoint and
 * authenticated semantic records. Authentication and boundary selection belong
 * to the caller; this function never accepts CRDT bytes as proof of authorship.
 */
export function replayCommandsFixtureOnly({LoroDoc,checkpoint,records,excludedEffectIds=[]}) {
 if(typeof LoroDoc!=='function' || !(checkpoint instanceof Uint8Array) || !dense(records) || records.length>LIMIT || !dense(excludedEffectIds) || excludedEffectIds.length>LIMIT || !excludedEffectIds.every(x=>typeof x==='string'&&x) || new Set(excludedEffectIds).size!==excludedEffectIds.length) throw Error('MALFORMED_REPLAY');
 if(checkpoint.length>MAX_BYTES) throw Error('TOO_LARGE');
 const commands=new Set(),effects=new Set(),excluded=new Set(excludedEffectIds),entries=[];let size=checkpoint.length;
 for(const entry of records){
  if(!entry || typeof entry!=='object' || Object.keys(entry).sort().join(',')!=='authorDevice,command' || typeof entry.authorDevice!=='string' || !entry.authorDevice) throw Error('MALFORMED_REPLAY');
  const command=validate(entry.command);operations(command);size+=bytes(command).length;if(size>MAX_BYTES) throw Error('TOO_LARGE');
  if(commands.has(command.commandId)||effects.has(command.effectId)) throw Error('CONFLICT');commands.add(command.commandId);effects.add(command.effectId);
  if(command.data.author!==undefined && command.data.author!==entry.authorDevice) throw Error('INVALID_AUTHORITY');
  entries.push({authorDevice:entry.authorDevice,command});
 }
 const doc=new LoroDoc();if(checkpoint.length)doc.import(checkpoint);
 const present=doc.getMap('domain-effects');
 const checkpointCommands=new Map();
 for(const [effectId,marker] of Object.entries(present.toJSON())) {
  // A legacy checkpoint without command identity cannot safely reserve IDs.
  if(marker?.version!==2 || !marker?.command || marker.command.effectId!==effectId) throw Error('INVALID_CHECKPOINT');
  const command=validate(marker.command);operations(command);
  if(checkpointCommands.has(command.commandId)) throw Error('INVALID_CHECKPOINT');
  checkpointCommands.set(command.commandId,command);
 }
 const completed=new Set();
 for(const e of entries) {
  const existing=checkpointCommands.get(e.command.commandId), effect=present.get(e.command.effectId);
  if(existing || effect) {
   if(!existing || !effect || JSON.stringify(Array.from(bytes(existing)))!==JSON.stringify(Array.from(bytes(e.command)))) throw Error('CONFLICT');
   completed.add(e.command.effectId);
  }
 }
 for(const id of excluded) if(present.get(id)) throw Error('INVALID_BOUNDARY');
 for(const marker of Object.values(present.toJSON())) if(marker?.dependencyEffectIds?.some(id=>excluded.has(id))) throw Error('INVALID_BOUNDARY');
 const pending=new Map(entries.filter(e=>!completed.has(e.command.effectId)).map(e=>[e.command.effectId,e])),applied=entries.filter(e=>completed.has(e.command.effectId)),held=[];
 for(const id of excluded){const e=pending.get(id);if(e){pending.delete(id);held.push({...e,reason:'EXCLUDED'});}}
 let progress=true;
 while(progress){progress=false;const candidates=[...pending.entries()].sort((a,b)=>(a[1].command.kind==='shopping-cycle-start')-(b[1].command.kind==='shopping-cycle-start'));for(const [id,e] of candidates){
  if(e.command.dependencyEffectIds.some(dep=>!present.get(dep))) continue;
  try {checkPreconditions(doc,e.command,{replaying:true});apply(doc,e.command);applied.push(e);pending.delete(id);progress=true;break;}
  catch(error){if(error.message==='MISSING_DEPENDENCY')continue;held.push({...e,reason:error.message});pending.delete(id);progress=true;break;}
 }}
 const blocked=new Set([...excluded,...held.map(x=>x.command.effectId)]);let changed=true;while(changed){changed=false;for(const e of pending.values())if(!blocked.has(e.command.effectId)&&e.command.dependencyEffectIds.some(id=>blocked.has(id))){blocked.add(e.command.effectId);changed=true;}}
 for(const e of pending.values())held.push({...e,reason:blocked.has(e.command.effectId)?'DEPENDENCY_EXCLUDED':'MISSING_DEPENDENCY'});
 return {doc,applied,held};
}

export function replayCommands() { throw Error('INSUFFICIENT_EVIDENCE'); }

/** Reconstruct only from envelopes committed by this runtime and its trusted checkpoint. */
export async function replayAuthenticated({runtime,checkpoint,excludedEffectIds=[]}) {
 const same=(a,b)=>JSON.stringify(Array.from(bytes(a)))===JSON.stringify(Array.from(bytes(b)));
 const required=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value;};
 if(!runtime || !(checkpoint instanceof Uint8Array) || checkpoint.length>MAX_BYTES || !dense(excludedEffectIds) || excludedEffectIds.length>LIMIT || !excludedEffectIds.every(x=>typeof x==='string'&&x) || new Set(excludedEffectIds).size!==excludedEffectIds.length) throw Error('MALFORMED_REPLAY');
 const {expectedAuthority,signingKeyRefs}=await runtime.authorization();
 const scope=runtime.scope, outbound=required(await runtime.storage.listOutboundObjects(scope.scopeId)), inbox=required(await runtime.storage.listStagedInbox(scope.scopeId));
 const seed=typeof runtime.storage.readProjectionSeed==='function'?required(await runtime.storage.readProjectionSeed(expectedAuthority,scope.documentId)):null;
 const objects=[],decoder=new TextDecoder('utf-8',{fatal:true});
 let size=checkpoint.length+(seed?.snapshot.length??0);
 if(size>MAX_BYTES)throw Error('TOO_LARGE');
 function include(id,bytes){
  // The clear header only selects candidates. Each selected envelope is
  // authenticated below, and the live document must have complete evidence.
  let header;try{header=JSON.parse(decoder.decode(bytes)).header}catch{throw Error('MALFORMED_UPDATE')}
  if(header?.branchHead!==scope.branchHead||header.epochId!==scope.epochId||header.documentId!==scope.documentId)return;
  size+=bytes.length;
  if(objects.length>=LIMIT||size>MAX_BYTES)throw Error('TOO_LARGE');
  objects.push({id,bytes});
 }
 for(const row of outbound)if(row.branchHead===scope.branchHead&&row.epochId===scope.epochId)include(row.objectId,row.bytes);
 for(const item of inbox)if(required(await runtime.storage.getInboxApplication(scope.scopeId,item.itemId)))include(item.itemId,item.bytes);
 const {doc:original,storedBytes}=await runtime.document(),entries=[],identities=new Map(),effects=new Set();
 const excludedRecipeCopies=new Set(),excluded=new Set(excludedEffectIds);
 let verifyRecipeSource;

 for(const object of objects) {
  const opened=await runtime.codec.openContent(object.bytes,signingKeyRefs),h=opened.header;
  if(opened.object.id!==object.id || h.scopeId!==scope.scopeId || h.documentId!==scope.documentId || h.documentGeneration!==scope.documentGeneration || h.branchHead!==scope.branchHead || h.epochId!==scope.epochId || h.suiteId!==scope.suiteId || !same(h.policyHashes,scope.policyHashes) || !scope.acceptedAuthors.includes(h.authorDevice) || h.payloadKind!=='loro-update-v1' || h.semanticEffectIds.length!==1) throw Error('INVALID_AUTHORITY');
  let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(opened.value));}catch{throw Error('MALFORMED_UPDATE');}
  if(!payload || Object.keys(payload).sort().join(',')!=='command,update,version' || payload.version!==1 || (!dense(payload.update) || !payload.update.every(x=>Number.isInteger(x)&&x>=0&&x<=255))) throw Error('MALFORMED_UPDATE');
  const command=validate(payload.command),update=Uint8Array.from(payload.update),meta=runtime.inspectUpdate(update);
  runtime.assertRecipeCommand(command);
  if(command.data.author!==undefined && command.data.author!==h.authorDevice) throw Error('INVALID_AUTHORITY');
  if(command.effectId!==h.semanticEffectIds[0] || meta.peer!==scope.authorPeers[h.authorDevice] || !same(meta.predecessors,h.predecessorRefs)) throw Error('MALFORMED_UPDATE');
  let prior;try{prior=original.forkAt(meta.frontiers);}catch{throw Error('INSUFFICIENT_EVIDENCE');}
  const check=prior.forkAt(meta.frontiers),start=check.oplogVersion(),status=check.import(update);
  if(status.pending?.size)throw Error('INSUFFICIENT_EVIDENCE');
  validateOperationsForReplay(command,check.exportJsonUpdates(start,undefined,false).changes);
  let linked;
  if(command.data.recipeSource){
   if(h.version!==4 || !same(h.sourceEffectIds,[...command.dependencyEffectIds].sort()))throw Error('INVALID_SOURCE_PROOF');
   if(!verifyRecipeSource){
    const {disclosureService}=await import('../disclosure/service.mjs');
    const {createShoppingRecipeSourceVerifier}=await import('../disclosure/shopping-recipe-source.mjs');
    const service=disclosureService({storage:runtime.storage,scope:expectedAuthority.scope,rootPin:runtime.authority.rootPin,
     provider:runtime.authority.provider,deviceId:scope.authorDevice,
     installedSet:runtime.authority.installedSet});
    verifyRecipeSource=createShoppingRecipeSourceVerifier({runtime,service,context:await service.authority()});
   }
   linked=await verifyRecipeSource(command,expectedAuthority);
   for(const source of linked.sources.values()){
    if(source.incomplete&&!h.disclosureIncomplete||source.policies.some(hash=>!h.disclosurePolicyHashes.includes(hash)))throw Error('INVALID_SOURCE_PROOF');
    if(source.sourceDependencies.some(dep=>excluded.has(dep)))excludedRecipeCopies.add(command.effectId);
   }
  }
  checkPreconditions(prior,command,{importing:true,recipeSource:linked?.source});
  const marker=original.getMap('domain-effects').get(command.effectId);
  if(!marker?.command || !same(marker.command,command))throw Error('INSUFFICIENT_EVIDENCE');
  const old=identities.get(command.commandId);
  if(old){if(!same(old,command))throw Error('CONFLICT');continue;}
  if(effects.has(command.effectId))throw Error('CONFLICT');identities.set(command.commandId,command);effects.add(command.effectId);
  entries.push({authorDevice:h.authorDevice,command,sourcePeer:meta.peer,sourceCounter:runtime.decodeImportBlobMeta(update,true).partialStartVersionVector.toJSON().get(meta.peer)??0,prior:new Set(Object.keys(prior.getMap('domain-effects').toJSON()))});
 }
 const seedDoc=new runtime.LoroDoc(),seedIds=new Map();if(seed){seedDoc.import(seed.snapshot);for(const x of seed.seed.identities)seedIds.set(x.effectId,x.commandId)}
 const base=new runtime.LoroDoc();
 if(checkpoint.length){
  base.import(checkpoint);
  // forkAt may merge adjacent Loro changes. The exact snapshot read by this
  // runtime already pins the checkpoint without comparing those change groups.
  const isStored=storedBytes?.length===checkpoint.length && checkpoint.every((byte,index)=>byte===storedBytes[index]);
  if(!isStored){
   let originalFrontier;
   try{originalFrontier=original.forkAt(base.frontiers())}catch{throw Error('INSUFFICIENT_EVIDENCE')}
   if(!same(base.exportJsonUpdates(undefined,undefined,false),originalFrontier.exportJsonUpdates(undefined,undefined,false)))throw Error('INSUFFICIENT_EVIDENCE');
  }
 }
 if(seed&&checkpoint.length){let checked;try{checked=base.forkAt(seedDoc.frontiers())}catch{throw Error('INSUFFICIENT_EVIDENCE')}if(!same(checked.exportJsonUpdates(undefined,undefined,false),seedDoc.exportJsonUpdates(undefined,undefined,false)))throw Error('INSUFFICIENT_EVIDENCE')}
 const markers=base.getMap('domain-effects').toJSON(),checkpointIds=new Map();
 for(const [id,marker] of Object.entries(markers)){if(marker?.version===3){if(!seed||marker.seedId!==seed.seed.seedId||marker.effectId!==id||marker.commandId!==seedIds.get(id))throw Error('INSUFFICIENT_EVIDENCE');continue}if(marker?.version!==2 || !marker?.command || marker.command.effectId!==id)throw Error('INSUFFICIENT_EVIDENCE');const command=validate(marker.command);if(checkpointIds.has(command.commandId))throw Error('CONFLICT');checkpointIds.set(command.commandId,command);}
 const excludedDependencies=new Set([...excluded,...excludedRecipeCopies]);
 for(const [id,marker] of Object.entries(markers)){if(excludedDependencies.has(id)||(marker.dependencyEffectIds??[]).some(x=>excludedDependencies.has(x)))throw Error('INVALID_BOUNDARY');}
 for(const e of entries){const old=checkpointIds.get(e.command.commandId),effect=markers[e.command.effectId];if((old||effect)&&(!old||!effect||!same(old,e.command)))throw Error('CONFLICT');}
 for(const [id,marker] of Object.entries(markers)){if(marker.version===3)continue;const source=identities.get(marker.command.commandId);if(!source || source.effectId!==id || !same(source,marker.command))throw Error('INSUFFICIENT_EVIDENCE');}
 for(const [id,marker] of Object.entries(original.getMap('domain-effects').toJSON())) if(marker?.version===3 ? (!seed||marker.seedId!==seed.seed.seedId||marker.commandId!==seedIds.get(id)) : (marker?.version!==2 || !marker?.command || !effects.has(id))) throw Error('INSUFFICIENT_EVIDENCE');
 for(const e of entries)if(seedIds.has(e.command.effectId)||[...seedIds.values()].includes(e.command.commandId))throw Error('CONFLICT');
 const pending=new Map(entries.map(e=>[e.command.effectId,e])),applied=[],held=[],branches=new Map();
 for(const id of excluded){const e=pending.get(id);if(e){const {prior,sourcePeer,sourceCounter,...record}=e;held.push({...record,reason:'EXCLUDED'});pending.delete(id);}}
 const out=new runtime.LoroDoc();
 const peers=new Set([...Object.values(scope.authorPeers),...original.oplogVersion().toJSON().keys()]);
 // Preserve source peer ordering without reusing source identities. Assignments
 // derive from authenticated starting operation IDs, never inbox/outbox order.
 const sourceOrder=[...entries].sort((a,b)=>BigInt(a.sourcePeer)===BigInt(b.sourcePeer)?b.sourceCounter-a.sourceCounter:BigInt(a.sourcePeer)>BigInt(b.sourcePeer)?-1:1),freshPeers=new Map();
 let peer=18446744073709551614n,seedSnapshot=null;
 if(seed){while(peers.has(String(peer)))peer--;const fresh=new runtime.LoroDoc();fresh.setPeerId(String(peer--));const state=seedDoc.toJSON();for(const name of Object.keys(state).sort())for(const key of Object.keys(state[name]).sort())fresh.getMap(name).set(key,state[name][key]);seedSnapshot=fresh.export({mode:'snapshot'});out.import(seedSnapshot)}
 for(const entry of sourceOrder){while(peers.has(String(peer)))peer--;freshPeers.set(entry.command.effectId,String(peer--));}
 let progress=true;
 while(progress){progress=false;for(const [id,e] of pending){
  if(excludedRecipeCopies.has(id)||e.command.dependencyEffectIds.some(dep=>excludedDependencies.has(dep)||!branches.has(dep)&&
    !seedIds.has(dep)&&!e.command.data.recipeSource?.effectIds.includes(dep)))continue;
  if([...e.prior].some(dep=>pending.has(dep)))continue;
  const branch=new runtime.LoroDoc();if(seedSnapshot)branch.import(seedSnapshot);
  for(const [ancestor,snapshot] of branches)if(e.prior.has(ancestor))branch.import(snapshot);
  branch.setPeerId(freshPeers.get(id));
  apply(branch,e.command);const snapshot=branch.export({mode:'snapshot'});branches.set(id,snapshot);out.import(snapshot);
  const {prior,sourcePeer,sourceCounter,...record}=e;applied.push(record);pending.delete(id);progress=true;break;
 }}
 const blocked=new Set([...excludedDependencies,...held.map(x=>x.command.effectId)]);let changed=true;while(changed){changed=false;for(const e of pending.values())if(!blocked.has(e.command.effectId)&&e.command.dependencyEffectIds.some(id=>blocked.has(id))){blocked.add(e.command.effectId);changed=true;}}
 for(const e of pending.values()){const {prior,sourcePeer,sourceCounter,...record}=e;held.push({...record,reason:blocked.has(e.command.effectId)?'DEPENDENCY_EXCLUDED':'MISSING_DEPENDENCY'});}
 if(!same((await runtime.authorization()).expectedAuthority,expectedAuthority))throw Error('INVALID_AUTHORITY');
 return {doc:out,applied,held};
}
