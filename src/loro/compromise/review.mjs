// Local review candidate. This record is a judgment, never a membership change.
const MAX_OBJECTS=256, MAX_BYTES=1024*1024, MAX_OBJECT_BYTES=1024*1024, MAX_DEPENDENCIES=64, MAX_AUTHORITY_HEADS=16;
export const REVIEW_LIMITS=Object.freeze({objects:MAX_OBJECTS,bytes:MAX_BYTES,objectBytes:MAX_OBJECT_BYTES,dependencies:MAX_DEPENDENCIES,authorityHeads:MAX_AUTHORITY_HEADS});
const key=(...p)=>JSON.stringify(p);
const id=x=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=256;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clone=x=>structuredClone(x);
const hash=async b=>Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
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
 async stageEvidence({scopeId,sourceId,objectId,bytes}){
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
 async freeze({reviewId,context,report,runtime,objects,checkpointBytes}){
  if(!id(reviewId)||!validateContext(context)||!report||!runtime||!Array.isArray(objects)||!(checkpointBytes instanceof Uint8Array))throw Error('MALFORMED');
  if(objects.length>MAX_OBJECTS||checkpointBytes.byteLength>MAX_OBJECT_BYTES)throw Error('TOO_LARGE');
  let size=checkpointBytes.byteLength;const names=new Set();
  for(const o of objects){if(!o||!['outbound','inbox'].includes(o.sourceId)||!id(o.objectId)||!(o.bytes instanceof Uint8Array))throw Error('MALFORMED');const k=key(o.sourceId,o.objectId);if(names.has(k))throw Error('CONFLICT');names.add(k);if(o.bytes.byteLength>MAX_OBJECT_BYTES)throw Error('TOO_LARGE');size+=o.bytes.byteLength;if(size>MAX_BYTES)throw Error('TOO_LARGE')}
  objects=objects.map(o=>({...o,bytes:new Uint8Array(o.bytes)}));checkpointBytes=new Uint8Array(checkpointBytes);context=clone(context);report=clone(report);
  if(await hash(checkpointBytes)!==context.checkpointHash)throw Error('CHECKPOINT_MISMATCH');
  const manifest=[];for(const o of objects)manifest.push({sourceId:o.sourceId,objectId:o.objectId,bytes:o.bytes.byteLength,hash:await hash(o.bytes)});
  const {verifyReport}=await import('./report.mjs');const reportHash=await verifyReport({runtime,report,context,reviewId,manifest});
  const r={version:1,reviewId,context:clone(context),report:clone(report),reportHash,manifest,measuredBytes:size,classifications:[],selection:null,draft:null,status:'frozen',complete:false};
  return this.run(true,async tx=>{const a=await tx.get(key('pairing-authority',context.kind,context.scopeId));if(!a||a.revision!==context.authorityRevision||a.acceptedParent!==context.authorityHead||a.authorizationSnapshot!==context.authoritySnapshot)throw Error('STALE_AUTHORITY');for(const o of objects){const stored=await tx.get(key(o.sourceId==='outbound'?'object':'inbox',context.scopeId,o.objectId));if(!stored||!(stored.bytes instanceof Uint8Array)||stored.bytes.length!==o.bytes.length||!stored.bytes.every((x,i)=>x===o.bytes[i]))throw Error('MISSING_OBJECT')}const k=reviewKey(context.scopeId,reviewId),old=await tx.get(k);if(old!==undefined){checked(old);if(!same(old.context,r.context)||old.reportHash!==r.reportHash||!same(old.report,r.report)||!same(old.manifest,r.manifest))throw Error('CONFLICT');return clone(old)}await this.put(tx,k,r);return clone(r)})
 }
 async get(scopeId,reviewId){if(!id(scopeId)||!id(reviewId))throw Error('MALFORMED');return this.run(false,async tx=>{const r=await tx.get(reviewKey(scopeId,reviewId));return r===undefined?null:clone(checked(r))})}
 /** Explicit local inspection/export of original encrypted bytes; no new audience grant. */
 async inspectOriginal(scopeId,reviewId){
  const review=await this.get(scopeId,reviewId);if(!review)throw Error('NOT_FOUND');const objects=[],missing=[];
  for(const m of review.manifest){const namespace=m.sourceId==='outbound'?'object':m.sourceId==='inbox'?'inbox':null;if(!namespace){missing.push({sourceId:m.sourceId,objectId:m.objectId,reason:'SOURCE_UNAVAILABLE'});continue}
   const record=await this.run(false,tx=>tx.get(key(namespace,scopeId,m.objectId)));if(!record||!(record.bytes instanceof Uint8Array)){missing.push({sourceId:m.sourceId,objectId:m.objectId,reason:'MISSING_OBJECT'});continue}
   if(record.bytes.length!==m.bytes||record.bytes.length>MAX_OBJECT_BYTES||await hash(record.bytes)!==m.hash){missing.push({sourceId:m.sourceId,objectId:m.objectId,reason:'SOURCE_CHANGED'});continue}
   objects.push({sourceId:m.sourceId,objectId:m.objectId,bytes:new Uint8Array(record.bytes)});
  }return {reviewId,report:clone(review.report),manifest:clone(review.manifest),objects,missing,complete:false};
 }
 /** A repeated source/reason is notified at most once; summary contains no input bytes. */
 async noteRejected(scopeId,sourceId,reason){if(!id(scopeId)||!id(sourceId)||!['TOO_LARGE','CAPACITY','MISSING_EVIDENCE'].includes(reason))throw Error('MALFORMED');return this.run(true,async tx=>{const k=notifyKey(scopeId,sourceId,reason);if(await tx.get(k)!==undefined)return false;const count=(await tx.keys()).filter(x=>{try{const p=JSON.parse(x);return p[0]==='compromise-notification'&&p[1]===scopeId}catch{return false}}).length;if(count>=256)return false;await this.put(tx,k,true);return true})}
 async classify(scopeId,reviewId,items){if(!bounded(items?.map(x=>x.effectId),MAX_OBJECTS)||!items.every(x=>id(x.authorDevice)&&bounded(x.dependencies,MAX_DEPENDENCIES)&&['eligible','suspect','dependent','missing'].includes(x.category)))throw Error('MALFORMED');return this.run(true,async tx=>{const k=reviewKey(scopeId,reviewId),r=checked(await tx.get(k));if(r.status!=='frozen'&&r.status!=='classified')throw Error('CONFLICT');r.classifications=clone(items);r.status='classified';await this.put(tx,k,r);return clone(r)})}
 async select(scopeId,reviewId,effects){if(!bounded(effects,MAX_OBJECTS))throw Error('MALFORMED');return this.run(true,async tx=>{const k=reviewKey(scopeId,reviewId),r=checked(await tx.get(k));if(r.status!=='classified')throw Error('CONFLICT');const known=new Set(r.classifications.map(x=>x.effectId));if(effects.some(x=>!known.has(x)))throw Error('UNKNOWN_EFFECT');r.selection={effects:[...effects],context:clone(r.context),manifest:clone(r.manifest)};r.status='selected';await this.put(tx,k,r);return clone(r)})}
 /** Called after authenticated reconstruction; compare review and selected authority in the same transaction. */
 async #installLocalDraft(scopeId,reviewId,expected,{documentId,sourceDocumentId,sourceGeneration,publicationBaseDocumentId,snapshot,included,excluded,held}) {
  if(!id(documentId)||!id(sourceDocumentId)||!id(publicationBaseDocumentId)||!Number.isSafeInteger(sourceGeneration)||sourceGeneration<0||documentId===sourceDocumentId||documentId===publicationBaseDocumentId||!(snapshot instanceof Uint8Array)||snapshot.length>MAX_BYTES||!Array.isArray(included)||!Array.isArray(excluded)||!Array.isArray(held))throw Error('MALFORMED');
  return this.run(true,async tx=>{const k=reviewKey(scopeId,reviewId),r=checked(await tx.get(k));if(r.status!=='selected'||!same(r,expected))throw Error('STALE_REVIEW');const c=r.context,a=await tx.get(key('pairing-authority',c.kind,c.scopeId));if(!a||a.revision!==c.authorityRevision||a.acceptedParent!==c.authorityHead||a.authorizationSnapshot!==c.authoritySnapshot)throw Error('STALE_AUTHORITY');r.draft={documentId,sourceDocumentId,sourceGeneration,publicationBaseDocumentId,snapshot:new Uint8Array(snapshot),included:clone(included),excluded:clone(excluded),held:clone(held),state:'local-draft'};r.status='local-draft';await this.put(tx,k,r);return clone(r)})
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
  const before=await this.get(input.scopeId,input.reviewId);
  const {reconstructHistorical}=await import('./historical.mjs');
  const result=await reconstructHistorical(input),documentId=crypto.randomUUID();
  const saved=await this.#installLocalDraft(input.scopeId,input.reviewId,before,{documentId,sourceDocumentId:result.sourceDocumentId,sourceGeneration:result.sourceGeneration,publicationBaseDocumentId:input.runtime.scope.documentId,snapshot:result.doc.export({mode:'snapshot'}),included:result.included,excluded:result.excluded,held:result.held});
  return {documentId,status:saved.status,included:result.included,excluded:result.excluded,held:result.held};
 }

}
