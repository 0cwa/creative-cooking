import {randomUUID} from 'expo-crypto';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type PropsWithChildren, type Dispatch, type SetStateAction } from 'react';
import { RecipeAllergyError, validateRecipeAllergies } from '@/domain/allergyValidation';
import { chatConversationFromMessages, sortChatHistory } from '@/domain/conversations';
import { DEFAULT_STATE, migrateLegacySystemPrompt } from '@/domain/defaults';
import { createPantryItem, normalizeIngredientName, updatePantryItemName } from '@/domain/pantry';
import { normalizeRecipes } from '@/domain/recipeIdentity';
import {
  appendShoppingItems,
  applyShoppingPurchase,
  createShoppingList as createShoppingListCommand,
  migrateLegacyShopping,
  removeShoppingItem as removeShoppingItemCommand,
  removeShoppingList as removeShoppingListCommand,
  setShoppingItemChecked as setShoppingItemCheckedCommand,
  startNewPurchaseCycle as startNewPurchaseCycleCommand,
  updateShoppingItem as updateShoppingItemCommand,
  validateShoppingState,
  type NewShoppingItem,
  type NewShoppingList
} from '@/domain/shopping';
import { preserveRecipeStepIds } from '@/domain/recipeEditing';
import { isDictationEngine, isProviderId, isThemePreference } from '@/domain/types';
import type {
  AppSettings,
  ChatMessage,
  ChefToolProposal,
  ChefToolProposalStatus,
  CookEnergy,
  IngredientPreference,
  MealContext,
  PersistedState,
  Recipe
} from '@/domain/types';
import { useLoroContentRuntime } from '@/loro/app/useLoroContentRuntime';
import { LoroWorkspaceContext } from '@/loro/app/WorkspaceStatus';
import { planChefProposalEffect } from '@/chef/proposalEffect';

function mergeState(saved: Partial<PersistedState> | null): PersistedState {
  if (!saved) return DEFAULT_STATE;

  const recipes = normalizeRecipes(Array.isArray(saved.recipes) ? saved.recipes : []);
  const shopping = saved.shopping === undefined
    ? migrateLegacyShopping(recipes)
    : validateShoppingState(saved.shopping);

  const savedProviderId = saved.settings?.providerId;
  const providerId = isProviderId(savedProviderId)
    ? savedProviderId
    : DEFAULT_STATE.settings.providerId;
  const providerWasInvalid = savedProviderId !== undefined && !isProviderId(savedProviderId);
  const savedModel = saved.settings?.model;
  const model = providerWasInvalid
    ? DEFAULT_STATE.settings.model
    : typeof savedModel === 'string'
      ? savedModel
      : DEFAULT_STATE.settings.model;
  const dictationEngine = isDictationEngine(saved.settings?.dictationEngine)
    ? saved.settings.dictationEngine
    : DEFAULT_STATE.settings.dictationEngine;
  const theme = isThemePreference(saved.settings?.theme)
    ? saved.settings.theme
    : DEFAULT_STATE.settings.theme;
  const chatMessages = Array.isArray(saved.chatMessages) ? saved.chatMessages : [];
  const chatHistory = Array.isArray(saved.chatHistory) ? saved.chatHistory : [];
  const activeConversationId = typeof saved.activeConversationId === 'string'
    ? saved.activeConversationId
    : chatMessages.length
      ? `chat-${chatMessages[0]?.id ?? 'legacy'}`
      : null;

  return {
    ...DEFAULT_STATE,
    ...saved,
    recipes,
    shopping,
    chatMessages,
    chatHistory: sortChatHistory(chatHistory),
    activeConversationId,
    mealContext: { ...DEFAULT_STATE.mealContext, ...(saved.mealContext ?? {}) },
    settings: {
      ...DEFAULT_STATE.settings,
      ...(saved.settings ?? {}),
      providerId,
      model,
      dictationEngine,
      theme,
      systemPrompt: migrateLegacySystemPrompt(saved.settings?.systemPrompt)
    }
  };
}

function archiveActiveChat(current: PersistedState): PersistedState['chatHistory'] {
  if (!current.chatMessages.length) return current.chatHistory;
  const id = current.activeConversationId ?? `chat-${current.chatMessages[0]?.id ?? Date.now()}`;
  const conversation = chatConversationFromMessages(id, current.chatMessages);
  if (!conversation) return current.chatHistory;
  return sortChatHistory([
    conversation,
    ...current.chatHistory.filter((item) => item.id !== conversation.id)
  ]);
}

type AppStateApi = PersistedState & {
  storageMode: 'fresh-local' | 'existing';
  hydrated: boolean;
  storageError: string | null;
  contentWorkspaceName: string;
  localPersistenceStatus: import('@/loro/app/content-runtime-types').LocalPersistenceStatus;
  canEditSharedContent: boolean;
  readRecipeHistory?: import('@/loro/app/content-runtime-types').ContentRuntimeSnapshot['readRecipeHistory'];
  restoreRecipeEdit?(recipeId: string, entry: import('@/loro/app/content-runtime-types').RecipeHistoryEntry): Promise<{refreshed: boolean}>;
  retryStorage(): Promise<boolean>;
  flushCurrentWorkspace(): Promise<void>;
  sharedCookingRefreshPending: boolean;
  refreshSharedCooking?(): Promise<void>;
  beginWorkspaceTransition(): () => void;
  reportContentEditDenied(): void;
  addPantryItems(names: string[], preference?: IngredientPreference): void;
  updatePantryByName(name: string, newName: string): boolean;
  removePantryItem(id: string): void;
  removePantryByName(name: string): boolean;
  setPantryPreference(id: string, preference: IngredientPreference): void;
  setPantryPreferenceByName(name: string, preference: IngredientPreference): boolean;
  validateRecipe(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): void;
  saveRecipe(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): Recipe;
  pendingRecipeTitle: string | null;
  createRecipe(recipe?: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): Promise<{refreshed:boolean}>;
  updateRecipe(id: string, recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): void;
  deleteRecipe(id: string): void;
  createShoppingList(input: NewShoppingList): void;
  addShoppingItems(listId: string, inputs: NewShoppingItem[]): void | Promise<void>;
  updateShoppingItem(id: string, patch: { name: string; displayQuantity?: string; displayUnit?: string }): void;
  removeShoppingItem(id: string): void;
  removeShoppingList(id: string): void;
  setShoppingItemChecked(id: string, cycleId: string, checked: boolean): void;
  startNewPurchaseCycle(listId: string, cycleId: string): void;
  purchaseCheckedShoppingItems(listId: string, cycleId: string, purchaseId: string, purchasedAt: string): void;
  setChatMessages(messages: ChatMessage[]): void;
  appendChatMessage(message: ChatMessage): void;
  setChatProposalStatus(messageId: string, proposalId: string, status: ChefToolProposalStatus): void;
  applyChefProposalEffect(conversationId: string, proposal: ChefToolProposal): Promise<'applied' | 'queued'>;
  newChat(): void;
  openChatConversation(id: string): void;
  deleteChatConversation(id: string): void;
  updateMealContext(patch: Partial<MealContext>): void;
  updateCookEnergy(index: number, energy: CookEnergy): void;
  updateSettings(patch: Partial<AppSettings>): void;
  restoreState(state: PersistedState): void;
};

const AppStateContext = createContext<AppStateApi | null>(null);

export function AppStateProvider({children,localWorkspace:workspace}:PropsWithChildren<{localWorkspace:any}>) {
  const [state,setState]=useState<PersistedState>(DEFAULT_STATE);
  const content=useLoroContentRuntime(state,setState,workspace);
  return <LoroWorkspaceContext workspace={workspace}><AppStateBody state={state} setState={setState} content={content} storageMode="fresh-local" installedRecipeIds={workspace.installedRecipeIds}>{children}</AppStateBody></LoroWorkspaceContext>;
}
function AppStateBody({children,state,setState,content,storageMode,installedRecipeIds}:PropsWithChildren<{state:PersistedState;setState:Dispatch<SetStateAction<PersistedState>>;content:import('@/loro/app/content-runtime-types').ContentRuntimeSnapshot;storageMode:'fresh-local'|'existing';installedRecipeIds?:string[]}>) {
  const transitionInProgress=useRef(false);
  const shoppingCopy=useRef<{key:string;attempt:{actionId:string;at:string;commands:unknown[]|null};
    before:PersistedState;after:PersistedState['shopping']}|null>(null);
  const recipeCreation=useRef<{actionId:string;recipe:Recipe}|null>(null);
  const [pendingRecipeTitle,setPendingRecipeTitle]=useState<string|null>(null);
  const [mutationsPaused,setMutationsPaused]=useState(false);
  const [sharedCookingRefreshPending,setSharedCookingRefreshPending]=useState(false);
  const beginWorkspaceTransition=useCallback(()=>{if(transitionInProgress.current)throw Error('A workspace switch is already in progress.');transitionInProgress.current=true;setMutationsPaused(true);let released=false;return()=>{if(released)return;released=true;transitionInProgress.current=false;setMutationsPaused(false)}},[]);
  const appStateRef = useRef(state);
  const pantryRef = useRef(state.pantry);
  appStateRef.current = state;
  pantryRef.current = state.pantry;
  const updateAppState = useCallback((
    update: PersistedState | ((current: PersistedState) => PersistedState)
  ) => {
    if(transitionInProgress.current)return;
    const current = appStateRef.current;
    const next = typeof update === 'function' ? update(current) : update;
    if (next === current) return;
    content.markLocalStateChange();
    appStateRef.current = next;
    pantryRef.current = next.pantry;
    setState(next);
  }, [content.markLocalStateChange]);
  const hydrated = content.hydrated;
  const storageError = content.storageError;
  const retryStorage = content.retryStorage;
  const flushCurrentWorkspace=useCallback(()=>content.flushCurrentWorkspace(storageMode==='fresh-local'?appStateRef.current:undefined),[content.flushCurrentWorkspace,storageMode]);
  const refreshSharedCooking=useCallback(async()=>{
    try {
      const next=await content.refreshSharedCooking?.();
      if(next){appStateRef.current=next;pantryRef.current=next.pantry;}
      setSharedCookingRefreshPending(false);
    } catch (error) {
      setSharedCookingRefreshPending(true);
      throw error;
    }
  },[content.refreshSharedCooking]);

  const ensureSharedEditAllowed = useCallback(() => {
    if(transitionInProgress.current||sharedCookingRefreshPending)return false;
    if (content.canEditShared) return true;
    content.reportEditDenied();
    return false;
  }, [content.canEditShared, content.reportEditDenied, sharedCookingRefreshPending]);

  const readRecipeHistory = useCallback(async (recipeId: string) => {
    await flushCurrentWorkspace();
    return await content.readRecipeHistory?.(recipeId) ?? [];
  }, [content.readRecipeHistory, flushCurrentWorkspace]);

  const restoreRecipeEdit = useCallback(async (recipeId: string, entry: import('@/loro/app/content-runtime-types').RecipeHistoryEntry) => {
    if (!ensureSharedEditAllowed() || !content.restoreRecipeEdit) throw Error('Recipe editing is unavailable.');
    if (entry.kind === 'recipe-ingredient-field' && entry.field === 'name' && typeof entry.value === 'string') {
      const validation = validateRecipeAllergies([{name:entry.value}],state.settings.allergies);
      if (!validation.ok) throw new RecipeAllergyError(validation.matches);
    }
    const release = beginWorkspaceTransition();
    try {
      await flushCurrentWorkspace();
      await content.restoreRecipeEdit(recipeId, entry);
      try {
        await refreshSharedCooking();
        return {refreshed:true};
      } catch {
        return {refreshed:false};
      }
    } finally {
      release();
    }
  }, [beginWorkspaceTransition, content.restoreRecipeEdit, ensureSharedEditAllowed, flushCurrentWorkspace, refreshSharedCooking, state.settings.allergies]);

  const commitPantry = useCallback((pantry: PersistedState['pantry']) => {
    if (!ensureSharedEditAllowed()) return;
    pantryRef.current = pantry;
    updateAppState((current) => ({ ...current, pantry }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const addPantryItems = useCallback((names: string[], preference: IngredientPreference = 3) => {
    const current = pantryRef.current;
    const existing = new Set(current.map((item) => item.name.toLocaleLowerCase()));
    const additions = names
      .map(normalizeIngredientName)
      .filter(Boolean)
      .filter((name) => !existing.has(name.toLocaleLowerCase()))
      .map((name) => {const item=createPantryItem(name, preference);return storageMode==='fresh-local'?{...item,id:`pantry-${randomUUID()}`}:item;});

    if (additions.length) commitPantry([...additions, ...current]);
  }, [commitPantry, storageMode]);

  const updatePantryByName = useCallback((name: string, newName: string) => {
    const result = updatePantryItemName(pantryRef.current, name, newName);
    if (result.updated) commitPantry(result.items);
    return result.updated;
  }, [commitPantry]);

  const removePantryItem = useCallback((id: string) => {
    const current = pantryRef.current;
    const next = current.filter((item) => item.id !== id);
    if (next.length !== current.length) commitPantry(next);
  }, [commitPantry]);

  const removePantryByName = useCallback((name: string) => {
    const target = normalizeIngredientName(name).toLocaleLowerCase();
    if (!target) return false;

    const current = pantryRef.current;
    const next = current.filter((item) => item.name.toLocaleLowerCase() !== target);
    const removed = next.length !== current.length;
    if (removed) commitPantry(next);
    return removed;
  }, [commitPantry]);

  const setPantryPreference = useCallback((id: string, preference: IngredientPreference) => {
    const current = pantryRef.current;
    const targetIndex = current.findIndex((item) => item.id === id);
    if (targetIndex < 0) return;

    const updatedAt = new Date().toISOString();
    commitPantry(current.map((item, index) => (
      index === targetIndex ? { ...item, preference, updatedAt } : item
    )));
  }, [commitPantry]);

  const setPantryPreferenceByName = useCallback((name: string, preference: IngredientPreference) => {
    const target = normalizeIngredientName(name).toLocaleLowerCase();
    if (!target) return false;

    const current = pantryRef.current;
    const targetIndex = current.findIndex((item) => item.name.toLocaleLowerCase() === target);
    if (targetIndex < 0) return false;

    const updatedAt = new Date().toISOString();
    commitPantry(current.map((item, index) => (
      index === targetIndex ? { ...item, preference, updatedAt } : item
    )));
    return true;
  }, [commitPantry]);

  const validateRecipe = useCallback((input: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>) => {
    const validation = validateRecipeAllergies(input.ingredients, state.settings.allergies);
    if (!validation.ok) throw new RecipeAllergyError(validation.matches);
  }, [state.settings.allergies]);

  const prepareRecipe = useCallback((input: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): Recipe => {
    const now = new Date().toISOString();
    return normalizeRecipes([{
      ...input,
      id: storageMode === 'fresh-local' ? `recipe-${randomUUID()}` : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now,
      updatedAt: now
    }])[0];
  }, [storageMode]);

  const saveRecipe = useCallback((input: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!ensureSharedEditAllowed()) throw new Error('This workspace is not available for editing.');
    if (installedRecipeIds) throw Error('Creating new recipes is not available in this household yet.');
    validateRecipe(input);
    const recipe = prepareRecipe(input);
    updateAppState((current) => ({ ...current, recipes: [recipe, ...current.recipes] }));
    return recipe;
  }, [ensureSharedEditAllowed, installedRecipeIds, prepareRecipe, updateAppState, validateRecipe]);

  const createRecipe = useCallback(async (input?: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!content.createRecipe) {
      if (!input) throw Error('There is no pending recipe save.');
      saveRecipe(input);
      return {refreshed:true};
    }
    if (!ensureSharedEditAllowed()) throw Error('This workspace is not available for editing.');
    let attempt = recipeCreation.current;
    if (input) {
      if (attempt) throw Error('Retry the pending recipe save first.');
      validateRecipe(input);
      attempt = {actionId:randomUUID(),recipe:prepareRecipe(input)};
    }
    if (!attempt) throw Error('There is no pending recipe save.');
    const release = beginWorkspaceTransition();
    try {
      await flushCurrentWorkspace();
      recipeCreation.current = attempt;
      setPendingRecipeTitle(attempt.recipe.title);
      const {actionId,recipe}=attempt;
      try {
        await content.createRecipe(actionId,recipe,()=>validateRecipe(recipe));
      } catch (error) {
        if (error instanceof RecipeAllergyError) {
          recipeCreation.current = null;
          setPendingRecipeTitle(null);
        }
        throw error;
      }
      recipeCreation.current = null;
      setPendingRecipeTitle(null);
      try {
        await refreshSharedCooking();
        return {refreshed:true};
      } catch {
        return {refreshed:false};
      }
    } finally {
      release();
    }
  }, [beginWorkspaceTransition, content.createRecipe, ensureSharedEditAllowed, flushCurrentWorkspace,
    prepareRecipe, refreshSharedCooking, saveRecipe, validateRecipe]);

  const updateRecipe = useCallback((id: string, input: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!ensureSharedEditAllowed()) return;
    const existing = state.recipes.find((recipe) => recipe.id === id);
    const ingredientNamesChanged = !existing
      || existing.ingredients.length !== input.ingredients.length
      || existing.ingredients.some((ingredient, index) => (
        normalizeIngredientName(ingredient.name).toLocaleLowerCase()
        !== normalizeIngredientName(input.ingredients[index]?.name ?? '').toLocaleLowerCase()
      ));

    if (ingredientNamesChanged) {
      const validation = validateRecipeAllergies(input.ingredients, state.settings.allergies);
      if (!validation.ok) throw new RecipeAllergyError(validation.matches);
    }

    updateAppState((current) => ({
      ...current,
      recipes: current.recipes.map((recipe) => (
        recipe.id === id
          ? normalizeRecipes([{
              ...recipe,
              ...input,
              stepIds: preserveRecipeStepIds(input.steps, recipe.steps, recipe.stepIds, id),
              updatedAt: new Date().toISOString()
            }])[0]
          : recipe
      ))
    }));
  }, [ensureSharedEditAllowed, state.recipes, state.settings.allergies, updateAppState]);

  const deleteRecipe = useCallback((id: string) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({ ...current, recipes: current.recipes.filter((recipe) => recipe.id !== id) }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const createShoppingList = useCallback((input: NewShoppingList) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({ ...current, shopping: createShoppingListCommand(current.shopping, input) }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const addShoppingItems = useCallback((listId: string, inputs: NewShoppingItem[]) => {
    if (!ensureSharedEditAllowed()) return;
    const save=content.saveShoppingCopy;
    const recover=content.recoverShoppingCopy;
    if (save && recover && inputs.some(item=>item.recipeId)) {
      const key=JSON.stringify([listId,inputs.map(({recipeId,ingredientId,name,displayQuantity,displayUnit})=>
        [recipeId,ingredientId,name,displayQuantity,displayUnit])]);
      const run=async()=>{
        const release=beginWorkspaceTransition();
        try {
          await flushCurrentWorkspace();
          const prior=shoppingCopy.current;
          if(prior?.key===key){
            try {
              await save(prior.attempt,prior.before,prior.after);
            } catch(error){
              if(prior.attempt.commands)throw error;
              shoppingCopy.current=null;
              await refreshSharedCooking();
              throw error;
            }
            await refreshSharedCooking();
            shoppingCopy.current=null;
            return;
          }
          if(prior){
            const committed=await recover(prior.attempt);
            if(committed)await refreshSharedCooking();
            shoppingCopy.current=null;
          }
          const before=appStateRef.current;
          const after=appendShoppingItems(before.shopping,listId,inputs);
          if(after===before.shopping)return;
          const attempt={actionId:randomUUID(),at:new Date().toISOString(),commands:null};
          shoppingCopy.current={key,attempt,before,after};
          try {
            await save(attempt,before,after);
          } catch(error){
            if(!shoppingCopy.current?.attempt.commands){
              shoppingCopy.current=null;
              if(error instanceof Error&&['CONFLICT','REBASE_REQUIRED','INVALID_RECIPE_SOURCE'].includes(error.message)){
                await refreshSharedCooking();
                throw Error('The recipe or list changed. Review the ingredients and try again.');
              }
            }
            throw error;
          }
          await refreshSharedCooking();
          shoppingCopy.current=null;
        } finally {
          release();
        }
      };
      return run();
    }
    if (inputs.some(item=>item.recipeId&&content.separateRecipeIds?.includes(item.recipeId))) {
      throw Error('Adding ingredients from this recipe is not available yet. You can add items manually.');
    }
    updateAppState((current) => ({ ...current, shopping: appendShoppingItems(current.shopping, listId, inputs) }));
  }, [beginWorkspaceTransition, content.recoverShoppingCopy, content.saveShoppingCopy, content.separateRecipeIds, ensureSharedEditAllowed,
    flushCurrentWorkspace, refreshSharedCooking, updateAppState]);

  const updateShoppingItem = useCallback((id: string, patch: { name: string; displayQuantity?: string; displayUnit?: string }) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({
      ...current,
      shopping: updateShoppingItemCommand(current.shopping, id, patch, new Date().toISOString())
    }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const removeShoppingItem = useCallback((id: string) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({
      ...current,
      shopping: removeShoppingItemCommand(current.shopping, id, new Date().toISOString())
    }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const removeShoppingList = useCallback((id: string) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({
      ...current,
      shopping: removeShoppingListCommand(current.shopping, id, new Date().toISOString())
    }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const setShoppingItemChecked = useCallback((id: string, cycleId: string, checked: boolean) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({
      ...current,
      shopping: setShoppingItemCheckedCommand(current.shopping, id, cycleId, checked, new Date().toISOString())
    }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const startNewPurchaseCycle = useCallback((listId: string, cycleId: string) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({
      ...current,
      shopping: startNewPurchaseCycleCommand(current.shopping, listId, cycleId, new Date().toISOString())
    }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const purchaseCheckedShoppingItems = useCallback((
    listId: string,
    cycleId: string,
    purchaseId: string,
    purchasedAt: string
  ) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => {
      const purchase = applyShoppingPurchase(current.shopping, current.pantry, {
        id: purchaseId,
        listId,
        purchaseCycleId: cycleId,
        purchasedAt
      });
      if (!purchase.applied) return current;
      return { ...current, shopping: purchase.shopping, pantry: purchase.pantry };
    });
  }, [ensureSharedEditAllowed, updateAppState]);

  const setChatMessages = useCallback((messages: ChatMessage[]) => {
    updateAppState((current) => ({
      ...current,
      chatMessages: messages,
      activeConversationId: messages.length
        ? current.activeConversationId ?? `chat-${messages[0]?.id ?? Date.now()}`
        : null
    }));
  }, [updateAppState]);

  const appendChatMessage = useCallback((message: ChatMessage) => {
    updateAppState((current) => ({
      ...current,
      chatMessages: [...current.chatMessages, message],
      activeConversationId: current.activeConversationId ?? `chat-${message.id}`
    }));
  }, [updateAppState]);

  const setChatProposalStatus = useCallback((
    messageId: string,
    proposalId: string,
    status: ChefToolProposalStatus
  ) => {
    updateAppState((current) => ({
      ...current,
      chatMessages: current.chatMessages.map((message) => (
        message.id === messageId
          ? {
              ...message,
              proposals: message.proposals?.map((proposal) => (
                proposal.id === proposalId ? { ...proposal, status } : proposal
              ))
            }
          : message
      ))
    }));
  }, [updateAppState]);

  const applyChefProposalEffect = useCallback(async (conversationId: string, proposal: ChefToolProposal) => {
    if (!ensureSharedEditAllowed()) throw new Error(content.sharedEditDeniedMessage);
    const planned = planChefProposalEffect(state, content.scopeId, conversationId, proposal);
    return content.applyProposalEffect(conversationId, proposal, state, planned.state);
  }, [content.applyProposalEffect, content.scopeId, content.sharedEditDeniedMessage, ensureSharedEditAllowed, state]);

  const newChat = useCallback(() => {
    updateAppState((current) => ({
      ...current,
      chatHistory: archiveActiveChat(current),
      chatMessages: [],
      activeConversationId: null
    }));
  }, [updateAppState]);

  const openChatConversation = useCallback((id: string) => {
    updateAppState((current) => {
      const target = current.chatHistory.find((conversation) => conversation.id === id);
      if (!target) return current;
      return {
        ...current,
        chatHistory: archiveActiveChat(current).filter((conversation) => conversation.id !== id),
        chatMessages: target.messages,
        activeConversationId: target.id
      };
    });
  }, [updateAppState]);

  const deleteChatConversation = useCallback((id: string) => {
    updateAppState((current) => ({
      ...current,
      chatHistory: current.chatHistory.filter((conversation) => conversation.id !== id)
    }));
  }, [updateAppState]);

  const updateMealContext = useCallback((patch: Partial<MealContext>) => {
    updateAppState((current) => ({ ...current, mealContext: { ...current.mealContext, ...patch } }));
  }, [updateAppState]);

  const updateCookEnergy = useCallback((index: number, energy: CookEnergy) => {
    updateAppState((current) => {
      const cooks = [...current.mealContext.cooks];
      cooks[index] = energy;
      return { ...current, mealContext: { ...current.mealContext, cooks } };
    });
  }, [updateAppState]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    updateAppState((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  }, [updateAppState]);

  const restoreState = useCallback((next: PersistedState) => {
    if (!ensureSharedEditAllowed()) return;
    const recipes = normalizeRecipes(next.recipes ?? []);
    updateAppState({
      ...next,
      recipes,
      shopping: next.shopping === undefined ? migrateLegacyShopping(recipes) : validateShoppingState(next.shopping)
    });
  }, [ensureSharedEditAllowed, updateAppState]);

  const value = useMemo<AppStateApi>(
    () => ({
      ...state,
      storageMode,
      hydrated,
      storageError,
      contentWorkspaceName: content.workspaceName,
      localPersistenceStatus: content.localPersistenceStatus,
      canEditSharedContent: content.canEditShared&&!mutationsPaused&&!sharedCookingRefreshPending,
      readRecipeHistory: content.readRecipeHistory && readRecipeHistory,
      restoreRecipeEdit: content.restoreRecipeEdit && restoreRecipeEdit,
      retryStorage,
      flushCurrentWorkspace,
      sharedCookingRefreshPending,
      refreshSharedCooking,
      beginWorkspaceTransition,
      reportContentEditDenied: content.reportEditDenied,
      addPantryItems,
      updatePantryByName,
      removePantryItem,
      removePantryByName,
      setPantryPreference,
      setPantryPreferenceByName,
      validateRecipe,
      saveRecipe,
      pendingRecipeTitle,
      createRecipe,
      updateRecipe,
      deleteRecipe,
      createShoppingList,
      addShoppingItems,
      updateShoppingItem,
      removeShoppingItem,
      removeShoppingList,
      setShoppingItemChecked,
      startNewPurchaseCycle,
      purchaseCheckedShoppingItems,
      setChatMessages,
      appendChatMessage,
      setChatProposalStatus,
      applyChefProposalEffect,
      newChat,
      openChatConversation,
      deleteChatConversation,
      updateMealContext,
      updateCookEnergy,
      updateSettings,
      restoreState
    }),
    [
      state,
      storageMode,
      hydrated,
      storageError,
      content,
      mutationsPaused,
      beginWorkspaceTransition,
      flushCurrentWorkspace,
      sharedCookingRefreshPending,
      refreshSharedCooking,
      readRecipeHistory,
      restoreRecipeEdit,
      retryStorage,
      addPantryItems,
      updatePantryByName,
      removePantryItem,
      removePantryByName,
      setPantryPreference,
      setPantryPreferenceByName,
      validateRecipe,
      saveRecipe,
      pendingRecipeTitle,
      createRecipe,
      updateRecipe,
      deleteRecipe,
      createShoppingList,
      addShoppingItems,
      updateShoppingItem,
      removeShoppingItem,
      removeShoppingList,
      setShoppingItemChecked,
      startNewPurchaseCycle,
      purchaseCheckedShoppingItems,
      setChatMessages,
      appendChatMessage,
      setChatProposalStatus,
      applyChefProposalEffect,
      newChat,
      openChatConversation,
      deleteChatConversation,
      updateMealContext,
      updateCookEnergy,
      updateSettings,
      restoreState
    ]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateApi {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used within AppStateProvider');
  return value;
}

export function makeChatMessage(
  role: ChatMessage['role'],
  content: string,
  proposals?: ChefToolProposal[]
): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(proposals?.length ? { proposals } : {})
  };
}
