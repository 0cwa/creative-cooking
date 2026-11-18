import {resolveEvidenceAuthority,verifyReport} from './report.mjs';
import {validate,validateOperations,checkPreconditions,apply,bytes} from '../domain/registry.mjs';
import {REVIEW_LIMITS} from './review.mjs';
import {authenticateEvidence} from './authenticated-evidence.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const eq=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const digest=async b=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)));
const dense=a=>Array.isArray(a)&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
/** Authenticates frozen original envelopes against the pinned chain and validates their
 * complete updates on a source document built only from already authenticated updates.
 * A checkpoint is accepted only when its complete history and state match an
 * authenticated source frontier; original checkpoint history is never copied. */
export async function reconstructHistorical({runtime,reviews,scopeId,reviewId,objects,selectedEffectIds,checkpoint}) {
 const review=await reviews.get(scopeId,reviewId);
 if(!runtime?.authority)throw Error('UNSUPPORTED_AUTHORITY');
 if(!review||review.context?.scopeId!==scopeId||runtime.scope.scopeId!==scopeId||!['household','personal'].includes(review.context.kind)||(runtime.authority.kind??'household')!==review.context.kind||review.version!==1||review.status!=='selected'||!Array.isArray(review.manifest)||!Array.isArray(objects)||objects.length!==review.manifest.length||objects.length>REVIEW_LIMITS.objects||!(checkpoint instanceof Uint8Array)||checkpoint.length>REVIEW_LIMITS.objectBytes||!dense(selectedEffectIds)||selectedEffectIds.length>REVIEW_LIMITS.objects||!selectedEffectIds.every(x=>typeof x==='string'&&x.length>0&&x.length<=256)||new Set(selectedEffectIds).size!==selectedEffectIds.length)throw Error('INVALID_REVIEW');
 if(!review.selection||!eq(review.selection.effects,selectedEffectIds)||!eq(review.selection.manifest,review.manifest)||!eq(review.selection.context,review.context))throw Error('INVALID_SELECTION');
 let total=checkpoint.length;for(const o of objects){if(!(o?.bytes instanceof Uint8Array)||o.bytes.length>REVIEW_LIMITS.objectBytes)throw Error('TOO_LARGE');total+=o.bytes.length;if(total>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE')}
 objects=objects.map(o=>({...o,bytes:new Uint8Array(o.bytes)}));selectedEffectIds=[...selectedEffectIds];checkpoint=new Uint8Array(checkpoint);if(await digest(checkpoint)!==review.context.checkpointHash)throw Error('CHECKPOINT_MISMATCH');
 if(await verifyReport({runtime,report:review.report,context:review.context,reviewId,manifest:review.manifest})!==review.reportHash)throw Error('INVALID_REPORT');
 const current=await runtime.authorization();if(!eq(current.expectedAuthority.record,{revision:review.context.authorityRevision,acceptedParent:review.context.authorityHead,authorizationSnapshot:review.context.authoritySnapshot}))throw Error('STALE_AUTHORITY');
 const all=[],held=[],cache=new Map(),attemptedHeads=new Set(),scope={kind:review.context.kind,id:review.context.scopeId};
 for(let i=0;i<objects.length;i++){
  const o=objects[i],m=review.manifest[i];if(o.sourceId!==m.sourceId||o.objectId!==m.objectId||o.bytes.length!==m.bytes||await digest(o.bytes)!==m.hash)throw Error('STALE_EVIDENCE');
  try{
   let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(o.bytes))}catch{throw Error('MALFORMED')}
   const head=raw?.header?.branchHead;if(typeof head!=='string'||!head)throw Error('MALFORMED');
   if(!attemptedHeads.has(head)){if(attemptedHeads.size>=REVIEW_LIMITS.authorityHeads)throw Error('AUTHORITY_HEAD_BUDGET');attemptedHeads.add(head)}
   let a=cache.get(head);if(!a){a=await resolveEvidenceAuthority(runtime,scope,head,raw?.header?.authorDevice);cache.set(head,a)}
   all.push(await authenticateEvidence(runtime,scope.kind,a,o));
  }catch(e){held.push({sourceId:o.sourceId,objectId:o.objectId,reason:e.message||'INVALID_EVIDENCE'})}
 }
 if(new Set(all.map(e=>JSON.stringify([e.sourceDocumentId,e.sourceGeneration]))).size>1)throw Error('MIXED_SOURCE_DOCUMENTS');
 let retainedSeed=null,seedDoc=null,seedIds=new Map();
 if(all.length&&typeof runtime.storage.readRetainedProjectionSeed==='function'){
  const fetched=await runtime.storage.readRetainedProjectionSeed(scope.id,all[0].sourceDocumentId);if(!fetched.ok)throw Error(typeof fetched.error==='string'?fetched.error:fetched.error.code);retainedSeed=fetched.value;
  if(retainedSeed){if(!checkpoint.length||total+retainedSeed.snapshot.length>REVIEW_LIMITS.bytes)throw Error('INVALID_BOUNDARY');const selectedSeed=await resolveEvidenceAuthority(runtime,scope,retainedSeed.head,all[0].authorDevice);if(selectedSeed.scope.documentId!==all[0].sourceDocumentId||selectedSeed.scope.documentGeneration!==all[0].sourceGeneration)throw Error('INVALID_AUTHORITY');const {verifyCurrentSeed}=await import('./current-seed.mjs');verifyCurrentSeed({LoroDoc:runtime.LoroDoc,snapshot:retainedSeed.snapshot,seed:retainedSeed.seed});seedDoc=new runtime.LoroDoc();seedDoc.import(retainedSeed.snapshot);for(const x of retainedSeed.seed.identities)seedIds.set(x.effectId,x.commandId)}
 }
 const order=(a,b)=>{const x=BigInt(a.meta.peer),y=BigInt(b.meta.peer);return x<y?-1:x>y?1:a.startCounter-b.startCounter||a.objectId.localeCompare(b.objectId)};
 const reservedCommands=new Set(seedIds.values());
 const source=new runtime.LoroDoc();if(seedDoc)source.import(retainedSeed.snapshot);const pending=[...all].sort(order),entries=[],commands=new Map(),effects=new Map();let progress=true;
 while(progress){progress=false;for(let i=0;i<pending.length;i++){const e=pending[i];let prior;try{prior=source.forkAt(e.meta.frontiers)}catch{continue}
  try{if(seedIds.has(e.command.effectId)||reservedCommands.has(e.command.commandId))throw Error('CONFLICT');const check=prior.forkAt(e.meta.frontiers),start=check.oplogVersion(),result=check.import(e.update);if(result.pending?.size)continue;validateOperations(e.command,check.exportJsonUpdates(start,undefined,false).changes);checkPreconditions(prior,e.command,{importing:true});const c=commands.get(e.command.commandId),f=effects.get(e.command.effectId);if((c&&!eq(Array.from(bytes(c)),Array.from(bytes(e.command))))||(f&&f!==e.command.commandId))throw Error('CONFLICT');if(c)throw Error('DUPLICATE_COMMAND');commands.set(e.command.commandId,e.command);effects.set(e.command.effectId,e.command.commandId);entries.push({...e,prior:new Set(Object.keys(prior.getMap('domain-effects').toJSON()))});source.import(e.update)}catch(err){held.push({sourceId:e.sourceId,objectId:e.objectId,authorDevice:e.authorDevice,effectId:e.command.effectId,reason:err.message||'INVALID_UPDATE'})}pending.splice(i,1);progress=true;break;
 }}
 for(const e of pending)held.push({sourceId:e.sourceId,objectId:e.objectId,authorDevice:e.authorDevice,effectId:e.command.effectId,reason:'MISSING_ANCESTOR'});
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
 for(const [id,e] of work)if(!selected.has(id)){excluded.push({sourceId:e.sourceId,objectId:e.objectId,authorDevice:e.authorDevice,effectId:id});work.delete(id)}
 const peers=new Set([...cache.values()].flatMap(a=>Object.values(a.scope.authorPeers)));for(const p of source.oplogVersion().toJSON().keys())peers.add(p);
 let seedSnapshot=null;if(seedDoc){let freshPeer;for(let i=0;i<32;i++){const b=crypto.getRandomValues(new Uint8Array(8));let n=0n;for(const x of b)n=(n<<8n)|BigInt(x);if(n&&!peers.has(String(n))){freshPeer=String(n);peers.add(freshPeer);break}}if(!freshPeer)throw Error('PEER_GENERATION_FAILED');const clean=new runtime.LoroDoc();clean.setPeerId(freshPeer);const data=seedDoc.toJSON();for(const name of Object.keys(data).sort())for(const key of Object.keys(data[name]).sort())clean.getMap(name).set(key,data[name][key]);seedSnapshot=clean.export({mode:'snapshot'});out.import(seedSnapshot)}
 const ordered=[...entries].sort(order),assigned=new Map();
 // A fresh contiguous range preserves authenticated original peer ordering for
 // concurrent Loro registers, independently of evidence arrival order.
 if(ordered.length){let base;for(let tries=0;tries<32;tries++){const raw=crypto.getRandomValues(new Uint8Array(8));let n=0n;for(const x of raw)n=(n<<8n)|BigInt(x);n=1n+n%(18446744073709551614n-BigInt(ordered.length));if(ordered.every((_,i)=>!peers.has(String(n+BigInt(i))))){base=n;break}}if(base===undefined)throw Error('PEER_GENERATION_FAILED');ordered.forEach((e,i)=>assigned.set(e.command.effectId,String(base+BigInt(i))))}
 progress=true;
 while(progress){progress=false;for(const [id,e] of work){if(e.command.dependencyEffectIds.some(d=>!branches.has(d)&&!seedIds.has(d))||[...e.prior].some(d=>work.has(d)))continue;const branch=new runtime.LoroDoc();if(seedSnapshot)branch.import(seedSnapshot);for(const [ancestor,snapshot] of branches)if(e.prior.has(ancestor))branch.import(snapshot);branch.setPeerId(assigned.get(id));try{checkPreconditions(branch,e.command,{importing:true});apply(branch,e.command);const snapshot=branch.export({mode:'snapshot'});branches.set(id,snapshot);out.import(snapshot);included.push({sourceId:e.sourceId,authorDevice:e.authorDevice,command:e.command,objectId:e.objectId})}catch(err){held.push({sourceId:e.sourceId,objectId:e.objectId,authorDevice:e.authorDevice,effectId:id,reason:'RECONSTRUCTION_'+(err.message||'INVALID')})}work.delete(id);progress=true;break}}
 for(const e of work.values())held.push({authorDevice:e.authorDevice,effectId:e.command.effectId,objectId:e.objectId,reason:e.command.dependencyEffectIds.some(d=>!selected.has(d))?'DEPENDENCY_EXCLUDED':'MISSING_DEPENDENCY'});
 if(!eq((await runtime.authorization()).expectedAuthority,current.expectedAuthority))throw Error('STALE_AUTHORITY');
 return {doc:out,sourceDocumentId:all[0]?.sourceDocumentId??runtime.scope.documentId,sourceGeneration:all[0]?.sourceGeneration??runtime.scope.documentGeneration,included,excluded,held,complete:false,state:'local-draft'};
}

/** Finalize only a local draft. Publication requires a separate authority procedure. */
export async function finalizeHistoricalDraft(input) { return input.reviews.finalizeHistorical(input); }
