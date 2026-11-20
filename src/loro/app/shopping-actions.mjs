import {apply,checkPreconditions,readShoppingItem,shoppingRecipeSource} from '../domain/registry.mjs';
const named=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
const head=(kind,id,field)=>named('field-head',JSON.stringify([kind,id,field]));
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
/** Plan a UI transaction against an isolated fork. Every command retains its
 * own causal dependencies; the caller commits the resulting batch atomically. */
export function planShoppingAction({doc,before,after,pantryBefore,pantryAfter,actionId,author,at,recipeCatalog=null}){
 if(!doc||!before||!after||!Array.isArray(pantryBefore)||!Array.isArray(pantryAfter)||!actionId||!author||!Number.isFinite(Date.parse(at)))throw Error('MALFORMED');
 const stage=doc.fork(),commands=[];let n=0;
 const add=(kind,data,deps,effectId=`${actionId}:${++n}`)=>{const c={version:1,kind,commandId:effectId,effectId,dependencyEffectIds:[...new Set(deps.filter(Boolean))].sort(),data};checkPreconditions(stage,c,{recipeSource:data.recipeSource});apply(stage,c);commands.push(c);return effectId};
 const index=(rows)=>{if(!Array.isArray(rows))throw Error('MALFORMED');const m=new Map(rows.map(x=>[x.id,x]));if(m.size!==rows.length)throw Error('MALFORMED');return m};
 const oldLists=index(before.lists),newLists=index(after.lists),oldItems=index(before.items),newItems=index(after.items),oldPurchases=index(before.purchases),newPurchases=index(after.purchases),oldCycles=index(before.cycles),newCycles=index(after.cycles);
 for(const [id,a] of oldLists)if(!newLists.has(id))throw Error('UNSUPPORTED_EDIT');for(const [id,a] of oldItems)if(!newItems.has(id))throw Error('UNSUPPORTED_EDIT');for(const [id,a] of oldPurchases)if(!same(a,newPurchases.get(id)))throw Error('UNSUPPORTED_EDIT');for(const [id,a] of oldCycles)if(!same(a,newCycles.get(id)))throw Error('UNSUPPORTED_EDIT');
 for(const [id,b] of [...newLists].sort(([a],[b])=>a.localeCompare(b))){const a=oldLists.get(id);if(!a){const cycle=newCycles.get(b.currentCycleId);if(!cycle||cycle.listId!==id)throw Error('MALFORMED');add('shopping-list-create',{listId:id,cycleId:cycle.id,name:b.name,at:cycle.startedAt},[])}else{const list=stage.getMap(named('shopping-list',id));if(list.get('currentCycleId')!==a.currentCycleId)throw Error('REBASE_REQUIRED');if(a.name!==b.name)throw Error('UNSUPPORTED_EDIT');if(a.currentCycleId!==b.currentCycleId){const prev=stage.getMap('shopping-cycles').get(a.currentCycleId),cycle=newCycles.get(b.currentCycleId);if(!prev||!cycle||cycle.listId!==id)throw Error('MALFORMED');add('shopping-cycle-start',{listId:id,previousCycleId:a.currentCycleId,cycleId:cycle.id,at:cycle.startedAt},[prev.effectId])}}}
 const fieldDeps=(kind,id,field)=>stage.getMap(head(kind,id,field)).get('effect');
 for(const [id,b] of [...newItems].sort(([a],[b])=>a.localeCompare(b))){const a=oldItems.get(id),list=newLists.get(b.listId),cycle=stage.getMap('shopping-cycles').get(list?.currentCycleId);if(!list||!cycle)throw Error('MALFORMED');let base=stage.getMap(named('shopping-item',id)).get('value');if(!a){
   if(base)throw Error('CONFLICT');
   const deps=[cycle.effectId];
   const data={listId:b.listId,cycleId:list.currentCycleId,itemId:id,name:b.name,checked:b.checked,
    recipeId:b.recipeId??null,ingredientId:b.ingredientId??null,displayQuantity:b.displayQuantity??null,
    displayUnit:b.displayUnit??null,author,at:b.createdAt??at};
   const child=b.recipeId && recipeCatalog?.children.get(b.recipeId);
   if(child){
    data.recipeSource=shoppingRecipeSource(child,data);
    deps.push(...data.recipeSource.effectIds);
   }else if(b.recipeId){
    const recipe=stage.getMap('recipe-index').get(b.recipeId);
    if(!recipe)throw Error('MISSING_DEPENDENCY');
    deps.push(recipe);
    if(b.ingredientId){
     const ingredient=stage.getMap(named('recipe-ingredient-index',b.recipeId)).get(b.ingredientId),pair=JSON.stringify([b.recipeId,b.ingredientId]);
     if(!ingredient)throw Error('MISSING_DEPENDENCY');
     deps.push(ingredient,...['name','amount','needsShopping'].map(field=>fieldDeps('ingredient',pair,field)));
    }
   }else if(b.ingredientId)throw Error('MALFORMED');
   base={effectId:add('shopping-item-create',data,deps)};
  }else{if(!base||a.listId!==b.listId)throw Error('CONFLICT');const live=readShoppingItem(stage,id,a.purchaseCycleId);for(const field of ['name','checked','recipeId','ingredientId','displayQuantity','displayUnit','removedAt'])if(!same(a[field],b[field])&&!same(a[field],live[field]))throw Error('REBASE_REQUIRED')}
  for(const field of ['name','checked','recipeId','ingredientId','displayQuantity','displayUnit','createdAt','removedAt','updatedAt']){if(!a&&['name','checked','recipeId','ingredientId','displayQuantity','displayUnit','createdAt'].includes(field))continue;if(!a&&field==='updatedAt'&&b.updatedAt===(b.createdAt??at))continue;if(a&&same(a[field],b[field]))continue;if(a&&['recipeId','ingredientId'].includes(field))throw Error('UNSUPPORTED_EDIT');if(b[field]===undefined&&['createdAt','removedAt','updatedAt'].includes(field))continue;const value=b[field]??null;add('shopping-item-field',{listId:b.listId,cycleId:list.currentCycleId,itemId:id,field,value,author,at},[cycle.effectId,base.effectId,fieldDeps('shopping-item',id,field)])}
 }
 for(const [id,b] of [...newLists].sort(([a],[b])=>a.localeCompare(b))){const a=oldLists.get(id),cycle=stage.getMap('shopping-cycles').get(b.currentCycleId);for(const field of ['removedAt','updatedAt']){if(same(a?.[field],b[field])||b[field]===undefined||b[field]===null)continue;add('shopping-list-field',{listId:id,cycleId:b.currentCycleId,field,value:b[field],author,at},[cycle.effectId,fieldDeps('shopping-list',id,field)])}}
 const oldPantry=index(pantryBefore),newPantry=index(pantryAfter),additions=[...newPantry.values()].filter(x=>!oldPantry.has(x.id));if([...oldPantry].some(([id,v])=>!same(v,newPantry.get(id))))throw Error('UNSUPPORTED_EDIT');
 for(const [id,p] of [...newPurchases].sort(([a],[b])=>a.localeCompare(b))){if(oldPurchases.has(id))continue;const cycle=stage.getMap('shopping-cycles').get(p.purchaseCycleId);if(!cycle||cycle.listId!==p.listId)throw Error('MALFORMED');const added=additions.filter(x=>p.pantryItemIds.includes(x.id)),pantryItems=added.map(x=>{const itemId=p.itemIds.find(i=>x.id===`shopping-purchase:${encodeURIComponent(id)}:${encodeURIComponent(i)}`);if(!itemId)throw Error('MALFORMED');return {id:x.id,itemId,name:x.name}});if(pantryItems.length!==p.pantryItemIds.length)throw Error('MALFORMED');const deps=[cycle.effectId];for(const itemId of p.itemIds){const item=readShoppingItem(stage,itemId,p.purchaseCycleId);if(!item)throw Error('MISSING_DEPENDENCY');deps.push(item.effectId,...['name','checked','removedAt'].map(f=>fieldDeps('shopping-item',itemId,f)))}add('purchase',{...p,pantryItems,author},deps,id)}
 if(additions.some(x=>![...newPurchases.values()].some(p=>!oldPurchases.has(p.id)&&p.pantryItemIds.includes(x.id))))throw Error('UNSUPPORTED_EDIT');return commands;
}
