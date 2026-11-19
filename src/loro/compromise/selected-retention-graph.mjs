// Internal graph calculation. Its input must come from authenticated frozen evidence.
export function selectedRetentionGraph(evidence,selected,suspectDevice,recipeDocuments,seedDocuments=[]) {
 const selectedIds=new Set(selected),byEffect=new Map(),byCommand=new Map(),seedEffects=new Map(),seedCommands=new Map();
 for(const doc of seedDocuments)for(const identity of doc.identities){
  for(const [map,id] of [[seedEffects,identity.effectId],[seedCommands,identity.commandId]]){const list=map.get(id)??[];list.push({documentId:doc.documentId,identity});map.set(id,list);}
 }
 const seedFor=(id,documentId)=>seedEffects.get(id)?.length===1&&seedEffects.get(id)[0].documentId===documentId&&!byEffect.has(id)&&seedCommands.get(seedEffects.get(id)[0].identity.commandId)?.length===1&&!byCommand.has(seedEffects.get(id)[0].identity.commandId);

 const rows=evidence.map(({documentId,recipeId,evidence:e})=>({documentId,recipeId,objectId:e.objectId,
  effectId:e.command.effectId,commandId:e.command.commandId,authorDevice:e.authorDevice,
  authorship:e.authorDevice===suspectDevice?'suspect':'other',dependencyEffectIds:[...e.command.dependencyEffectIds].sort(),
  source:e.command.data.recipeSource??null,sourceRecipeId:e.command.data.recipeId??null,status:null,reason:null,order:null}));
 for(const row of rows){for(const [map,id] of [[byEffect,row.effectId],[byCommand,row.commandId]]){const list=map.get(id)??[];list.push(row);map.set(id,list);}}
 if(selected.some(id=>!byEffect.has(id)))throw Error('UNKNOWN_EFFECT');
 for(const row of rows){
  if(byEffect.get(row.effectId).length!==1||byCommand.get(row.commandId).length!==1||seedEffects.has(row.effectId)||seedCommands.has(row.commandId)){row.status='held';row.reason='AMBIGUOUS_ID';}
  else if(!selectedIds.has(row.effectId)){row.status='excluded';row.reason='NOT_SELECTED';}
 }
 for(const row of rows){
  if(row.status)continue;
  const source=row.source;
  if(source && (recipeDocuments && recipeDocuments.get(row.sourceRecipeId)!==source.documentId || source.effectIds.some(id=>byEffect.has(id)&&byEffect.get(id).length===1&&byEffect.get(id)[0].documentId!==source.documentId))){
   row.status='held';row.reason='AMBIGUOUS_SOURCE';
  }
 }
 function propagate(){let changed=false;for(const row of rows){if(row.status)continue;
  const deps=row.dependencyEffectIds;
  if(deps.some(id=>!byEffect.has(id)&&!seedFor(id,row.documentId))){row.status='held';row.reason='MISSING_DEPENDENCY';changed=true;continue;}
  if(deps.some(id=>byEffect.has(id)&&(byEffect.get(id).length!==1||byEffect.get(id)[0].status==='held'))){row.status='held';row.reason='HELD_DEPENDENCY';changed=true;continue;}
  if(deps.some(id=>byEffect.has(id)&&byEffect.get(id)[0].status==='excluded')){row.status='held';row.reason='EXCLUDED_DEPENDENCY';changed=true;}
 }return changed;}
 while(propagate()){}
 // Kahn ordering is deterministic even when the caller provides a different selection order.
 const readyOrder=(a,b)=>a.effectId<b.effectId?-1:a.effectId>b.effectId?1:a.objectId<b.objectId?-1:a.objectId>b.objectId?1:0;
 let order=0;
 while(true){const ready=rows.filter(row=>!row.status&&row.dependencyEffectIds.every(id=>seedFor(id,row.documentId)||byEffect.get(id)?.[0].status==='retained')).sort(readyOrder);if(!ready.length)break;
  for(const row of ready){row.status='retained';row.reason='SELECTED';row.order=order++;}
 }
 // Every remaining row reaches a cycle. Identify actual cycle members separately.
 const pending=rows.filter(row=>!row.status),visiting=new Set(),visited=new Set(),stack=[],cycles=new Set();
 function visit(row){if(visiting.has(row)){for(const member of stack.slice(stack.indexOf(row)))cycles.add(member);return;}if(visited.has(row))return;
  visiting.add(row);stack.push(row);for(const id of row.dependencyEffectIds){const dep=byEffect.get(id)?.[0];if(dep&&!dep.status)visit(dep);}stack.pop();visiting.delete(row);visited.add(row);
 }
 for(const row of pending)visit(row);
 for(const row of cycles){row.status='held';row.reason='DEPENDENCY_CYCLE';}
 while(propagate()){}
 for(const row of rows)if(!row.status){row.status='held';row.reason='HELD_DEPENDENCY';}
 return rows.sort(readyOrder).map(({source,sourceRecipeId,...row})=>row);
}
