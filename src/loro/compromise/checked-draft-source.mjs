import {reopenSelectedRetention,selectedDraftIdentity} from './selected-reconstruction.mjs';
import {selectedOperationReportService} from './selected-report-service.mjs';
import {evidenceSha256,sameReportValue} from './report.mjs';

function bindingFor(draftId,reportHash,{suspectDevice,observation:{manifest}}) {
 return {draftId,reportHash,suspectDevice,sourceHead:manifest.parentHead,
  documents:[{recipeId:null,documentId:manifest.root.documentId},
   ...manifest.children.map(({recipeId,documentId})=>({recipeId,documentId}))]};
}

/** Derive the private publication binding from authenticated local evidence. */
export async function deriveDraftRotationBinding(runtime,draftId) {
 const draft=await reopenSelectedRetention(runtime,draftId);
 const opened=await selectedOperationReportService(runtime).reopen(draft.reportHash);
 const binding=bindingFor(draftId,draft.reportHash,opened.report.payload);
 await checkedDraftSource(runtime,binding);
 return binding;
}

/** Read the draft commitment preimage. Callers must authenticate the live
 * draft for a new publication or compare it to a verified retained commitment. */
export async function retainedDraftRotationBinding(storage,scopeId,draftId) {
 const saved=await storage.readSelectedRetention(scopeId,draftId),draft=saved.value;
 if(!saved.ok||!draft||draft.scopeId!==scopeId||draft.draftId!==draftId||
    await selectedDraftIdentity(scopeId,draft.reportHash,draft.selectedEffectIds)!==draftId)throw Error('RETRY_MISMATCH');
 const frozen=await storage.readSelectedOperationReport(scopeId,draft.reportHash);
 const bytes=frozen.value?.record.reportBytes;
 if(!frozen.ok||!(bytes instanceof Uint8Array)||await evidenceSha256(bytes)!==draft.reportHash)throw Error('RETRY_MISMATCH');
 return bindingFor(draftId,draft.reportHash,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).payload);
}

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
