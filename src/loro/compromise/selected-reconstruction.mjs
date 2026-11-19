import {resolveSelectedReportStart} from './selected-report-start.mjs';
import {selectedRetentionGraph} from './selected-retention-graph.mjs';
import {normalizeSelectedEffectIds} from './selected-retention.mjs';
import {selectedOperationReportService} from './selected-report-service.mjs';
import {sameReportValue} from './report.mjs';
import {REVIEW_LIMITS} from './review.mjs';
import {validate,operations,checkPreconditions,apply} from '../domain/registry.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {createShoppingRecipeSourceVerifier} from '../disclosure/shopping-recipe-source.mjs';

/** Detached, incomplete draft from independently verified starting documents. */
export async function reconstructSelectedRetention(runtime,{reportHash,selectedEffectIds}) {
 const selection=normalizeSelectedEffectIds(selectedEffectIds);
 const start=await resolveSelectedReportStart(runtime,reportHash);
 const service=selectedOperationReportService(runtime),opened=await service.reopen(reportHash);
 if(!sameReportValue(start.guard,opened.guard))throw Error('STALE_EVIDENCE');
 const recipeDocuments=new Map(opened.report.payload.observation.manifest.children.map(child=>[child.recipeId,child.documentId]));
 const planned=selectedRetentionGraph(opened.evidence,selection,opened.report.payload.suspectDevice,recipeDocuments,start.documents);
 const docs=new Map(start.documents.map(d=>{const doc=new runtime.LoroDoc();if(d.snapshot.length)doc.import(d.snapshot);return [d.documentId,doc];}));
 const evidence=new Map(opened.evidence.map(e=>[JSON.stringify([e.documentId,e.evidence.objectId]),e]));
 const original=row=>evidence.get(JSON.stringify([row.documentId,row.objectId]));
 const rows=structuredClone(planned),byId=new Map(rows.map(row=>[row.effectId,row]));
 const ancestors=(row,id,seen=new Set())=>row.dependencyEffectIds.some(dep=>dep===id||(!seen.has(dep)&&(seen.add(dep),byId.has(dep)&&ancestors(byId.get(dep),id,seen))));
 for(const row of rows)row.sourceId=original(row).evidence.sourceId;
 const active=rows.filter(row=>row.status==='retained');
 const writes=new Map(active.map(row=>[row,operations(original(row).evidence.command).filter(op=>op.container!=='domain-effects').map(op=>JSON.stringify([op.container,op.key]))]));
 const ambiguous=new Set();
 for(const [i,a] of active.entries())for(const b of active.slice(i+1))if(a.documentId===b.documentId&&!ancestors(a,b.effectId)&&!ancestors(b,a.effectId)&&writes.get(a).some(key=>writes.get(b).includes(key))){ambiguous.add(a);ambiguous.add(b);}
 const applied=new Map();
 let verifyRecipeSource;
 for(const row of active.sort((a,b)=>a.order-b.order)) {
  const entry=original(row),command=entry.evidence.command,doc=docs.get(row.documentId);
  let reason=null;
  if(row.dependencyEffectIds.some(id=>byId.has(id)&&!applied.has(id)))reason='HELD_DEPENDENCY';
  else if(ambiguous.has(row))reason='AMBIGUOUS_WRITE';
  else if(!doc)reason='UNKNOWN_DOCUMENT';
  else try {
   validate(command);
   let recipeSource;
   if(command.data.recipeSource){
    if(!verifyRecipeSource){
     const auth=await runtime.authorization();
     const disclosure=disclosureService({storage:runtime.storage,scope:auth.expectedAuthority.scope,
      rootPin:runtime.authority.rootPin,provider:runtime.authority.provider,deviceId:runtime.scope.authorDevice,
      installedSet:runtime.authority.installedSet});
     verifyRecipeSource=createShoppingRecipeSourceVerifier({runtime,service:disclosure,context:await disclosure.authority(),includeDependencies:true});
    }
    const linked=await verifyRecipeSource(command);
    // The copy uses its signed historical values. Every governing effect and
    // ancestor must have survived in the draft under the same signed identity.
    const sourceDocumentId=linked.source.documentId,sourceDoc=docs.get(sourceDocumentId);
    for(const [id,proof] of linked.dependencies){
     const retained=applied.get(id),marker=sourceDoc?.getMap('domain-effects').get(id);
     const matched=proof.seedId
      ? marker?.version===3&&marker.seedId===proof.seedId
      : retained?.documentId===sourceDocumentId&&retained.objectId===proof.objectId;
     if(!matched)throw Error('HELD_RECIPE_SOURCE');
    }
    const {disclosurePolicyHashes,disclosureIncomplete}=entry.evidence;
    for(const proof of linked.sources.values())if(proof.incomplete&&!disclosureIncomplete||
      proof.policies.some(hash=>!disclosurePolicyHashes?.includes(hash)))throw Error('INVALID_SOURCE_PROOF');
    recipeSource=linked.source;
   }
   checkPreconditions(doc,command,{importing:true,recipeSource});
   apply(doc,command);
   applied.set(row.effectId,row);
  } catch(error){reason='RECONSTRUCTION_'+(error.message||'INVALID');}
  if(reason){row.status='held';row.reason=reason;row.order=null;}
 }
 let total=0;
 const documents=start.documents.map(({documentId,recipeId,seedId,identities,policies})=>{const snapshot=docs.get(documentId).export({mode:'snapshot'});total+=snapshot.length;if(snapshot.length>REVIEW_LIMITS.objectBytes||total>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');return {documentId,recipeId,snapshot,seedId,identities,policies,incomplete:true};});
 const checked=await service.reopen(reportHash);
 if(!sameReportValue(opened.report,checked.report)||!sameReportValue(opened.guard,checked.guard)||opened.evidence.length!==checked.evidence.length||opened.evidence.some((e,i)=>e.documentId!==checked.evidence[i].documentId||e.recipeId!==checked.evidence[i].recipeId||e.evidence.sourceId!==checked.evidence[i].evidence.sourceId||e.evidence.objectId!==checked.evidence[i].evidence.objectId||!sameReportValue([...e.bytes],[...checked.evidence[i].bytes])))throw Error('STALE_EVIDENCE');
 const finalStart=await resolveSelectedReportStart(runtime,reportHash);
 if(!sameReportValue(start.guard,finalStart.guard)||start.documents.length!==finalStart.documents.length||start.documents.some((doc,i)=>{const end=finalStart.documents[i];return doc.documentId!==end.documentId||doc.recipeId!==end.recipeId||doc.seedId!==end.seedId||!sameReportValue([...doc.snapshot],[...end.snapshot])||!sameReportValue(doc.identities,end.identities)||!sameReportValue(doc.policies,end.policies);}))throw Error('STALE_EVIDENCE');
 const guard=await runtime.storage.checkSelectedHouseholdSources(checked.guard);if(!guard.ok)throw Error(guard.error?.code??guard.error);
 return {reportHash,documents,rows,complete:false,state:'local-draft'};
}
