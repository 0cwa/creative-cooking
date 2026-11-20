import {reopenSelectedRetention} from './selected-reconstruction.mjs';
import {selectedOperationReportService} from './selected-report-service.mjs';
import {sameReportValue} from './report.mjs';

/** Rebuild a saved draft for detached preparation. No policy projection or
 * authority follows from this result; visibility provenance must be verified
 * independently before any effect can be projected. */
export async function checkedDraftSource(runtime,{draftId,reportHash,suspectDevice,sourceHead,documents}) {
 const service=selectedOperationReportService(runtime);
 const opened=await service.reopen(reportHash);
 const manifest=opened.report.payload.observation.manifest;
 const membership=[{recipeId:null,documentId:manifest.root.documentId},
  ...manifest.children.map(({recipeId,documentId})=>({recipeId,documentId}))];
 if(opened.report.payload.suspectDevice!==suspectDevice || manifest.parentHead!==sourceHead ||
   !sameReportValue(membership,documents))throw Error('INVALID_DRAFT_SOURCE');
 const draft=await reopenSelectedRetention(runtime,draftId);
 if(draft.reportHash!==reportHash || !sameReportValue(draft.documents.map(({recipeId,documentId})=>({recipeId,documentId})),membership))throw Error('INVALID_DRAFT_SOURCE');
 const checked=await service.reopen(reportHash);
 if(!sameReportValue(opened.report,checked.report)||!sameReportValue(opened.guard,checked.guard))throw Error('STALE_EVIDENCE');
 const guard=await runtime.storage.checkSelectedHouseholdSources(checked.guard);
 if(!guard.ok)throw Error(guard.error?.code??guard.error);
 return {draftId,reportHash,suspectDevice,sourceHead,documents:draft.documents,rows:draft.rows,guard:checked.guard};
}
