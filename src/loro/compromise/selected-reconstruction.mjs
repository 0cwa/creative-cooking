import {resolveSelectedReportStart} from './selected-report-start.mjs';
import {selectedRetentionGraph} from './selected-retention-graph.mjs';
import {planSelectedRetention} from './selected-retention.mjs';
import {selectedOperationReportService} from './selected-report-service.mjs';
import {sameReportValue} from './report.mjs';
import {REVIEW_LIMITS} from './review.mjs';
import {validate,operations,checkPreconditions,apply} from '../domain/registry.mjs';

/** Detached, incomplete draft from independently verified starting documents. */
export async function reconstructSelectedRetention(runtime,{reportHash,selectedEffectIds}) {
 const start=await resolveSelectedReportStart(runtime,reportHash);
 const service=selectedOperationReportService(runtime),opened=await service.reopen(reportHash);
 if(!sameReportValue(start.guard,opened.guard))throw Error('STALE_EVIDENCE');
 await planSelectedRetention(runtime,{reportHash,selectedEffectIds}); // Validate selection using the public planner.
 const recipeDocuments=new Map(opened.report.payload.observation.manifest.children.map(child=>[child.recipeId,child.documentId]));
 const planned=selectedRetentionGraph(opened.evidence,selectedEffectIds,opened.report.payload.suspectDevice,recipeDocuments,start.documents);
 const docs=new Map(start.documents.map(d=>{const doc=new runtime.LoroDoc();if(d.snapshot.length)doc.import(d.snapshot);return [d.documentId,doc];}));
 const seedByDoc=new Map(start.documents.map(d=>[d.documentId,new Set(d.identities.map(i=>i.effectId))]));
 const evidence=new Map(opened.evidence.map(e=>[JSON.stringify([e.documentId,e.evidence.objectId]),e]));
 const original=row=>evidence.get(JSON.stringify([row.documentId,row.objectId]));
 const rows=structuredClone(planned),byId=new Map(rows.map(row=>[row.effectId,row]));
 const ancestors=(row,id,seen=new Set())=>row.dependencyEffectIds.some(dep=>dep===id||(!seen.has(dep)&&(seen.add(dep),byId.has(dep)&&ancestors(byId.get(dep),id,seen))));
 for(const row of rows)row.sourceId=original(row).evidence.sourceId;
 const active=rows.filter(row=>row.status==='retained');
 const writes=new Map(active.map(row=>[row,operations(original(row).evidence.command).filter(op=>op.container!=='domain-effects').map(op=>JSON.stringify([op.container,op.key]))]));
 const ambiguous=new Set();
 for(const [i,a] of active.entries())for(const b of active.slice(i+1))if(a.documentId===b.documentId&&!ancestors(a,b.effectId)&&!ancestors(b,a.effectId)&&writes.get(a).some(key=>writes.get(b).includes(key))){ambiguous.add(a);ambiguous.add(b);}
 for(const row of active.sort((a,b)=>a.order-b.order)) {
  const entry=original(row),command=entry.evidence.command,doc=docs.get(row.documentId);
  let reason=null;
  if(row.dependencyEffectIds.some(id=>byId.has(id)?byId.get(id).status!=='retained':!seedByDoc.get(row.documentId)?.has(id)))reason='HELD_DEPENDENCY';
  else if(ambiguous.has(row))reason='AMBIGUOUS_WRITE';
  else if(command.data.recipeSource)reason='RECIPE_SOURCE_UNSUPPORTED';
  else if(!doc)reason='UNKNOWN_DOCUMENT';
  else try {validate(command);checkPreconditions(doc,command,{importing:true});apply(doc,command);} catch(error){reason='RECONSTRUCTION_'+(error.message||'INVALID');}
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
