import {readShoppingItem} from './registry.mjs';
// Projection of the authenticated domain document. The caller obtains the document
// through OfflineRuntime.document(), which enforces the selected authority head.
const named=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
const member=(kind,parent,id)=>named(kind,JSON.stringify([parent,id]));
const values=(doc,name)=>doc.getMap(name).toJSON();
const ordered=items=>items.sort((a,b)=>(a.position??0)-(b.position??0)||a.id.localeCompare(b.id));

export function projectCooking(doc) {
 const recipes=Object.keys(values(doc,'recipe-index')).sort().flatMap(id=>{
  const record=values(doc,named('recipe',id));
  if(record.removed)return [];
  const ingredients=ordered(Object.keys(values(doc,named('recipe-ingredient-index',id))).map(ingredientId=>({id:ingredientId,...values(doc,member('recipe-ingredient',id,ingredientId))})).filter(x=>!x.removed));
  const steps=ordered(Object.keys(values(doc,named('recipe-step-index',id))).map(stepId=>({id:stepId,...values(doc,member('recipe-step',id,stepId))})).filter(x=>!x.removed));
  return [{id,...record,ingredients:ingredients.map(({position,removed,...item})=>item),steps:steps.map(x=>x.text),stepIds:steps.map(x=>x.id)}];
 });
 const pantry=Object.keys(values(doc,'pantry-index')).sort().flatMap(id=>{
  const item=values(doc,named('pantry',id));return item.removed||item.removedAt?[]:[{id,...item}];
 });
 // Enumerate Loro root maps so fresh current-state seeds (which intentionally
 // omit historical commands) remain readable after admission or reconstruction.
 const state=doc.toJSON();
 const commands=Object.values(values(doc,'domain-effects')).map(v=>v.command).filter(Boolean);
 const cycles=Object.entries(values(doc,'shopping-cycles')).sort(([a],[b])=>a.localeCompare(b)).map(([id,{listId,startedAt}])=>({id,listId,startedAt}));
 const lists=Object.keys(state).filter(x=>x.startsWith('shopping-list:')).sort().flatMap(name=>{
  const v=state[name];if(!v.currentCycleId)return [];const id=decodeURIComponent(name.slice('shopping-list:'.length));
  const startedAt=cycles.find(c=>c.id===v.currentCycleId)?.startedAt;if(!startedAt)throw Error('INVALID_PROJECTION');
  const created=commands.find(c=>c.kind==='shopping-list-create'&&c.data.listId===id)?.data.at ?? null;
  return [{id,...v,createdAt:created,updatedAt:v.updatedAt??null}];
 });
 const purchases=Object.values(values(doc,'purchases')).sort((a,b)=>a.id.localeCompare(b.id)).map(({author,...p})=>p);
 const items=Object.keys(state).filter(x=>x.startsWith('shopping-item:')).sort().flatMap(name=>{
  const base=state[name].value;if(!base)return [];const cycle=state[named('shopping-list',base.listId)]?.currentCycleId;if(!cycle)return [];const v=readShoppingItem(doc,base.itemId,cycle),purchased=purchases.some(p=>p.listId===v.listId&&p.purchaseCycleId===cycle&&p.itemIds.includes(v.itemId)),optional=Object.fromEntries(['recipeId','ingredientId','displayQuantity','displayUnit','removedAt'].filter(k=>v[k]!==undefined&&v[k]!==null).map(k=>[k,v[k]]));return [{id:v.itemId,listId:v.listId,name:v.name,purchaseCycleId:cycle,checked:v.checked,createdAt:v.createdAt??null,updatedAt:v.updatedAt??v.at,...optional,...(purchased?{purchasedCycleId:cycle}:{})}];
 });
 return {recipes,pantry,shopping:{lists,cycles,items,purchases}};
}
