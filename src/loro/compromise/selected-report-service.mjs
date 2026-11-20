import {canonicalReportBytes,evidenceSha256} from './report.mjs';
import {verifySelectedOperationReport} from './selected-report.mjs';
import {REVIEW_LIMITS} from './review.mjs';

const must=result=>{if(!result.ok)throw Error(result.error?.code??result.error);return result.value;};
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

/** Freeze only immediately verified originals; no checkpoint is inferred. */
export function selectedOperationReportService(runtime) {
 return {
  async freeze({report,candidates}) {
   const verified=await verifySelectedOperationReport(runtime,{report,candidates});
   const reportBytes=canonicalReportBytes(verified.report);
   const objects=verified.evidence.map(row=>({sourceId:row.evidence.sourceId,documentId:row.documentId,objectId:row.evidence.objectId,bytes:row.bytes}));
   if(reportBytes.length>REVIEW_LIMITS.objectBytes||reportBytes.length+objects.reduce((n,row)=>n+row.bytes.length,0)>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');
   const reportHash=await evidenceSha256(reportBytes);
   const result=must(await runtime.storage.freezeSelectedOperationReport({scopeId:runtime.scope.scopeId,reportHash,reportBytes,objects,guard:verified.guard}));
   return {reportHash,...result};
  },
  async reopen(reportHash) {
   const stored=must(await runtime.storage.readSelectedOperationReport(runtime.scope.scopeId,reportHash));
   if(!stored)throw Error('NOT_FOUND');
   const {reportBytes}=stored.record;
   if(await evidenceSha256(reportBytes)!==reportHash)throw Error('CORRUPT');
   let report;try{report=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reportBytes));}catch{throw Error('CORRUPT');}
   if(!same(canonicalReportBytes(report),reportBytes))throw Error('CORRUPT');
   const verified=await verifySelectedOperationReport(runtime,{report,candidates:stored.objects});
   return {reportHash,report:verified.report,evidence:verified.evidence,guard:verified.guard};
  },
 };
}
