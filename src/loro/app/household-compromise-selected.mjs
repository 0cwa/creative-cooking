import {projectCooking} from '../domain/app-projection.mjs';
import {sameReportValue} from '../compromise/report.mjs';
import {verifySelectedEvidence} from '../compromise/selected-evidence.mjs';
import {buildSelectedOperationReport} from '../compromise/selected-report.mjs';
import {selectedOperationReportService} from '../compromise/selected-report-service.mjs';
import {reopenSelectedRetention,saveSelectedRetention} from '../compromise/selected-reconstruction.mjs';
import {normalizeSelectedEffectIds} from '../compromise/selected-retention.mjs';

const decoder=new TextDecoder('utf-8',{fatal:true});
const must=result=>{if(!result.ok)throw Error(result.error?.code??result.error);return result.value;};
const operation=({documentId,recipeId,evidence})=>({
 documentId,recipeId,objectId:evidence.objectId,effectId:evidence.command.effectId,
 authorDevice:evidence.authorDevice,kind:evidence.command.kind,
});

function preview(runtime,draft) {
 const pantry=[],recipes=[],shopping=[];
 for(const entry of draft.documents){
  const doc=new runtime.LoroDoc();
  doc.import(entry.snapshot);
  const cooking=projectCooking(doc);
  pantry.push(...cooking.pantry.map(item=>item.name));
  recipes.push(...cooking.recipes.map(recipe=>recipe.title));
  shopping.push(...cooking.shopping.items.filter(item=>!item.removedAt).map(item=>item.name));
 }
 const {draftId,reportHash,selectedEffectIds,rows,complete}=draft;
 return {draftId,reportHash,selectedEffectIds,rows,complete,pantry,recipes,shopping};
}

export function selectedHouseholdCompromise({runtime,withCurrent,current}) {
 const scope=runtime.scope,storage=runtime.storage,plans=new WeakMap();
 const service=selectedOperationReportService(runtime);
 return {
  open:()=>withCurrent(async revision=>{
   const {token}=await current(revision,null,false);
   return {confirmation:token,...must(await storage.listSelectedCompromise(scope.scopeId))};
  }),
  prepare:(confirmation,suspectDevice)=>withCurrent(async revision=>{
   const auth=await current(revision,confirmation);
   if(suspectDevice===scope.authorDevice||!scope.acceptedAuthors.includes(suspectDevice)||
      !Object.hasOwn(auth.signingKeyRefs,suspectDevice))throw Error('INVALID_REPORT_DEVICE');
   const {objects,truncated}=await storage.compromise.reviewCandidates(scope.scopeId);
   const routed=objects.flatMap(object=>{
    // Clear headers only narrow the candidate set. The verifier authenticates
    // the selected route and content before anything is offered for review.
    try {
     const {header}=JSON.parse(decoder.decode(object.bytes));
     if(header?.scopeId===scope.scopeId&&header.branchHead===scope.branchHead&&
        typeof header.documentId==='string')return [{...object,documentId:header.documentId}];
    } catch {}
    return [];
   });
   const verified=await verifySelectedEvidence(runtime,routed);
   const evidence=verified.results.filter(row=>row.status==='verified');
   const candidates=evidence.map(row=>({
    sourceId:row.evidence.sourceId,documentId:row.documentId,objectId:row.evidence.objectId,bytes:row.bytes,
   }));
   await current(revision,auth.token);
   const plan={suspectDevice,operations:evidence.map(operation),excluded:objects.length-evidence.length,truncated};
   plans.set(plan,{confirmation:auth.token,suspectDevice,candidates,guard:verified.guard});
   return plan;
  }),
  sign:(plan,decision)=>{
   const {suspectDevice,documentId,objectId}=decision??{};
   return withCurrent(async revision=>{
    const prepared=plans.get(plan);
    if(!prepared)throw Error('STALE_REPORT_SELECTION');
    if(suspectDevice!==prepared.suspectDevice||
       !prepared.candidates.some(candidate=>candidate.documentId===documentId&&candidate.objectId===objectId))throw Error('INVALID_BOUNDARY');
    await current(revision,prepared.confirmation);
    const source=await storage.checkSelectedHouseholdSources(prepared.guard);
    if(!source.ok&&(source.error?.code??source.error)==='CONFLICT')throw Error('STALE_SOURCE');
    must(source);
    const signed=await buildSelectedOperationReport(runtime,{candidates:prepared.candidates,suspectDevice,boundary:{documentId,objectId}});
    if(!sameReportValue(prepared.guard,signed.guard))throw Error('STALE_SOURCE');
    return service.freeze(signed);
   });
  },
  inspect:(confirmation,reportHash)=>withCurrent(async revision=>{
   await current(revision,confirmation);
   const {report,evidence}=await service.reopen(reportHash);
   const {reporterDevice,suspectDevice,boundary}=report.payload;
   return {reportHash,reporterDevice,suspectDevice,boundary,operations:evidence.map(operation)};
  }),
  saveDraft:async (confirmation,reportHash,selectedEffectIds)=>{
   const selection=normalizeSelectedEffectIds(selectedEffectIds);
   return withCurrent(async revision=>{
    await current(revision,confirmation);
    return saveSelectedRetention(runtime,{reportHash,selectedEffectIds:selection});
   });
  },
  reopenDraft:(confirmation,draftId)=>withCurrent(async revision=>{
   await current(revision,confirmation);
   return preview(runtime,await reopenSelectedRetention(runtime,draftId));
  }),
 };
}
