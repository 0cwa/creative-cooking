import {projectCooking,projectRecipes} from '../domain/app-projection.mjs';
import {executeAction} from './action.mjs';

/** Use the platform's shared workspace operation boundary for reads and saves. */
export function bindHouseholdContent({runtime,withCurrent=use=>use(),sequences,disclosure}) {
 async function recipeRuntime(recipeId){
  if(recipeId===undefined||!runtime.authority?.installedSet)return runtime;
  const {members}=await runtime.authorization();
  return members.some(member=>member.recipeId===recipeId)?runtime.forRecipe(recipeId):runtime;
 }
 return {
  readCooking:()=>withCurrent(async()=>{
   const {doc}=await runtime.document();
   const cooking=projectCooking(doc);
   if(!runtime.authority?.installedSet)return cooking;
   const {members}=await runtime.authorization();
   for(const {recipeId} of members){
    if(recipeId===null)continue;
    const child=await runtime.forRecipe(recipeId);
    const {doc}=await child.document();
    cooking.recipes.push(...projectRecipes(doc));
   }
   cooking.recipes.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
   return cooking;
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
 };
}
