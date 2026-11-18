import {projectCooking,projectRecipes} from '../domain/app-projection.mjs';
import {executeAction} from './action.mjs';
import {planRecipeAction} from './recipe-actions.mjs';
import {openSelectedRecipeCatalog,projectSelectedRecipes} from './selected-recipe-catalog.mjs';

/** Use the platform's shared workspace operation boundary for reads and saves. */
export function bindHouseholdContent({runtime,withCurrent=use=>use(),sequences,disclosure,originalRecipeDocuments=false}) {
 async function recipeRuntime(recipeId){
  if(recipeId===undefined)return runtime;
  if(runtime.authority?.installedSet){
   const {members}=await runtime.authorization();
   if(members.some(member=>member.recipeId===recipeId))return runtime.forRecipe(recipeId);
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
   if(!runtime.authority?.installedSet)return {...cooking,separateRecipeIds:[]};
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
   const input=structuredClone(commands);
   return withCurrent(async()=>{
    const target=await recipeRuntime(recipeId);
    return executeAction(target,sequences,actionId,input,disclosure);
   });
  },
  createRecipe:(actionId,recipe,beforeNewCommit=/** @type {(() => void)|undefined} */(undefined))=>{
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
