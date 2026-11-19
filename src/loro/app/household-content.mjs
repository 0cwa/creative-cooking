import {projectCooking,projectRecipes} from '../domain/app-projection.mjs';
import {executeAction,recoverDisclosureAction} from './action.mjs';
import {planRecipeAction} from './recipe-actions.mjs';
import {planShoppingAction} from './shopping-actions.mjs';
import {openSelectedRecipeCatalog,openShoppingRecipeCatalog,projectSelectedRecipes} from './selected-recipe-catalog.mjs';

/** Use the platform's shared workspace operation boundary for reads and saves. */
export function bindHouseholdContent({runtime,withCurrent=use=>use(),sequences,disclosure,originalRecipeDocuments=false,shoppingRecipeCopies=false}) {
 async function recipeRuntime(recipeId){
  if(recipeId===undefined)return runtime;
  if(runtime.authority?.installedSet || runtime.authority?.activatedPolicy || runtime.authority?.returnedPolicy || runtime.authority?.adultRemoval){
   const {members}=await runtime.authorization();
   if(members.some(member=>member.recipeId===recipeId))return runtime.forRecipe(recipeId);
   if(runtime.authority.activatedPolicy || runtime.authority.returnedPolicy || runtime.authority.adultRemoval)throw Error('INVALID_RECIPE_DOCUMENT');
   if(runtime.authority.recipeDelivery){
    const {children}=await openSelectedRecipeCatalog(runtime,recipeId);
    if(children.has(recipeId))return runtime.forRecipe(recipeId);
   }
  }
  if(originalRecipeDocuments){
   const {children}=await openSelectedRecipeCatalog(runtime,recipeId);
   if(children.has(recipeId))return runtime.forRecipe(recipeId);
  }
  return runtime;
 }
 return {
  readCooking:()=>withCurrent(async()=>{
   if(originalRecipeDocuments){
    const selected=await openSelectedRecipeCatalog(runtime);
    return {...projectCooking(selected.parent.doc),recipes:projectSelectedRecipes(selected),
     separateRecipeIds:[...selected.children.keys()]};
   }
   const {doc}=await runtime.document();
   const cooking=projectCooking(doc);
   if(!runtime.authority?.installedSet && !runtime.authority?.activatedPolicy && !runtime.authority?.returnedPolicy && !runtime.authority?.adultRemoval)return {...cooking,separateRecipeIds:[]};
   const {members}=await runtime.authorization();
   const separateRecipeIds=[];
   for(const {recipeId} of members){
    if(recipeId===null)continue;
    separateRecipeIds.push(recipeId);
    const child=await runtime.forRecipe(recipeId);
    const {doc}=await child.document();
    cooking.recipes.push(...projectRecipes(doc));
   }
   if(runtime.authority.recipeDelivery){
    const {children}=await openSelectedRecipeCatalog(runtime);
    for(const [recipeId,{doc}] of children){
     separateRecipeIds.push(recipeId);
     cooking.recipes.push(...projectRecipes(doc));
    }
   }
   cooking.recipes.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
   return {...cooking,separateRecipeIds};
  }),
  readRecipe:recipeId=>withCurrent(async()=>{
   const target=await recipeRuntime(recipeId);
   return {...await target.document(),scope:target.scope};
  }),
  execute:(actionId,commands,recipeId=undefined)=>{
   if(runtime.authority?.activatedPolicy || runtime.authority?.returnedPolicy || runtime.authority?.adultRemoval)throw Error('READ_ONLY_WORKSPACE');
   const input=structuredClone(commands);
   return withCurrent(async()=>{
    const target=await recipeRuntime(recipeId);
    return executeAction(target,sequences,actionId,input,disclosure);
   });
  },
  ...(shoppingRecipeCopies?{recoverShoppingCopy:(attempt)=>withCurrent(async()=>{
   if(!attempt.commands?.length)return false;
   return !!await recoverDisclosureAction(runtime,attempt.actionId,attempt.commands,disclosure);
  }),saveShoppingCopy:(attempt,before,after)=>withCurrent(async()=>{
   if(!attempt.commands){
    const existing=new Set(before.shopping.items.map(item=>item.id));
    const recipes=new Set(after.items.filter(item=>!existing.has(item.id)&&item.recipeId).map(item=>item.recipeId));
    const children=new Map();
    let parent;
    for(const id of recipes){
     const selected=await openShoppingRecipeCatalog(runtime,id);
     if(parent&&parent.revision!==selected.parent.revision)throw Error('CONFLICT');
     parent=selected.parent;
     for(const [recipeId,child] of selected.children)children.set(recipeId,child);
    }
    if(!parent)return;
    attempt.commands=planShoppingAction({doc:parent.doc,recipeCatalog:{children},before:before.shopping,after,
     pantryBefore:before.pantry,pantryAfter:before.pantry,actionId:attempt.actionId,author:runtime.scope.authorDevice,
     at:attempt.at});
   }
   if(!attempt.commands.length)return;
   try {
    await executeAction(runtime,sequences,attempt.actionId,attempt.commands,disclosure);
   } catch(error){
    if(error?.message==='CONFLICT'||error?.message==='REBASE_REQUIRED'){
     const saved=await runtime.storage.getLocalOperation(runtime.scope.scopeId,attempt.actionId);
     if(saved.ok&&!saved.value)attempt.commands=null;
    }
    throw error;
   }
  })}:{}),
  createRecipe:(actionId,recipe,beforeNewCommit=/** @type {(() => void)|undefined} */(undefined))=>{
   if(runtime.authority?.activatedPolicy || runtime.authority?.returnedPolicy || runtime.authority?.adultRemoval)throw Error('READ_ONLY_WORKSPACE');
   const after=structuredClone(recipe);
   return withCurrent(async()=>{
    // The engine checks the stored document and root revision at publication.
    // Plan from an empty document so retries reproduce the exact create command.
    const commands=planRecipeAction({doc:new runtime.LoroDoc(),before:null,after,
     actionId,author:runtime.scope.authorDevice,at:after.createdAt});
    const execute=target=>executeAction(target,sequences,actionId,commands,disclosure,beforeNewCommit);
    if(runtime.authority?.installedSet){
     const delivery=runtime.authority.recipeDelivery;
     if(!delivery)throw Error('UNSUPPORTED_VERSION');
     return delivery.create(runtime,after.id,execute);
    }
    return execute(originalRecipeDocuments?await runtime.forRecipe(after.id):runtime);
   });
  },
 };
}
