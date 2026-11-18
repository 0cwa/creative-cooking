import {randomUUID} from 'expo-crypto';
import {useCallback,useEffect,useRef,useState,type Dispatch,type SetStateAction} from 'react';
import {DEFAULT_STATE} from '@/domain/defaults';
import type {PersistedState} from '@/domain/types';
import type {ContentRuntimeSnapshot,RecipeHistoryEntry} from '@/content/useContentRuntime';
import {projectCooking} from '../domain/app-projection.mjs';
import {planRecipeRestore,readRecipeHistory as recipeHistory} from '../domain/recipe-history.mjs';
import {projectPersonal} from '../domain/personal-codec.mjs';
import {planPersonalAction} from './personal-actions.mjs';
import {planPantryAction} from './pantry-actions.mjs';
import {planRecipeAction} from './recipe-actions.mjs';
import {planShoppingAction} from './shopping-actions.mjs';
import {executeAction} from './action.mjs';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const unavailable=async()=>{throw Error('This action is not available in the fresh local preview. Your existing workspace remains available separately.');};
function historyContext(scope:any) {
 const {scopeId,branchHead,documentId,documentGeneration,epochId}=scope;
 return JSON.stringify([scopeId,branchHead,documentId,documentGeneration,epochId]);
}
async function readCooking(workspace:any) {
 return workspace.householdContent
  ? workspace.householdContent.readCooking()
  : projectCooking((await workspace.household.document()).doc);
}
async function readRecipeDocument(workspace:any,recipeId:string) {
 return workspace.householdContent
  ? workspace.householdContent.readRecipe(recipeId)
  : {...await workspace.household.document(),scope:workspace.household.scope};
}
// First-cut binding: cooking edits and personal data use separate authorities. Unsupported changes stay open
// with an error; they are never written to the old workspace or shown as saved.
export function useLoroContentRuntime(state:PersistedState,setState:Dispatch<SetStateAction<PersistedState>>,workspace:any):ContentRuntimeSnapshot {
 const [hydrated,setHydrated]=useState(false),[error,setError]=useState<string|null>(null),[status,setStatus]=useState<'saving'|'saved'|'error'>('saving');
 const unresolved=useRef<(()=>Promise<void>)|null>(null);
 const restoreAttempt=useRef<{key:string;actionId:string;command:any}|null>(null);
 const initialize=useRef<(()=>Promise<boolean>)|null>(null);
 const actionIds=useRef(new Map<string,{id:string,commands:any[]}>()),current=useRef(state),committed=useRef<PersistedState|null>(null),queue=useRef<Promise<unknown>>(Promise.resolve()),revision=useRef(0),pending=useRef(0);
 const projection=useRef({generation:0,replaced:null as PersistedState|null});
 if(state!==projection.current.replaced)current.current=state;
 const executeHousehold=useCallback((actionId:string,commands:any[],recipeId?:string)=>workspace.householdContent
  ? workspace.householdContent.execute(actionId,commands,recipeId)
  : workspace.executeHouseholdAction
  ? workspace.executeHouseholdAction(actionId,commands)
  : executeAction(workspace.household,workspace.sequences,actionId,commands,workspace.disclosure),[workspace]);
 useEffect(()=>{let active=true;const open=async()=>{if(!active)return false;setStatus('saving');setError(null);try{const cooking=await readCooking(workspace);const personal=projectPersonal((await workspace.personal.document()).doc);const {mealContext,activeConversationId,recoveryReminderDismissed: _recoveryReminderDismissed,...settings}=personal.preferences;const selectedConversation=personal.conversations.find((c:any)=>c.id===activeConversationId);const initial={...DEFAULT_STATE,...cooking,settings:{...DEFAULT_STATE.settings,...settings},mealContext:mealContext??DEFAULT_STATE.mealContext,activeConversationId:selectedConversation?.id??null,chatMessages:selectedConversation?.messages??[],chatHistory:personal.conversations.filter((c:any)=>c.id!==selectedConversation?.id)};if(active){committed.current=initial;current.current=initial;setState(initial);setStatus('saved');setHydrated(true);return true}return false}catch(e){if(active){setError(e instanceof Error?e.message:'Could not open local workspace');setStatus('error');setHydrated(true)}return false}};initialize.current=open;void open();return()=>{active=false;if(initialize.current===open)initialize.current=null}},[workspace,setState]);
 const save=useCallback(async(target:PersistedState)=>{
  // Resolve the exact earlier action before deriving a later target from disk.
  if(unresolved.current){await unresolved.current();unresolved.current=null;}
  const before=committed.current;if(!before)throw Error('The local workspace has not opened.');
  const shoppingChanged=!same(before.shopping,target.shopping);
  const pantryChanged=!same(before.pantry,target.pantry),recipesChanged=!same(before.recipes,target.recipes);
  const personalChanged=['chatMessages','chatHistory','activeConversationId','mealContext','settings'].some(k=>!same(before[k as keyof PersistedState],target[k as keyof PersistedState]));
  if((shoppingChanged&&(recipesChanged||personalChanged))||(!shoppingChanged&&[pantryChanged,recipesChanged,personalChanged].filter(Boolean).length>1))throw Error('This local preview cannot save this combined change yet.');
  if(!shoppingChanged&&!pantryChanged&&!recipesChanged&&!personalChanged)return;
  let recipeId:string|undefined,recipeBefore=null,recipeAfter=null;
  if(recipesChanged){
   const original=new Map(before.recipes.map(recipe=>[recipe.id,recipe]));
   const updated=new Map(target.recipes.map(recipe=>[recipe.id,recipe]));
   const changed=[...new Set([...original.keys(),...updated.keys()])].filter(id=>!same(original.get(id),updated.get(id)));
   if(changed.length!==1)throw Error('This local preview saves one recipe change at a time.');
   [recipeId]=changed;
   recipeBefore=original.get(recipeId)??null;
   recipeAfter=updated.get(recipeId)??null;
  }
  const runtime=personalChanged?workspace.personal:workspace.household,key=JSON.stringify(target),saved=actionIds.current.get(key),actionId=saved?.id??randomUUID(),at=new Date().toISOString();let commands:any[];
  if(saved)commands=saved.commands;else {const {doc}=recipeId===undefined?await runtime.document():await readRecipeDocument(workspace,recipeId);
  if(shoppingChanged)commands=planShoppingAction({doc,before:before.shopping,after:target.shopping,pantryBefore:before.pantry,pantryAfter:target.pantry,actionId,author:workspace.deviceId,at});
  else if(personalChanged)commands=planPersonalAction({doc,before,after:target,actionId});
  else if(pantryChanged)commands=planPantryAction({doc,before:before.pantry,after:target.pantry,actionId,author:workspace.deviceId,at});
  else commands=planRecipeAction({doc,before:recipeBefore,after:recipeAfter,actionId,author:workspace.deviceId,at});
  actionIds.current.set(key,{id:actionId,commands});}
  unresolved.current=async()=>{
   if(commands.length){
    if(personalChanged)await executeAction(runtime,workspace.sequences,actionId,commands);
    else await executeHousehold(actionId,commands,recipeId);
   }
   actionIds.current.delete(key);committed.current=target;
  };
  await unresolved.current();unresolved.current=null;
 },[workspace,executeHousehold]);
 const schedule=useCallback((target:PersistedState)=>{const number=++revision.current,generation=projection.current.generation;pending.current++;setStatus('saving');const next=queue.current.catch(()=>{}).then(async()=>{if(generation===projection.current.generation)await save(target)});queue.current=next;void next.then(()=>{pending.current--;if(number===revision.current){setStatus('saved');setError(null)}},e=>{pending.current--;if(number===revision.current){setStatus('error');setError(e instanceof Error?e.message:'Could not save local changes')}});return next},[save]);
 useEffect(()=>{if(!hydrated||!committed.current||state===projection.current.replaced)return;if(same(state,committed.current)&&pending.current===0){setStatus('saved');return}void schedule(state).catch(()=>{});},[state,hydrated,schedule]);
 const retryStorage=useCallback(async()=>{if(!committed.current)return await initialize.current?.()??false;try{await schedule(current.current);return true}catch{return false}},[schedule]);
 const readRecipeHistory=useCallback(async(recipeId:string):Promise<RecipeHistoryEntry[]>=>{
  const {doc,scope}=await readRecipeDocument(workspace,recipeId);
  const context=historyContext(scope);
  return recipeHistory(doc,recipeId).map(entry=>({...entry,context}));
 },[workspace]);
 const restoreRecipeEdit=useCallback(async(recipeId:string,entry:RecipeHistoryEntry)=>{
  const {doc,scope}=await readRecipeDocument(workspace,recipeId);
  if(entry.context!==historyContext(scope))throw Error('The household changed. Reopen recipe history.');
  const key=JSON.stringify([entry.context,recipeId,entry.effectId,entry.head]);
  let attempt=restoreAttempt.current;
  if(attempt?.key!==key) {
   const actionId=randomUUID();
   const command=planRecipeRestore({doc,recipeId,effectId:entry.effectId,expectedHead:entry.head,actionId,author:workspace.deviceId,at:new Date().toISOString()});
   if(!command)return;
   attempt={key,actionId,command};
   restoreAttempt.current=attempt;
  }
  const {actionId,command}=attempt;
  if(workspace.executeHouseholdAction) await executeHousehold(actionId,[command],recipeId);
  else {
   const {selection,selectedHousehold}=workspace.householdPairing;
   const scopeId=selectedHousehold?workspace.household.scope.scopeId:null;
   await selection.withCurrent(scopeId,()=>executeHousehold(actionId,[command],recipeId));
  }
  restoreAttempt.current=null;
 },[workspace,executeHousehold]);
 const refreshSharedCooking=useCallback(async()=>{
  if(!committed.current)throw Error('The local workspace has not opened.');
  // The caller has paused edits and flushed the latest target. Drain any
  // duplicate React saves before replacing the projection from the same disk.
  const refresh=queue.current.then(async()=>{
   const cooking=await readCooking(workspace);
   if(!committed.current)throw Error('The local workspace has not opened.');
   const next={...committed.current,...cooking};
   projection.current={generation:projection.current.generation+1,replaced:current.current};
   committed.current=next;
   current.current=next;
   setState(next);
   return next;
  });
  queue.current=refresh;
  return refresh;
 },[setState,workspace]);
 return {hydrated,storageError:error,scope:{kind:'guest',profileId:'guest',spaceId:workspace.household.scope.scopeId},workspaceName:'Fresh local workspace',role:null,syncStatus:'local-only',syncError:null,localPersistenceStatus:status,canEditShared:hydrated&&!!committed.current,sharedEditDeniedMessage:'The local workspace is opening.',guestAdoption:{available:false,migrationId:null,decision:null},recipeConflicts:[],personalConflicts:[],archives:[],localProfileId:'fresh-local',markLocalStateChange:()=>{setStatus('saving');return revision.current+1},selectWorkspace:unavailable,keepWorkspaceRecipeVersion:unavailable,readRecipeHistory,restoreRecipeEdit,mergeGuestContent:unavailable,keepGuestContent:unavailable,prepareAccountExit:unavailable,applyProposalEffect:unavailable,flushCurrentWorkspace:async(target=current.current)=>{await schedule(target)},refreshSharedCooking,retryStorage,exportWorkspaceRecovery:unavailable,reportEditDenied:()=>setError('The local workspace is opening.')};
}
