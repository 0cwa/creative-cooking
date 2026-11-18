import {evidenceSha256,sameReportValue,verifyReport} from './report.mjs';
// Local review candidate. This record is a judgment, never a membership change.
const MAX_OBJECTS=256, MAX_BYTES=1024*1024, MAX_OBJECT_BYTES=1024*1024, MAX_DEPENDENCIES=64, MAX_AUTHORITY_HEADS=16;
export const REVIEW_LIMITS=Object.freeze({objects:MAX_OBJECTS,bytes:MAX_BYTES,objectBytes:MAX_OBJECT_BYTES,dependencies:MAX_DEPENDENCIES,authorityHeads:MAX_AUTHORITY_HEADS});
const key=(...p)=>JSON.stringify(p);
const id=x=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=256;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clone=x=>structuredClone(x);
const MAX_SAVED_REPORTS=16;
const originalKey=(scope,review)=>key('compromise-frozen-original',scope,review);
const matchBytes=(a,b)=>a instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const currentAuthority=async(tx,c)=>{
 const a=await tx.get(key('pairing-authority',c.kind,c.scopeId));
 if(!a||a.revision!==c.authorityRevision||a.acceptedParent!==c.authorityHead||a.authorizationSnapshot!==c.authoritySnapshot)throw Error('STALE_AUTHORITY');
};
const bounded=(array,n)=>Array.isArray(array)&&array.length<=n&&Array.from({length:array.length},(_,i)=>Object.hasOwn(array,i)).every(Boolean)&&array.every(id)&&new Set(array).size===array.length;
const validateContext=c=>c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).sort().join(',')==='authorityHead,authorityRevision,authoritySnapshot,checkpointHash,kind,scopeId'&&['household','personal'].includes(c.kind)&&id(c.scopeId)&&id(c.authorityHead)&&id(c.authoritySnapshot)&&Number.isSafeInteger(c.authorityRevision)&&c.authorityRevision>=0&&id(c.checkpointHash);
const reviewKey=(scope,review)=>key('compromise-review',scope,review);
const quarantineKey=(scope,device)=>key('compromise-quarantine',scope,device);
export async function readLocalQuarantine(tx,scopeId,deviceId){
 if(!id(scopeId)||!id(deviceId))throw Error('MALFORMED');
 const value=await tx.get(quarantineKey(scopeId,deviceId));
 if(value!==undefined&&typeof value!=='boolean')throw Error('CORRUPT');
 return value===true;
}
const notifyKey=(scope,source,reason)=>key('compromise-notification',scope,source,reason);
function checked(r){if(!r||r.version!==1||!id(r.reviewId)||!validateContext(r.context)||!Array.isArray(r.manifest)||r.manifest.length>MAX_OBJECTS||!Array.isArray(r.classifications)||!['frozen','classified','selected','local-draft'].includes(r.status))throw Error('CORRUPT');return r}
/** runner is the same SQLite/IndexedDB transaction runner as normal storage. */
export class CompromiseReviews {
 constructor(run,fault){if(typeof run!=='function')throw Error('MALFORMED');this.run=run;this.fault=fault}
 async put(tx,k,v){await tx.put(k,v);this.fault?.('write')}
 async quarantine(scopeId,deviceId,{expectedAuthority,localDeviceId}={}){
  if(!id(scopeId)||!id(deviceId)||localDeviceId===deviceId)throw Error('MALFORMED');
  expectedAuthority=clone(expectedAuthority);
  return this.run(true,async tx=>{
   if(expectedAuthority){
    const {scope,record}=expectedAuthority;
    if(scope?.kind!=='household'||scope.id!==scopeId||!record||!id(localDeviceId))throw Error('MALFORMED');
    const current=await tx.get(key('pairing-authority',scope.kind,scopeId));
    if(current?.scope?.kind!==scope.kind||current.scope.id!==scopeId||current.revision!==record.revision||
      current.acceptedParent!==record.acceptedParent||current.authorizationSnapshot!==record.authorizationSnapshot)throw Error('STALE_AUTHORITY');
   }
   if(!await readLocalQuarantine(tx,scopeId,deviceId))await this.put(tx,quarantineKey(scopeId,deviceId),true);
   return {quarantined:true};
  });
 }
 async isQuarantined(scopeId,deviceId){return this.run(false,tx=>readLocalQuarantine(tx,scopeId,deviceId))}
 /** Explicit bounded quarantine intake. Capacity never evicts acknowledged work. */
 async stageEvidence({scopeId,sourceId,objectId,bytes,frozenReview}){
  if(frozenReview)return this.freeze({...frozenReview,isolated:true,requireStored:false});
  if(!id(scopeId)||!id(sourceId)||!id(objectId)||!(bytes instanceof Uint8Array))throw Error('MALFORMED');
  if(bytes.length>MAX_OBJECT_BYTES||bytes.length>MAX_BYTES)return {accepted:false,reason:'TOO_LARGE'};
  bytes=new Uint8Array(bytes);return this.run(true,async tx=>{const usageKey=key('compromise-intake',scopeId,sourceId),itemKey=key('compromise-intake-item',scopeId,sourceId,objectId),inboxKey=key('inbox',scopeId,objectId),usage=await tx.get(usageKey),prior=await tx.get(itemKey),stored=await tx.get(inboxKey);
   if(prior!==undefined){if(!stored||!(stored.bytes instanceof Uint8Array)||stored.bytes.length!==bytes.length||!stored.bytes.every((x,i)=>x===bytes[i]))throw Error('CONFLICT');return {accepted:true,replayed:true}}
   if(stored!==undefined&&(!(stored.bytes instanceof Uint8Array)||stored.bytes.length!==bytes.length||!stored.bytes.every((x,i)=>x===bytes[i])))throw Error('CONFLICT');
   if(!usage){const sources=(await tx.keys()).filter(k=>{try{const p=JSON.parse(k);return p[0]==='compromise-intake'&&p[1]===scopeId}catch{return false}}).length;if(sources>=64)return {accepted:false,reason:'CAPACITY'}}
   const count=usage?.count??0,total=usage?.bytes??0;if(!Number.isSafeInteger(count)||!Number.isSafeInteger(total)||count<0||total<0)throw Error('CORRUPT');if(count>=MAX_OBJECTS||total+bytes.length>MAX_BYTES)return {accepted:false,reason:'CAPACITY'};
   if(!stored)await this.put(tx,inboxKey,{bytes});await this.put(tx,itemKey,true);await this.put(tx,usageKey,{count:count+1,bytes:total+bytes.length});return {accepted:true,replayed:false};
  })
 }
 /** Input bytes are measured before hashing or cryptographic parsing. Existing sources retain ownership of all bytes. */
 async freeze({reviewId,context,report,runtime,objects,checkpointBytes,sha256=evidenceSha256,isolated=false,requireStored=true,expectedManifest,verifyEvidence}){
  if(!id(reviewId)||!validateContext(context)||!report||!runtime||!Array.isArray(objects)||!(checkpointBytes instanceof Uint8Array))throw Error('MALFORMED');
  if(objects.length>MAX_OBJECTS||checkpointBytes.byteLength>MAX_OBJECT_BYTES)throw Error('TOO_LARGE');
  let size=checkpointBytes.byteLength;const names=new Set();
  for(const o of objects){if(!o||!['outbound','inbox'].includes(o.sourceId)||!id(o.objectId)||!(o.bytes instanceof Uint8Array))throw Error('MALFORMED');const k=key(o.sourceId,o.objectId);if(names.has(k))throw Error('CONFLICT');names.add(k);if(o.bytes.byteLength>MAX_OBJECT_BYTES)throw Error('TOO_LARGE');size+=o.bytes.byteLength;if(size>MAX_BYTES)throw Error('TOO_LARGE')}
  objects=objects.map(o=>({...o,bytes:new Uint8Array(o.bytes)}));checkpointBytes=new Uint8Array(checkpointBytes);context=clone(context);report=clone(report);expectedManifest=clone(expectedManifest);
  if(isolated)await this.preflightReport(context.scopeId,reviewId);
  if(await sha256(checkpointBytes)!==context.checkpointHash)throw Error('CHECKPOINT_MISMATCH');
  const manifest=[];for(const o of objects)manifest.push({sourceId:o.sourceId,objectId:o.objectId,bytes:o.bytes.byteLength,hash:await sha256(o.bytes)});
  if(expectedManifest&&(manifest.length!==expectedManifest.length||manifest.some((m,i)=>!sameReportValue(m,expectedManifest[i]))))throw Error('MANIFEST_MISMATCH');
  const reportHash=await verifyReport({runtime,report,context,reviewId,manifest,sha256});
  await verifyEvidence?.(objects);
  const r={version:1,reviewId,context:clone(context),report:clone(report),reportHash,manifest,measuredBytes:size,classifications:[],selection:null,draft:null,status:'frozen',complete:false,...(isolated?{isolated:true}:{})};
  return this.run(true,async tx=>{
   await currentAuthority(tx,context);
   if(requireStored)for(const o of objects){
    const stored=await tx.get(key(o.sourceId==='outbound'?'object':'inbox',context.scopeId,o.objectId));
    if(!matchBytes(stored?.bytes,o.bytes))throw Error('MISSING_OBJECT');
   }
   const k=reviewKey(context.scopeId,reviewId),old=await tx.get(k);
   if(old!==undefined){
    checked(old);
    if(!same(old.context,r.context)||old.reportHash!==r.reportHash||!sameReportValue(old.report,r.report)||!same(old.manifest,r.manifest)||!!old.isolated!==isolated)throw Error('CONFLICT');
    if(isolated){
     const originals=await tx.get(originalKey(context.scopeId,reviewId));
     if(!matchBytes(originals?.checkpoint,checkpointBytes)||!Array.isArray(originals.objects)||originals.objects.length!==objects.length||!objects.every((o,i)=>matchBytes(originals.objects[i],o.bytes)))throw Error('CONFLICT');
    }
    return isolated?{review:clone(old),replayed:true}:clone(old);
   }
   if(isolated){
    const originals=originalKey(context.scopeId,reviewId);
    await this.#checkReportCapacity(tx,context.scopeId,reviewId);
    await this.put(tx,originals,{objects:objects.map(o=>o.bytes),checkpoint:checkpointBytes});
   }
   await this.put(tx,k,r);
   return isolated?{review:clone(r),replayed:false}:clone(r);
  });
 }
 async #checkReportCapacity(tx,scopeId,reviewId){
  const prefix=key('compromise-frozen-original',scopeId).slice(0,-1)+',';
  const keys=(await tx.keys()).filter(k=>k.startsWith(prefix));
  if(!keys.includes(originalKey(scopeId,reviewId))&&keys.length>=MAX_SAVED_REPORTS)throw Error('REPORT_CAPACITY');
 }
 async preflightReport(scopeId,reviewId){
  if(!id(scopeId)||!id(reviewId))throw Error('MALFORMED');
  return this.run(false,tx=>this.#checkReportCapacity(tx,scopeId,reviewId));
 }
 async listReports(scopeId){
  if(!id(scopeId))throw Error('MALFORMED');
  const prefix=key('compromise-frozen-original',scopeId).slice(0,-1)+',';
  return this.run(false,async tx=>{
   const keys=(await tx.keys()).filter(k=>k.startsWith(prefix));
   if(keys.length>MAX_SAVED_REPORTS)throw Error('CORRUPT');
   return Promise.all(keys.map(async k=>{
    const [, , reviewId]=JSON.parse(k);
    const r=checked(await tx.get(reviewKey(scopeId,reviewId)));
    return {reviewId,report:clone(r.report),count:r.manifest.length};
   }));
  });
 }
 // Read a bounded candidate set without copying all retained cooking blobs into the app.
 async reviewCandidates(scopeId){
  if(!id(scopeId))throw Error('MALFORMED');
  return this.run(false,async tx=>{
   const keys=(await tx.keys()).sort(),objects=[],seen=new Set();
   let size=0;
   for(const namespace of ['object','inbox']){
    const prefix=key(namespace,scopeId).slice(0,-1)+',';
    for(const k of keys){
     if(!k.startsWith(prefix))continue;
     const [, , objectId]=JSON.parse(k);
     if(seen.has(objectId))continue;
     if(objects.length>=MAX_OBJECTS)return {objects,truncated:true};
     const value=await tx.get(k);
     if(!(value?.bytes instanceof Uint8Array))throw Error('CORRUPT');
     size+=value.bytes.length;
     if(size>MAX_BYTES||value.bytes.length>MAX_OBJECT_BYTES)return {objects,truncated:true};
     seen.add(objectId);
     objects.push({sourceId:namespace==='object'?'outbound':'inbox',objectId,bytes:value.bytes});
    }
   }
   return {objects,truncated:false};
  });
 }
 async get(scopeId,reviewId){if(!id(scopeId)||!id(reviewId))throw Error('MALFORMED');return this.run(false,async tx=>{const r=await tx.get(reviewKey(scopeId,reviewId));return r===undefined?null:clone(checked(r))})}
 /** Explicit local inspection/export of original encrypted bytes; no new audience grant. */
 async inspectOriginal(scopeId,reviewId,sha256=evidenceSha256){
  const review=await this.get(scopeId,reviewId);if(!review)throw Error('NOT_FOUND');const objects=[],missing=[];
  const isolated=review.isolated?await this.run(false,tx=>tx.get(originalKey(scopeId,reviewId))):null;
  for(const [i,m] of review.manifest.entries()){const namespace=m.sourceId==='outbound'?'object':m.sourceId==='inbox'?'inbox':null;if(!namespace){missing.push({sourceId:m.sourceId,objectId:m.objectId,reason:'SOURCE_UNAVAILABLE'});continue}
   const record=review.isolated?{bytes:isolated?.objects?.[i]}:await this.run(false,tx=>tx.get(key(namespace,scopeId,m.objectId)));if(!record||!(record.bytes instanceof Uint8Array)){missing.push({sourceId:m.sourceId,objectId:m.objectId,reason:'MISSING_OBJECT'});continue}
   if(record.bytes.length!==m.bytes||record.bytes.length>MAX_OBJECT_BYTES||await sha256(record.bytes)!==m.hash){missing.push({sourceId:m.sourceId,objectId:m.objectId,reason:'SOURCE_CHANGED'});continue}
   objects.push({sourceId:m.sourceId,objectId:m.objectId,bytes:new Uint8Array(record.bytes)});
  }
  const checkpoint=isolated?.checkpoint;
  const checkpointBytes=checkpoint instanceof Uint8Array&&checkpoint.length<=MAX_BYTES&&
   await sha256(checkpoint)===review.context.checkpointHash?checkpoint:null;
  return {reviewId,report:clone(review.report),manifest:clone(review.manifest),objects,missing,complete:false,checkpointBytes};
 }
 /** A repeated source/reason is notified at most once; summary contains no input bytes. */
 async noteRejected(scopeId,sourceId,reason){if(!id(scopeId)||!id(sourceId)||!['TOO_LARGE','CAPACITY','MISSING_EVIDENCE'].includes(reason))throw Error('MALFORMED');return this.run(true,async tx=>{const k=notifyKey(scopeId,sourceId,reason);if(await tx.get(k)!==undefined)return false;const count=(await tx.keys()).filter(x=>{try{const p=JSON.parse(x);return p[0]==='compromise-notification'&&p[1]===scopeId}catch{return false}}).length;if(count>=256)return false;await this.put(tx,k,true);return true})}
 async classify(scopeId,reviewId,items){if(!bounded(items?.map(x=>x.effectId),MAX_OBJECTS)||!items.every(x=>id(x.authorDevice)&&bounded(x.dependencies,MAX_DEPENDENCIES)&&['eligible','suspect','dependent','missing'].includes(x.category)))throw Error('MALFORMED');return this.run(true,async tx=>{const k=reviewKey(scopeId,reviewId),r=checked(await tx.get(k));if(r.status!=='frozen'&&r.status!=='classified')throw Error('CONFLICT');r.classifications=clone(items);r.status='classified';await this.put(tx,k,r);return clone(r)})}
 async select(scopeId,reviewId,effects){if(!bounded(effects,MAX_OBJECTS))throw Error('MALFORMED');return this.run(true,async tx=>{const k=reviewKey(scopeId,reviewId),r=checked(await tx.get(k));if(r.status!=='classified')throw Error('CONFLICT');const known=new Set(r.classifications.map(x=>x.effectId));if(effects.some(x=>!known.has(x)))throw Error('UNKNOWN_EFFECT');r.selection={effects:[...effects],context:clone(r.context),manifest:clone(r.manifest)};r.status='selected';await this.put(tx,k,r);return clone(r)})}
 /** Called after authenticated reconstruction; compare review and selected authority in the same transaction. */
 async #installLocalDraft(scopeId,reviewId,expected,selection,original,{documentId,sourceDocumentId,sourceGeneration,publicationBaseDocumentId,base,snapshot,included,excluded,held}) {
  if(!id(documentId)||!id(sourceDocumentId)||!id(publicationBaseDocumentId)||!Number.isSafeInteger(sourceGeneration)||sourceGeneration<0||documentId===sourceDocumentId||documentId===publicationBaseDocumentId||!(snapshot instanceof Uint8Array)||snapshot.length>MAX_BYTES||!Array.isArray(included)||!Array.isArray(excluded)||!Array.isArray(held))throw Error('MALFORMED');
  return this.run(true,async tx=>{
   const k=reviewKey(scopeId,reviewId),r=checked(await tx.get(k));
   if(!same(r,expected))throw Error('STALE_REVIEW');
   await currentAuthority(tx,r.context);
   if(base!==undefined){
    const current=await tx.get(key('document',scopeId,publicationBaseDocumentId));
    const owner=await tx.get(key('document-owner',scopeId,publicationBaseDocumentId));
    if((current?.revision??null)!==(base?.revision??null)||
       (base?owner!==r.context.authorityHead||!matchBytes(current?.bytes,base.bytes):current!==undefined||owner!==undefined))throw Error('STALE_DOCUMENT');
   }
   if(r.isolated){
    const stored=await tx.get(originalKey(scopeId,reviewId));
    if(!matchBytes(stored?.checkpoint,original.checkpoint)||!Array.isArray(stored?.objects)||
       stored.objects.length!==original.objects.length||!original.objects.every((o,i)=>matchBytes(stored.objects[i],o.bytes)))throw Error('STALE_EVIDENCE');
   }
   r.selection=clone(selection);
   r.draft={documentId,sourceDocumentId,sourceGeneration,publicationBaseDocumentId,
    ...(base===undefined?{}:{publicationBaseRevision:base?.revision??null}),
    snapshot:new Uint8Array(snapshot),included:clone(included),excluded:clone(excluded),held:clone(held),state:'local-draft'};
   r.status='local-draft';
   await this.put(tx,k,r);
   return clone(r);
  });
 }

 /** Prepare a separately scoped current-state-only copy, never the old-audience archive. */
 async prepareCurrentSeed({runtime,scopeId,reviewId}){
  const before=await this.get(scopeId,reviewId);if(!before||before.status!=='local-draft'||before.context.scopeId!==scopeId||runtime.scope.scopeId!==scopeId)throw Error('INVALID_DRAFT');
  const authority=await runtime.authorization(),c=before.context;if(authority.expectedAuthority.record.revision!==c.authorityRevision||authority.expectedAuthority.record.acceptedParent!==c.authorityHead||authority.expectedAuthority.record.authorizationSnapshot!==c.authoritySnapshot)throw Error('STALE_AUTHORITY');if(before.draft.currentSeed)return clone(before.draft.currentSeed);
  const source=new runtime.LoroDoc();source.import(before.draft.snapshot);const current=(await runtime.document()).doc;const forbidden=new Set([...source.oplogVersion().toJSON().keys(),...current.oplogVersion().toJSON().keys(),...Object.values(runtime.scope.authorPeers)]);let peerId;for(let i=0;i<32;i++){const b=crypto.getRandomValues(new Uint8Array(8));let v=0n;for(const x of b)v=(v<<8n)|BigInt(x);if(v&&!forbidden.has(String(v))){peerId=String(v);break}}if(!peerId)throw Error('PEER_GENERATION_FAILED');
  const {projectCurrentSeed}=await import('./current-seed.mjs'),seed=projectCurrentSeed({LoroDoc:runtime.LoroDoc,source:before.draft.snapshot,seedId:crypto.randomUUID(),peerId});
  return this.run(true,async tx=>{const k=reviewKey(scopeId,reviewId),r=checked(await tx.get(k)),a=await tx.get(key('pairing-authority',c.kind,c.scopeId));if(!same(r,before))throw Error('STALE_REVIEW');if(!a||a.revision!==c.authorityRevision||a.acceptedParent!==c.authorityHead||a.authorizationSnapshot!==c.authoritySnapshot)throw Error('STALE_AUTHORITY');r.draft.currentSeed=seed;await this.put(tx,k,r);return clone(seed)})
 }
 async finalizeHistorical(input) {
  if(input.reviews!==this)throw Error('MALFORMED');
  const {runtime,scopeId,reviewId,expectedDocumentRevision}=input;
  const expected=clone(input.expected);
  const selectedEffectIds=clone(input.selectedEffectIds);
  const before=await this.get(scopeId,reviewId);
  if(!before||!bounded(selectedEffectIds,MAX_OBJECTS))throw Error('INVALID_SELECTION');
  const authority=await runtime.authorize();
  if(before.status==='local-draft'&&before.isolated&&expected)return this.run(false,async tx=>{
   const saved=checked(await tx.get(reviewKey(scopeId,reviewId)));
   if(!same(saved,before)||!same(saved.selection,{effects:selectedEffectIds,context:expected.context,manifest:expected.manifest}))throw Error('STALE_REVIEW');
   const c=saved.context,baseId=runtime.scope.documentId;
   if(authority.scope.kind!==c.kind||authority.scope.id!==c.scopeId||
      authority.record.acceptedParent!==c.authorityHead||authority.record.revision!==c.authorityRevision||
      authority.record.authorizationSnapshot!==c.authoritySnapshot)throw Error('STALE_AUTHORITY');
   await currentAuthority(tx,c);
   const current=await tx.get(key('document',scopeId,baseId));
   const owner=await tx.get(key('document-owner',scopeId,baseId));
   if(saved.draft.publicationBaseDocumentId!==baseId||(current?.revision??null)!==expectedDocumentRevision||
      (current?owner!==c.authorityHead:owner!==undefined))throw Error('STALE_DOCUMENT');
   if(!Object.hasOwn(saved.draft,'publicationBaseRevision')||
      saved.draft.publicationBaseRevision!==expectedDocumentRevision)throw Error('DRAFT_SOURCE_CHANGED');
   const {documentId,included,excluded,held}=saved.draft;
   return clone({documentId,status:saved.status,included,excluded,held});
  });
  if(expected&&(!before.isolated||before.status!=='frozen'||!same(before,expected)))throw Error('STALE_REVIEW');
  let base;
  if(expected){
   const stored=await runtime.storage.reopenBranchDocument(authority,runtime.scope.documentId);
   if(!stored.ok)throw Error(stored.error?.code??stored.error);
   base=stored.value;
   if((base?.revision??null)!==expectedDocumentRevision)throw Error('STALE_DOCUMENT');
  }
  const selection=expected?{effects:selectedEffectIds,context:before.context,manifest:before.manifest}:before.selection;
  const {reconstructSelected}=await import('./historical.mjs');
  const objects=clone(input.objects),checkpoint=clone(input.checkpoint);
  const result=await reconstructSelected({...input,objects,checkpoint,selectedEffectIds,review:expected?{...before,status:'selected',selection}:before});
  const documentId=input.randomUUID?.()??crypto.randomUUID();
  const saved=await this.#installLocalDraft(scopeId,reviewId,before,selection,{objects,checkpoint},{documentId,
   sourceDocumentId:result.sourceDocumentId,sourceGeneration:result.sourceGeneration,publicationBaseDocumentId:runtime.scope.documentId,base,
   snapshot:result.doc.export({mode:'snapshot'}),included:result.included,excluded:result.excluded,held:result.held});
  return {documentId,status:saved.status,included:result.included,excluded:result.excluded,held:result.held};
 }

}
