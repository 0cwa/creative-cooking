import {evidenceSha256,resolveEvidenceAuthority,verifyReport} from './report.mjs';
import {validate,validateOperations,checkPreconditions,apply,bytes} from '../domain/registry.mjs';
import {REVIEW_LIMITS} from './review.mjs';
import {authenticateEvidence} from './authenticated-evidence.mjs';
import {resolveHistoricalPolicyLineage} from '../authority/chain.mjs';
import {verifyPolicyBaseline} from '../authority/policy-baseline.mjs';
import {verifyCurrentSeed} from './current-seed.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const eq=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const dense=a=>Array.isArray(a)&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
const order=(a,b)=>{const x=BigInt(a.meta.peer),y=BigInt(b.meta.peer);return x<y?-1:x>y?1:a.startCounter-b.startCounter||a.objectId.localeCompare(b.objectId)};
const evidenceRow=({sourceId,objectId,authorDevice,command,sourceHead})=>({sourceId,objectId,authorDevice,effectId:command.effectId,sourceHead});

export async function householdReportLineage(runtime,head,expectedAuthority) {
 const {storage,authority,scope}=runtime;
 const lineage=await resolveHistoricalPolicyLineage(storage,{kind:'household',id:scope.scopeId},authority.rootPin,authority.provider,head,REVIEW_LIMITS.authorityHeads);
 if(!eq(lineage[0].authority.expectedAuthority,expectedAuthority))throw Error('STALE_AUTHORITY');
 return lineage;
}

function appendStage(runtime,source,objects,inherited,seedIds,held) {
 const commands=new Set([...seedIds.values(),...inherited.map(e=>e.command.commandId)]);
 const effects=new Set([...seedIds.keys(),...inherited.map(e=>e.command.effectId)]);
 const conflicts=new Set();
 for(const [i,a] of objects.entries())for(const b of objects.slice(i+1)){
  if(a.command.commandId===b.command.commandId||a.command.effectId===b.command.effectId||
     a.meta.peer===b.meta.peer&&a.startCounter<b.endCounter&&b.startCounter<a.endCounter){
   conflicts.add(a);
   conflicts.add(b);
  }
 }
 const entries=[],pending=[];
 for(const object of [...objects].sort(order)){
  if(conflicts.has(object))held.push({...evidenceRow(object),reason:'CONFLICT'});
  else pending.push(object);
 }
 let progress=true;
 while(progress){
  progress=false;
  for(const [index,e] of pending.entries()){
   let prior;
   try{prior=source.forkAt(e.meta.frontiers)}catch{continue}
   let validated=false;
   try{
    if(commands.has(e.command.commandId)||effects.has(e.command.effectId))throw Error('CONFLICT');
    const counter=source.oplogVersion().toJSON().get(e.meta.peer)??0;
    if(counter>e.startCounter)throw Error('CONFLICT');
    if(counter<e.startCounter)continue;
    const check=prior.forkAt(e.meta.frontiers),start=check.oplogVersion(),result=check.import(e.update);
    if(result.pending?.size)continue;
    validateOperations(e.command,check.exportJsonUpdates(start,undefined,false).changes);
    checkPreconditions(prior,e.command,{importing:true});
    validated=true;
   }catch(err){held.push({...evidenceRow(e),reason:err.message||'INVALID_UPDATE'})}
   if(validated){
    const imported=source.import(e.update);
    if(imported.pending?.size)throw Error('INVALID_UPDATE');
    commands.add(e.command.commandId);
    effects.add(e.command.effectId);
    entries.push({...e,prior:new Set(Object.keys(prior.getMap('domain-effects').toJSON()))});
   }
   pending.splice(index,1);
   progress=true;
   break;
  }
 }
 for(const e of pending)held.push({...evidenceRow(e),reason:'MISSING_ANCESTOR'});
 return entries;
}

async function historicalSource({runtime,review,objects,checkpoint,total,current,sha256}) {
 const scope={kind:review.context.kind,id:review.context.scopeId};
 const head=review.report.payload.head;
 const policy=scope.kind==='household'?await householdReportLineage(runtime,head,current.expectedAuthority):null;
 // Existing archive callers can review one explicitly supplied older epoch.
 // Settings reports and all policy lineages use only the signed branch path.
 const scoped=!!policy&&(review.isolated||policy.length>1);
 const cache=new Map(policy?.map(edge=>[edge.authority.scope.branchHead,edge.authority]));
 const held=[],all=[],attemptedHeads=new Set();
 for(const [index,o] of objects.entries()){
  const m=review.manifest[index];
  if(o.sourceId!==m.sourceId||o.objectId!==m.objectId||o.bytes.length!==m.bytes||await sha256(o.bytes)!==m.hash)throw Error('STALE_EVIDENCE');
  try{
   const h=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(o.bytes))?.header;
   if(typeof h?.branchHead!=='string'||!h.branchHead)throw Error('MALFORMED');
   if(!attemptedHeads.has(h.branchHead)){
    if(attemptedHeads.size>=REVIEW_LIMITS.authorityHeads)throw Error('AUTHORITY_HEAD_BUDGET');
    attemptedHeads.add(h.branchHead);
   }
   let authority=cache.get(h.branchHead);
   if(!authority){
    if(scoped)throw Error('OUTSIDE_POLICY_LINEAGE');
    authority=await resolveEvidenceAuthority(runtime,scope,h.branchHead,h.authorDevice);
    if(!eq(authority.expectedAuthority,current.expectedAuthority))throw Error('STALE_AUTHORITY');
    cache.set(h.branchHead,authority);
   }
   all.push(await authenticateEvidence(runtime,scope.kind,authority,o));
  }catch(e){held.push({sourceId:o.sourceId,objectId:o.objectId,reason:e.message||'INVALID_EVIDENCE'})}
 }
 if(!scoped&&new Set(all.map(e=>JSON.stringify([e.sourceHead,e.sourceDocumentId,e.sourceGeneration]))).size>1)throw Error('MIXED_SOURCE_DOCUMENTS');
 const location=scoped?policy.at(-1).authority.scope:cache.get(all[0]?.sourceHead)?.scope??runtime.scope;
 const origin=scoped?policy[0].authority.scope:location;
 let retainedSeed=null,seedDoc=null;
 const seedIds=new Map();
 if(typeof runtime.storage.readRetainedProjectionSeed==='function'){
  const fetched=await runtime.storage.readRetainedProjectionSeed(scope.id,origin.documentId);
  if(!fetched.ok)throw Error(typeof fetched.error==='string'?fetched.error:fetched.error.code);
  retainedSeed=fetched.value;
  if(scoped&&!retainedSeed&&origin.branchHead!==runtime.authority.rootPin)throw Error('CHECKPOINT_UNAVAILABLE');
  if(retainedSeed){
   const sameCheckpoint=checkpoint.length===retainedSeed.snapshot.length&&checkpoint.every((byte,index)=>byte===retainedSeed.snapshot[index]);
   if(total+(sameCheckpoint?0:retainedSeed.snapshot.length)>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');
   if(!checkpoint.length&&!(policy?.length>1))throw Error('UNSUPPORTED_SEED_BOUNDARY');
   const authority=cache.get(retainedSeed.head)??await resolveEvidenceAuthority(runtime,scope,retainedSeed.head,all[0]?.authorDevice??runtime.scope.authorDevice);
   if(!eq(authority.expectedAuthority,current.expectedAuthority)||authority.scope.branchHead!==origin.branchHead||
      authority.scope.documentId!==origin.documentId||authority.scope.documentGeneration!==origin.documentGeneration)throw Error('INVALID_AUTHORITY');
   verifyCurrentSeed({LoroDoc:runtime.LoroDoc,snapshot:retainedSeed.snapshot,seed:retainedSeed.seed,
    schemaVersion:authority.seedSchemaVersion});
   seedDoc=new runtime.LoroDoc();
   seedDoc.import(retainedSeed.snapshot);
   for(const {effectId,commandId} of retainedSeed.seed.identities)seedIds.set(effectId,commandId);
  }
 }
 let source=new runtime.LoroDoc(),entries=[];
 if(retainedSeed)source.import(retainedSeed.snapshot);
 for(const edge of scoped?policy:[{authority:{scope:location},upperBound:null}]){
  const stage=all.filter(e=>e.sourceHead===edge.authority.scope.branchHead);
  const appended=appendStage(runtime,source,stage,entries,seedIds,held);
  if(!edge.upperBound){entries.push(...appended);continue}

  // Recompute the signed history from frozen authenticated operations. A
  // matching live counter alone cannot distinguish a sibling branch's edit.
  source=await verifyPolicyBaseline(source,runtime.LoroDoc,edge.upperBound,runtime.authority.provider);
  const frontier=source.oplogVersion().toJSON();
  for(const e of appended){
   const end=frontier.get(e.meta.peer)??0;
   if(end>=e.endCounter)entries.push(e);
   else if(end>e.startCounter)throw Error('POLICY_BASELINE_UNAVAILABLE');
   else held.push({...evidenceRow(e),reason:'OUTSIDE_POLICY_FRONTIER'});
  }
  if(entries.some(e=>(frontier.get(e.meta.peer)??0)<e.endCounter)||
     seedDoc&&[...seedDoc.oplogVersion().toJSON()].some(([peer,end])=>(frontier.get(peer)??0)<end))throw Error('POLICY_BASELINE_UNAVAILABLE');
 }
 return {held,cache,retainedSeed,seedDoc,seedIds,source,entries,location};
}

/** Authenticates frozen original envelopes against the pinned chain and validates their
 * complete updates on a source document built only from already authenticated updates.
 * A checkpoint is accepted only when its complete history and state match an
 * authenticated source frontier; original checkpoint history is never copied. */
export async function reconstructHistorical(input) {
 const review=await input.reviews.get(input.scopeId,input.reviewId);
 return reconstructSelected({...input,review});
}

// The atomic Settings save can verify a selection before writing it.
export async function reconstructSelected({runtime,review,scopeId,reviewId,objects,selectedEffectIds,checkpoint,
 sha256=evidenceSha256,randomBytes=size=>globalThis.crypto.getRandomValues(new Uint8Array(size))}) {
 if(!runtime?.authority)throw Error('UNSUPPORTED_AUTHORITY');
 if(!review||review.context?.scopeId!==scopeId||runtime.scope.scopeId!==scopeId||!['household','personal'].includes(review.context.kind)||(runtime.authority.kind??'household')!==review.context.kind||review.version!==1||review.status!=='selected'||!Array.isArray(review.manifest)||!Array.isArray(objects)||objects.length!==review.manifest.length||objects.length>REVIEW_LIMITS.objects||!(checkpoint instanceof Uint8Array)||checkpoint.length>REVIEW_LIMITS.objectBytes||!dense(selectedEffectIds)||selectedEffectIds.length>REVIEW_LIMITS.objects||!selectedEffectIds.every(x=>typeof x==='string'&&x.length>0&&x.length<=256)||new Set(selectedEffectIds).size!==selectedEffectIds.length)throw Error('INVALID_REVIEW');
 if(!review.selection||!eq(review.selection.effects,selectedEffectIds)||!eq(review.selection.manifest,review.manifest)||!eq(review.selection.context,review.context))throw Error('INVALID_SELECTION');
 let total=checkpoint.length;for(const o of objects){if(!(o?.bytes instanceof Uint8Array)||o.bytes.length>REVIEW_LIMITS.objectBytes)throw Error('TOO_LARGE');total+=o.bytes.length;if(total>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE')}
 objects=objects.map(o=>({...o,bytes:new Uint8Array(o.bytes)}));selectedEffectIds=[...selectedEffectIds];checkpoint=new Uint8Array(checkpoint);if(await sha256(checkpoint)!==review.context.checkpointHash)throw Error('CHECKPOINT_MISMATCH');
 if(await verifyReport({runtime,report:review.report,context:review.context,reviewId,manifest:review.manifest,sha256})!==review.reportHash)throw Error('INVALID_REPORT');
 const current=await runtime.authorization();if(!eq(current.expectedAuthority.record,{revision:review.context.authorityRevision,acceptedParent:review.context.authorityHead,authorizationSnapshot:review.context.authoritySnapshot}))throw Error('STALE_AUTHORITY');
 const {held,cache,retainedSeed,seedDoc,seedIds,source,entries,location}=await historicalSource({runtime,review,objects,checkpoint,total,current,sha256});
 const commands=new Map(entries.map(e=>[e.command.commandId,e.command]));
 const effects=new Set([...entries.map(e=>e.command.effectId),...held.map(e=>e.effectId)]);
 if(review.report.payload.boundary.kind==='operation'&&!entries.some(e=>e.objectId===review.report.payload.boundary.ref))throw Error('BOUNDARY_EVIDENCE_UNAVAILABLE');
 if(checkpoint.length){
  let cp,frontier;try{if(runtime.decodeImportBlobMeta(checkpoint,true).mode!=='snapshot')throw Error('INVALID_CHECKPOINT');cp=new runtime.LoroDoc();cp.import(checkpoint);frontier=source.forkAt(cp.frontiers())}catch{throw Error('CHECKPOINT_MISSING_ANCESTOR')}
  // Compare the complete history, not just a projection or markers. This also
  // catches unauthenticated hidden containers and operations.
  if(!eq(cp.exportJsonUpdates(undefined,undefined,false),frontier.exportJsonUpdates(undefined,undefined,false)))throw Error('INVALID_CHECKPOINT');
  if(seedDoc){let seedFrontier;try{seedFrontier=cp.forkAt(seedDoc.frontiers())}catch{throw Error('INVALID_BOUNDARY')}if(!eq(seedFrontier.exportJsonUpdates(undefined,undefined,false),seedDoc.exportJsonUpdates(undefined,undefined,false)))throw Error('INVALID_BOUNDARY')}
  const seen=new Set();for(const [effectId,marker] of Object.entries(cp.getMap('domain-effects').toJSON())){
   if(marker?.version===3){if(!retainedSeed||marker.seedId!==retainedSeed.seed.seedId||marker.effectId!==effectId||marker.commandId!==seedIds.get(effectId))throw Error('INVALID_CHECKPOINT');continue}if(marker?.version!==2||!marker.command||marker.command.effectId!==effectId)throw Error('INVALID_CHECKPOINT');
   const cmd=validate(marker.command),authenticated=commands.get(cmd.commandId);
   if(seen.has(cmd.commandId)||!authenticated||!eq(Array.from(bytes(cmd)),Array.from(bytes(authenticated)))||!selectedEffectIds.includes(effectId))throw Error('INVALID_CHECKPOINT');seen.add(cmd.commandId);
  }
 }
 const selected=new Set(selectedEffectIds);if([...selected].some(id=>seedIds.has(id)))throw Error('INVALID_BOUNDARY');for(const effectId of selected)if(!effects.has(effectId))held.push({effectId,reason:'MISSING_EVIDENCE'});
 const work=new Map(entries.map(e=>[e.command.effectId,e])),branches=new Map(),out=new runtime.LoroDoc(),included=[],excluded=[];
 for(const [id,e] of work)if(!selected.has(id)){excluded.push(evidenceRow(e));work.delete(id)}
 const peers=new Set([...cache.values()].flatMap(a=>Object.values(a.scope.authorPeers)));for(const p of source.oplogVersion().toJSON().keys())peers.add(p);
 let seedSnapshot=null;if(seedDoc){let freshPeer;for(let i=0;i<32;i++){const b=randomBytes(8);let n=0n;for(const x of b)n=(n<<8n)|BigInt(x);if(n&&!peers.has(String(n))){freshPeer=String(n);peers.add(freshPeer);break}}if(!freshPeer)throw Error('PEER_GENERATION_FAILED');const clean=new runtime.LoroDoc();clean.setPeerId(freshPeer);const data=seedDoc.toJSON();for(const name of Object.keys(data).sort())for(const key of Object.keys(data[name]).sort())clean.getMap(name).set(key,data[name][key]);seedSnapshot=clean.export({mode:'snapshot'});out.import(seedSnapshot)}
 const ordered=[...entries].sort(order),assigned=new Map();
 // A fresh contiguous range preserves authenticated original peer ordering for
 // concurrent Loro registers, independently of evidence arrival order.
 if(ordered.length){let base;for(let tries=0;tries<32;tries++){const raw=randomBytes(8);let n=0n;for(const x of raw)n=(n<<8n)|BigInt(x);n=1n+n%(18446744073709551614n-BigInt(ordered.length));if(ordered.every((_,i)=>!peers.has(String(n+BigInt(i))))){base=n;break}}if(base===undefined)throw Error('PEER_GENERATION_FAILED');ordered.forEach((e,i)=>assigned.set(e.command.effectId,String(base+BigInt(i))))}
 let progress=true;
 while(progress){progress=false;for(const [id,e] of work){if(e.command.dependencyEffectIds.some(d=>!branches.has(d)&&!seedIds.has(d))||[...e.prior].some(d=>work.has(d)))continue;const branch=new runtime.LoroDoc();if(seedSnapshot)branch.import(seedSnapshot);for(const [ancestor,snapshot] of branches)if(e.prior.has(ancestor))branch.import(snapshot);branch.setPeerId(assigned.get(id));try{checkPreconditions(branch,e.command,{importing:true});apply(branch,e.command);const snapshot=branch.export({mode:'snapshot'});branches.set(id,snapshot);out.import(snapshot);included.push({...evidenceRow(e),command:e.command})}catch(err){held.push({...evidenceRow(e),reason:'RECONSTRUCTION_'+(err.message||'INVALID')})}work.delete(id);progress=true;break}}
 for(const e of work.values())held.push({...evidenceRow(e),reason:e.command.dependencyEffectIds.some(d=>!selected.has(d))?'DEPENDENCY_EXCLUDED':'MISSING_DEPENDENCY'});
 if(!eq((await runtime.authorization()).expectedAuthority,current.expectedAuthority))throw Error('STALE_AUTHORITY');
 return {doc:out,sourceDocumentId:location.documentId,sourceGeneration:location.documentGeneration,included,excluded,held,complete:false,state:'local-draft'};
}

/** Finalize only a local draft. Publication requires a separate authority procedure. */
export async function finalizeHistoricalDraft(input) { return input.reviews.finalizeHistorical(input); }
