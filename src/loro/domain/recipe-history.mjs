import {recipeIntentions,validate} from './registry.mjs';

const named = (kind, id) => `${kind}:${encodeURIComponent(id)}`;
const fields = {
  'recipe-field': {kind:'recipe', names:['title','description','notes']},
  'recipe-ingredient-field': {kind:'ingredient', names:['name','amount'], member:'ingredientId'},
  'recipe-step-field': {kind:'step', names:['text'], member:'stepId'},
};

function target(doc, recipeId, intention) {
  const {kind = 'recipe-field', field, id} = intention;
  const spec = fields[kind];
  if (!spec?.names?.includes(field)) return null;
  const child = spec.member ? JSON.stringify([recipeId, id]) : recipeId;
  const memberEffect = spec.member ? doc.getMap(named(`recipe-${spec.kind}-index`,recipeId)).get(id) : null;
  const record = doc.getMap(named(spec.member ? `recipe-${spec.kind}` : 'recipe',child));
  if ((spec.member && !memberEffect) || record.get('removed')) return null;
  const head = doc.getMap(named('field-head',JSON.stringify([spec.kind,child,field]))).get('effect');
  return {kind, child, memberEffect, member:spec.member, head};
}

/** Retain history for live text fields. Causal ancestry, rather than clocks or
 * delivery order, identifies which alternatives compete with the winner. */
export function readRecipeHistory(doc, recipeId) {
  if (!doc.getMap('recipe-index').get(recipeId) || doc.getMap(named('recipe',recipeId)).get('removed')) return [];
  const rows = recipeIntentions(doc,recipeId);
  const byId = new Map(rows.map(row=>[row.effectId,row]));
  const ancestors = new Map();
  function earlierThan(head) {
    if (ancestors.has(head)) return ancestors.get(head);
    const visited = new Set();
    const pending = [...(byId.get(head)?.dependencyEffectIds ?? [])];
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(byId.get(id)?.dependencyEffectIds ?? []));
    }
    ancestors.set(head,visited);
    return visited;
  }
  return rows.flatMap(row=>{
    const location = target(doc,recipeId,row);
    if (!location?.head) return [];
    const status = location.head === row.effectId ? 'current' : earlierThan(location.head).has(row.effectId) ? 'earlier' : 'competing';
    return [{...row,kind:location.kind,head:location.head,status}];
  }).sort((a,b)=>b.at.localeCompare(a.at)||a.effectId.localeCompare(b.effectId));
}

export function planRecipeRestore({doc,recipeId,effectId,expectedHead,actionId,author,at}) {
  const row = readRecipeHistory(doc,recipeId).find(entry=>entry.effectId===effectId);
  if (!row || row.head!==expectedHead) throw Error('Recipe history changed. Reopen it before restoring this edit.');
  if (row.status==='current') return null;
  const location = target(doc,recipeId,row);
  const root = doc.getMap('recipe-index').get(recipeId);
  return validate({
    version:1,kind:location.kind,commandId:actionId,effectId:actionId,
    dependencyEffectIds:[...new Set([root,location.memberEffect,row.head,row.effectId].filter(Boolean))].sort(),
    data:{recipeId,field:row.field,value:row.value,author,at,...(location.member?{[location.member]:row.id}:{})},
  });
}
