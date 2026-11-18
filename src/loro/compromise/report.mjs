import {resolveHistoricalAuthority} from '../authority/chain.mjs';
import {resolvePersonalAuthority} from '../authority/personal.mjs';
import {domain} from '../authority/validator.mjs';
const enc=new TextEncoder();
const id=x=>typeof x==='string'&&x.length>0&&enc.encode(x).length<=256;
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const canonicalReportBytes=x=>enc.encode(JSON.stringify(canonical(x)));
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export const sameReportValue=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export const evidenceSha256=async value=>hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',value)));
export const manifestDigest=(manifest,sha256=evidenceSha256)=>sha256(canonicalReportBytes(manifest));
export async function resolveEvidenceAuthority(runtime,scope,head,authorDevice) {
 if(scope.kind==='household')return resolveHistoricalAuthority(runtime.storage,scope,runtime.authority.rootPin,runtime.authority.provider,head);
 if(scope.kind==='personal'&&head===runtime.authority.rootPin)return resolvePersonalAuthority(runtime.storage,scope,runtime.authority.rootPin,runtime.authority.provider,authorDevice);
 throw Error('HISTORICAL_HEAD_NOT_SELECTED');
}
/** Exact signed local judgment. Neither verification nor persistence changes authority. */
export function reportMessage(payload){return domain('compromise-report',payload)}
export function validateReport(report,manifest) {
 if(!report||Object.keys(report).sort().join(',')!=='payload,signature'||typeof report.signature!=='string'||! /^[0-9a-f]{128}$/.test(report.signature))throw Error('MALFORMED_REPORT');
 const p=report.payload;
 if(!p||Object.keys(p).sort().join(',')!=='boundary,checkpointHash,head,manifestHash,reportId,reporterDevice,reviewId,scopeId,scopeKind,suspectDeviceIds,version'||p.version!==1||![p.reportId,p.reporterDevice,p.reviewId,p.scopeId,p.head,p.checkpointHash,p.manifestHash].every(id)||!['household','personal'].includes(p.scopeKind)||!Array.isArray(p.suspectDeviceIds)||p.suspectDeviceIds.length>128||!p.suspectDeviceIds.every(id)||new Set(p.suspectDeviceIds).size!==p.suspectDeviceIds.length)throw Error('MALFORMED_REPORT');
 if(!p.boundary||Object.keys(p.boundary).sort().join(',')!=='kind,ref'||!['checkpoint','operation'].includes(p.boundary.kind)||!id(p.boundary.ref)||(p.boundary.kind==='checkpoint'&&p.boundary.ref!==p.checkpointHash)||(p.boundary.kind==='operation'&&!manifest.some(m=>m.objectId===p.boundary.ref)))throw Error('INVALID_BOUNDARY');
 return p;
}
export async function verifyReport({runtime,report,context,reviewId,manifest,sha256=evidenceSha256}) {
 if(!runtime?.authority||!['household','personal'].includes(context.kind)||(runtime.authority.kind??'household')!==context.kind)throw Error('UNSUPPORTED_AUTHORITY');
 const p=validateReport(report,manifest);
 if(p.reviewId!==reviewId||p.scopeId!==context.scopeId||p.scopeKind!==context.kind||p.checkpointHash!==context.checkpointHash)throw Error('MALFORMED_REPORT');
 if(p.manifestHash!==await manifestDigest(manifest,sha256))throw Error('MANIFEST_MISMATCH');
 const expected={revision:context.authorityRevision,acceptedParent:context.authorityHead,authorizationSnapshot:context.authoritySnapshot};
 const current=await runtime.authorization();if(!sameReportValue(current.expectedAuthority.record,expected)||runtime.scope.scopeId!==p.scopeId)throw Error('STALE_AUTHORITY');
 const a=await resolveEvidenceAuthority(runtime,{kind:context.kind,id:p.scopeId},p.head,p.reporterDevice),ref=Object.hasOwn(a.signingKeyRefs,p.reporterDevice)?a.signingKeyRefs[p.reporterDevice]:null;
 if(!ref||!sameReportValue(a.expectedAuthority,current.expectedAuthority))throw Error('INVALID_AUTHORITY');
 const sig=Uint8Array.from(report.signature.match(/../g),x=>parseInt(x,16));
 if(!await runtime.authority.provider.verify(ref,reportMessage(p),sig))throw Error('INVALID_REPORT_SIGNATURE');
 return sha256(canonicalReportBytes(report));
}
