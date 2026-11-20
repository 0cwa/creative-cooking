import {domain} from '../authority/validator.mjs';
import {verifySelectedSourceSet} from '../projection/selected-sources.mjs';
import {verifySelectedEvidence} from './selected-evidence.mjs';
import {canonicalReportBytes,evidenceSha256,sameReportValue} from './report.mjs';
import {REVIEW_LIMITS} from './review.mjs';

const encoder=new TextEncoder();
const id=x=>typeof x==='string'&&x.length>0&&encoder.encode(x).length<=256;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const dense=x=>Array.isArray(x)&&Array.from({length:x.length},(_,i)=>Object.hasOwn(x,i)).every(Boolean);
const signature=x=>typeof x==='string'&&/^[a-f0-9]{128}$/.test(x);
const hex=x=>Array.from(x,b=>b.toString(16).padStart(2,'0')).join('');
const message=p=>domain('compromise-selected-operation-report-v2',p);

// Bound and freeze the caller's originals before observations or cryptography.
function freeze(candidates) {
 if(!dense(candidates)||!candidates.length||candidates.length>REVIEW_LIMITS.objects)throw Error('TOO_LARGE');
 let total=0;const ids=new Set();
 return candidates.map(o=>{
  if(!o||!id(o.sourceId)||!id(o.documentId)||!id(o.objectId)||!(o.bytes instanceof Uint8Array)||!o.bytes.length)throw Error('MALFORMED');
  if(ids.has(o.objectId))throw Error('DUPLICATE_EVIDENCE');ids.add(o.objectId);
  total+=o.bytes.length;if(o.bytes.length>REVIEW_LIMITS.objectBytes||total>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');
  return {sourceId:o.sourceId,documentId:o.documentId,objectId:o.objectId,bytes:new Uint8Array(o.bytes)};
 });
}
function validateReport(report,count) {
 if(!exact(report,['payload','signature'])||!signature(report.signature))throw Error('MALFORMED_REPORT');
 const p=report.payload;
 if(!exact(p,['version','scopeId','rootPin','head','authorizationSnapshot','reporterDevice','suspectDevice','boundary','observation','objects'])||p.version!==2||![p.scopeId,p.rootPin,p.head,p.authorizationSnapshot,p.reporterDevice,p.suspectDevice].every(id)||!exact(p.boundary,['documentId','objectId'])||![p.boundary.documentId,p.boundary.objectId].every(id)||!dense(p.objects)||p.objects.length!==count||!p.objects.length||p.objects.length>REVIEW_LIMITS.objects)throw Error('MALFORMED_REPORT');
 if(!exact(p.observation,['manifest','deviceId','signature'])||!id(p.observation.deviceId)||!signature(p.observation.signature))throw Error('MALFORMED_REPORT');
 // Bound the signed observation before processing it; source-set validation checks its schema.
 if(canonicalReportBytes(p.observation).length>REVIEW_LIMITS.objectBytes)throw Error('TOO_LARGE');
 const ids=new Set();for(const o of p.objects){if(!exact(o,['documentId','objectId','digest'])||!id(o.documentId)||!id(o.objectId)||!digest(o.digest))throw Error('MALFORMED_REPORT');if(ids.has(o.objectId))throw Error('DUPLICATE_EVIDENCE');ids.add(o.objectId);}
 if(!p.objects.some(o=>o.documentId===p.boundary.documentId&&o.objectId===p.boundary.objectId))throw Error('INVALID_BOUNDARY');
 return p;
}
async function checkGuard(runtime,guard) {const result=await runtime.storage.checkSelectedHouseholdSources(guard);if(!result.ok)throw Error(result.error.code);}
async function commitments(results) {return Promise.all(results.map(async row=>({documentId:row.documentId,objectId:row.evidence.objectId,digest:await evidenceSha256(row.bytes)})));}
async function authenticated(runtime,batch) {
 const observed=await verifySelectedEvidence(runtime,batch);
 if(observed.results.some(row=>row.status!=='verified'))throw Error('UNVERIFIED_EVIDENCE');
 return observed;
}
function context(runtime,auth,reporter,suspect) {
 const s=runtime.scope,record=auth.expectedAuthority.record;
 if((runtime.authority.kind??'household')!=='household'||!id(runtime.authority.rootPin)||!id(reporter)||!id(suspect)||!s.acceptedAuthors.includes(reporter)||!s.acceptedAuthors.includes(suspect)||!Object.hasOwn(auth.signingKeyRefs,reporter)||!Object.hasOwn(auth.signingKeyRefs,suspect))throw Error('INVALID_AUTHORITY');
 return {scopeId:s.scopeId,rootPin:runtime.authority.rootPin,head:s.branchHead,authorizationSnapshot:record.authorizationSnapshot,reporterDevice:reporter,suspectDevice:suspect};
}

/** A signed judgment about one operation, not a claim of complete history or a clean checkpoint. */
export async function buildSelectedOperationReport(runtime,{candidates,suspectDevice,boundary}) {
 const batch=freeze(candidates);
 if(!exact(boundary,['documentId','objectId'])||!id(boundary.documentId)||!id(boundary.objectId)||!batch.some(o=>o.documentId===boundary.documentId&&o.objectId===boundary.objectId))throw Error('INVALID_BOUNDARY');
 boundary={documentId:boundary.documentId,objectId:boundary.objectId};
 const auth=await runtime.authorization(),reporter=runtime.scope.authorDevice,base=context(runtime,auth,reporter,suspectDevice);
 const observed=await authenticated(runtime,batch);
 const payload={version:2,...base,boundary,observation:observed.signed,objects:await commitments(observed.results)};
 const sig=await runtime.authority.provider.sign(auth.signingKeyRefs[reporter],message(payload));
 if(!(sig instanceof Uint8Array)||sig.length!==64)throw Error('INVALID_REPORT_SIGNATURE');
 const report={payload,signature:hex(sig)};
 await checkGuard(runtime,observed.guard);
 return {report,candidates:batch,evidence:observed.results,guard:observed.guard};
}

/** Verify the exact signed report and frozen originals against the current selected set. */
export async function verifySelectedOperationReport(runtime,{report,candidates}) {
 const batch=freeze(candidates);report=structuredClone(report);
 const p=validateReport(report,batch.length);
 const auth=await runtime.authorization(),base=context(runtime,auth,p.reporterDevice,p.suspectDevice);
 for(const [key,value] of Object.entries(base))if(p[key]!==value)throw Error('STALE_AUTHORITY');
 for(let i=0;i<batch.length;i++)if(p.objects[i].documentId!==batch[i].documentId||p.objects[i].objectId!==batch[i].objectId)throw Error('EVIDENCE_MISMATCH');
 // Compare digests before the more expensive source-set and envelope checks.
 for(let i=0;i<batch.length;i++)if(p.objects[i].digest!==await evidenceSha256(batch[i].bytes))throw Error('EVIDENCE_MISMATCH');
 const provider=runtime.authority.provider;
 if(!await provider.verify(auth.signingKeyRefs[p.reporterDevice],message(p),Uint8Array.from(report.signature.match(/../g),b=>parseInt(b,16))))throw Error('INVALID_REPORT_SIGNATURE');
 await verifySelectedSourceSet({storage:runtime.storage,scope:auth.expectedAuthority.scope,pin:base.rootPin,provider,signed:p.observation});
 const observed=await authenticated(runtime,batch);
 if(!sameReportValue(p.observation.manifest,observed.signed.manifest))throw Error('STALE_SOURCE');
 await checkGuard(runtime,observed.guard);
 return {report,evidence:observed.results,guard:observed.guard};
}
