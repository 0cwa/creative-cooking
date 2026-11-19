import {selectedOperationReportService} from './selected-report-service.mjs';
import {selectedRetentionGraph} from './selected-retention-graph.mjs';
import {sameReportValue} from './report.mjs';
import {REVIEW_LIMITS} from './review.mjs';

const id=x=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=256;
const sameBytes=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
/** Select only from a verified frozen batch. This plan is not a checkpoint or a history. */
export async function planSelectedRetention(runtime,{reportHash,selectedEffectIds}) {
 if(!Array.isArray(selectedEffectIds)||selectedEffectIds.length>REVIEW_LIMITS.objects||Array.from({length:selectedEffectIds.length},(_,i)=>Object.hasOwn(selectedEffectIds,i)).some(x=>!x)||!selectedEffectIds.every(id)||new Set(selectedEffectIds).size!==selectedEffectIds.length)throw Error('INVALID_SELECTION');
 const selection=[...selectedEffectIds].sort(),service=selectedOperationReportService(runtime);
 const opened=await service.reopen(reportHash);
 const recipeDocuments=new Map(opened.report.payload.observation.manifest.children.map(child=>[child.recipeId,child.documentId]));
 const rows=selectedRetentionGraph(opened.evidence,selection,opened.report.payload.suspectDevice,recipeDocuments);
 // Reopen again after planning to bind the detached result to the same report,
 // originals and current source; never trust a caller's dependency claims.
 const checked=await service.reopen(reportHash);
 if(!sameReportValue(opened.report,checked.report)||opened.evidence.length!==checked.evidence.length||opened.evidence.some((row,i)=>row.documentId!==checked.evidence[i].documentId||row.recipeId!==checked.evidence[i].recipeId||row.evidence.sourceId!==checked.evidence[i].evidence.sourceId||row.evidence.objectId!==checked.evidence[i].evidence.objectId||!sameBytes(row.bytes,checked.evidence[i].bytes)))throw Error('STALE_EVIDENCE');
 const guard=await runtime.storage.checkSelectedHouseholdSources(checked.guard);
 if(!guard.ok)throw Error(guard.error?.code??guard.error);
 return {reportHash,selectedEffectIds:selection,rows};
}
