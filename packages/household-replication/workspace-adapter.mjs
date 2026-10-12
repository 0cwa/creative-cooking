import {copySelectedRecipe,scalar,project,validate} from './index.mjs';

/** One-time normalized HouseholdWorkspace -> empty replication document bootstrap.
 * The returned local sidecar is never replicated. This is not an array sync loop. */
export async function bootstrapWorkspace(repo,workspace,credentials) {
  if(workspace.id!==String(repo.document.householdId))throw new Error('Workspace scope mismatch');
  const sidecar={householdId:workspace.id,replicationEpoch:repo.document.replicationEpoch,name:workspace.name,createdAt:workspace.createdAt,items:{},recipes:{}};
  // Only intentional household metadata is retained; unknown/private fields are excluded.
  for(const item of workspace.shoppingList) {
    if(sidecar.items[item.id])throw new Error('Duplicate shopping ID');
    sidecar.items[item.id]={createdAt:item.createdAt,updatedAt:item.updatedAt};
    if(item.pantryPreference!==undefined)sidecar.items[item.id].pantryPreference=item.pantryPreference;
  }
  for(const copy of workspace.recipes) {
    if(sidecar.recipes[copy.id])throw new Error('Duplicate recipe copy ID');
    sidecar.recipes[copy.id]={recipeId:copy.recipe.id,addedAt:copy.addedAt,createdAt:copy.recipe.createdAt,updatedAt:copy.recipe.updatedAt};
  }
  await repo.change(doc=>{
    if(Object.keys(doc.shoppingLists).length||Object.keys(doc.recipes).length||Object.keys(doc.deletedLists).length||Object.keys(doc.deletedRecipes).length||Object.keys(doc.requirements.allergies).length||String(doc.requirements.diet)!=='none')throw new Error('Bootstrap requires an empty document; repeated imports are not sync');
    const list={id:scalar('default'),title:scalar(workspace.name),items:{},deletedItems:{}};
    for(const item of workspace.shoppingList) {
      list.items[item.id]={id:scalar(item.id),name:scalar(item.name),checked:item.checked};
      if(item.amount!==undefined)list.items[item.id].amount=scalar(item.amount);
    }
    doc.shoppingLists.default=list;
    for(const copy of workspace.recipes)copySelectedRecipe(doc,{copyId:copy.id,sourceRecipeId:copy.sourceRecipeId,recipe:copy.recipe});
    workspace.requirements.allergies.forEach((value,index)=>{doc.requirements.allergies[`allergy_${index}`]=scalar(value);});
    doc.requirements.diet=scalar(workspace.requirements.diet);
  },credentials);
  return sidecar;
}

/** Explicit snapshot export into the same household scope. Personal recipes/list/allergies
 * are not arguments and never unioned. Ingredient/step IDs remain in the engine snapshot;
 * this legacy array view is for application rendering/export, not a lossless CRDT backup. */
export function exportWorkspace(doc,{sidecar,targetHouseholdId,replicationEpoch,now}) {
  if(!Number.isFinite(Date.parse(now)))throw new Error('Valid export timestamp required');
  const scope={householdId:targetHouseholdId,replicationEpoch};
  validate(doc,scope);
  if(sidecar.householdId!==targetHouseholdId||sidecar.replicationEpoch!==replicationEpoch)throw new Error('Sidecar scope mismatch');
  const view=project(doc);
  if(view.shoppingLists.some(list=>list.id!=='default'))throw new Error('Legacy workspace cannot flatten multiple lists');
  const list=view.shoppingLists.find(list=>list.id==='default');
  const shoppingList=(list?.items??[]).map(item=>{
    const metadata=sidecar.items[item.id];
    return {id:item.id,name:item.name,...(item.amount!==undefined?{amount:item.amount}:{}),checked:item.checked,createdAt:metadata?.createdAt??now,updatedAt:now,...(metadata?.pantryPreference!==undefined?{pantryPreference:metadata.pantryPreference}:{})};
  });
  const recipes=view.recipes.map(copy=>{
    const metadata=sidecar.recipes[copy.id];
    return {id:copy.id,sourceRecipeId:copy.sourceRecipeId,addedAt:metadata?.addedAt??now,recipe:{id:metadata?.recipeId??copy.id,title:copy.title,...(copy.description!==undefined?{description:copy.description}:{}),portions:copy.portions,ingredients:copy.ingredients.map(item=>({name:item.name,...(item.amount!==undefined?{amount:item.amount}:{})})),steps:copy.steps.map(step=>step.text),createdAt:metadata?.createdAt??now,updatedAt:now}};
  });
  return {id:targetHouseholdId,name:sidecar.name,shoppingList,recipes,requirements:{allergies:Object.keys(view.requirements.allergies).sort().map(key=>view.requirements.allergies[key]),diet:view.requirements.diet},createdAt:sidecar.createdAt,updatedAt:now};
}
