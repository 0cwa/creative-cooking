import {randomUUID} from 'expo-crypto';
import {useCallback,useEffect,useRef,useState,type Dispatch,type SetStateAction} from 'react';
import {DEFAULT_STATE} from '@/domain/defaults';
import type {PersistedState} from '@/domain/types';
import type {ContentRuntimeSnapshot} from '@/content/useContentRuntime';
import {projectCooking} from '../domain/app-projection.mjs';
import {projectPersonal} from '../domain/personal-codec.mjs';
import {planPersonalAction} from './personal-actions.mjs';
import {planPantryAction} from './pantry-actions.mjs';
import {planRecipeAction} from './recipe-actions.mjs';
import {planShoppingAction} from './shopping-actions.mjs';
import {executeAction} from './action.mjs';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const unavailable=async()=>{throw Error('This action is not available in the fresh local preview. Your existing workspace remains available separately.');};
// First-cut binding: cooking edits and personal data use separate authorities. Unsupported changes stay open
// with an error; they are never written to the old workspace or shown as saved.
export function useLoroContentRuntime(state:PersistedState,setState:Dispatch<SetStateAction<PersistedState>>,workspace:any):ContentRuntimeSnapshot {
 const [hydrated,setHydrated]=useState(false),[error,setError]=useState<string|null>(null),[status,setStatus]=useState<'saving'|'saved'|'error'>('saving');
 const unresolved=useRef<(()=>Promise<void>)|null>(null);
 const initialize=useRef<(()=>Promise<boolean>)|null>(null);
 const actionIds=useRef(new Map<string,{id:string,commands:any[]}>()),current=useRef(state),committed=useRef<PersistedState|null>(null),queue=useRef<Promise<void>>(Promise.resolve()),revision=useRef(0),pending=useRef(0);current.current=state;
 useEffect(()=>{let active=true;const open=async()=>{if(!active)return false;setStatus('saving');setError(null);try{const {doc}=await workspace.household.document();const cooking=projectCooking(doc);const personal=projectPersonal((await workspace.personal.document()).doc);const {mealContext,activeConversationId,recoveryReminderDismissed: _recoveryReminderDismissed,...settings}=personal.preferences;const selectedConversation=personal.conversations.find((c:any)=>c.id===activeConversationId);const initial={...DEFAULT_STATE,...cooking,settings:{...DEFAULT_STATE.settings,...settings},mealContext:mealContext??DEFAULT_STATE.mealContext,activeConversationId:selectedConversation?.id??null,chatMessages:selectedConversation?.messages??[],chatHistory:personal.conversations.filter((c:any)=>c.id!==selectedConversation?.id)};if(active){committed.current=initial;current.current=initial;setState(initial);setStatus('saved');setHydrated(true);return true}return false}catch(e){if(active){setError(e instanceof Error?e.message:'Could not open local workspace');setStatus('error');setHydrated(true)}return false}};initialize.current=open;void open();return()=>{active=false;if(initialize.current===open)initialize.current=null}},[workspace,setState]);
 const save=useCallback(async(target:PersistedState)=>{
  // Resolve the exact earlier action before deriving a later target from disk.
  if(unresolved.current){await unresolved.current();unresolved.current=null;}
  const before=committed.current;if(!before)throw Error('The local workspace has not opened.');
  const shoppingChanged=!same(before.shopping,target.shopping);
  const pantryChanged=!same(before.pantry,target.pantry),recipesChanged=!same(before.recipes,target.recipes);
  const personalChanged=['chatMessages','chatHistory','activeConversationId','mealContext','settings'].some(k=>!same(before[k as keyof PersistedState],target[k as keyof PersistedState]));
  if((shoppingChanged&&(recipesChanged||personalChanged))||(!shoppingChanged&&[pantryChanged,recipesChanged,personalChanged].filter(Boolean).length>1))throw Error('This local preview cannot save this combined change yet.');
  if(!shoppingChanged&&!pantryChanged&&!recipesChanged&&!personalChanged)return;
  const runtime=personalChanged?workspace.personal:workspace.household,key=JSON.stringify(target),saved=actionIds.current.get(key),actionId=saved?.id??randomUUID(),at=new Date().toISOString();let commands:any[];
  if(saved)commands=saved.commands;else {const {doc}=await runtime.document();
  if(shoppingChanged)commands=planShoppingAction({doc,before:before.shopping,after:target.shopping,pantryBefore:before.pantry,pantryAfter:target.pantry,actionId,author:workspace.deviceId,at});
  else if(personalChanged)commands=planPersonalAction({doc,before,after:target,actionId});
  else if(pantryChanged)commands=planPantryAction({doc,before:before.pantry,after:target.pantry,actionId,author:workspace.deviceId,at});
  else {const a=new Map(before.recipes.map(x=>[x.id,x])),b=new Map(target.recipes.map(x=>[x.id,x])),changed=[...new Set([...a.keys(),...b.keys()])].filter(id=>!same(a.get(id),b.get(id)));if(changed.length!==1)throw Error('This local preview saves one recipe change at a time.');const id=changed[0];commands=planRecipeAction({doc,before:a.get(id)??null,after:b.get(id)??null,actionId,author:workspace.deviceId,at});}
  actionIds.current.set(key,{id:actionId,commands});}
  unresolved.current=async()=>{
   if(commands.length)await executeAction(runtime,workspace.sequences,actionId,commands,personalChanged?null:workspace.disclosure);
   actionIds.current.delete(key);committed.current=target;
  };
  await unresolved.current();unresolved.current=null;
 },[workspace]);
 const schedule=useCallback((target:PersistedState)=>{const number=++revision.current;pending.current++;setStatus('saving');const next=queue.current.catch(()=>{}).then(()=>save(target));queue.current=next;void next.then(()=>{pending.current--;if(number===revision.current){setStatus('saved');setError(null)}},e=>{pending.current--;if(number===revision.current){setStatus('error');setError(e instanceof Error?e.message:'Could not save local changes')}});return next},[save]);
 useEffect(()=>{if(!hydrated||!committed.current)return;if(same(state,committed.current)&&pending.current===0){setStatus('saved');return}void schedule(state).catch(()=>{});},[state,hydrated,schedule]);
 const retryStorage=useCallback(async()=>{if(!committed.current)return await initialize.current?.()??false;try{await schedule(current.current);return true}catch{return false}},[schedule]);
 return {hydrated,storageError:error,scope:{kind:'guest',profileId:'guest',spaceId:workspace.household.scope.scopeId},workspaceName:'Fresh local workspace',role:null,syncStatus:'local-only',syncError:null,localPersistenceStatus:status,canEditShared:hydrated&&!!committed.current,sharedEditDeniedMessage:'The local workspace is opening.',guestAdoption:{available:false,migrationId:null,decision:null},recipeConflicts:[],personalConflicts:[],archives:[],localProfileId:'fresh-local',markLocalStateChange:()=>{setStatus('saving');return revision.current+1},selectWorkspace:unavailable,keepWorkspaceRecipeVersion:unavailable,mergeGuestContent:unavailable,keepGuestContent:unavailable,prepareAccountExit:unavailable,applyProposalEffect:unavailable,flushCurrentWorkspace:async(target=current.current)=>{await schedule(target)},retryStorage,exportWorkspaceRecovery:unavailable,reportEditDenied:()=>setError('The local workspace is opening.')};
}
