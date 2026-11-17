import { createContext, useCallback, useContext, useMemo, useRef, useState, type PropsWithChildren, type Dispatch, type SetStateAction } from 'react';
import { RecipeAllergyError, validateRecipeAllergies } from '@/domain/allergyValidation';
import { chatConversationFromMessages, sortChatHistory } from '@/domain/conversations';
import { DEFAULT_STATE, migrateLegacySystemPrompt } from '@/domain/defaults';
import { createPantryItem, normalizeIngredientName, updatePantryItemName } from '@/domain/pantry';
import { normalizeRecipes } from '@/domain/recipeIdentity';
import { recipeCopyFromConflict, sameRecipeConflictCopy } from '@/domain/recipeConflict';
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
import { isDictationEngine, isProviderId } from '@/domain/types';
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
import { loadState } from '@/storage/appStorage';
import { useContentRuntime } from '@/content/useContentRuntime';
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
  contentWorkspaceId: string;
  contentWorkspaceName: string;
  contentWorkspaceRole: 'owner' | 'editor' | 'viewer' | null;
  contentSyncStatus: import('@/content/useContentRuntime').ContentSyncStatus;
  contentSyncError: string | null;
  localPersistenceStatus: import('@/content/useContentRuntime').LocalPersistenceStatus;
  canEditSharedContent: boolean;
  guestContentAvailable: boolean;
  guestContentDecision: 'merge' | 'keep' | 'in-progress' | null;
  localRecipeConflicts: import('@/content/useContentRuntime').LocalRecipeConflict[];
  saveAttemptedRecipeAsCopy(conflictId: string): Recipe;
  keepWorkspaceRecipeVersion(conflictId: string): Promise<void>;
  personalContentConflicts: import('@/content/contentStore').PersonalContentConflict[];
  recoveryArchives: import('@/content/contentStore').ArchivedWorkspace[];
  retryStorage(): Promise<boolean>;
  selectContentWorkspace(spaceId: string): Promise<void>;
  mergeGuestContent(): Promise<void>;
  keepGuestContent(): Promise<void>;
  prepareAccountExit(): Promise<void>;
  flushCurrentWorkspace(): Promise<void>;
  exportWorkspaceRecovery(): Promise<string>;
  reportContentEditDenied(): void;
  addPantryItems(names: string[], preference?: IngredientPreference): void;
  updatePantryByName(name: string, newName: string): boolean;
  removePantryItem(id: string): void;
  removePantryByName(name: string): boolean;
  setPantryPreference(id: string, preference: IngredientPreference): void;
  setPantryPreferenceByName(name: string, preference: IngredientPreference): boolean;
  validateRecipe(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): void;
  saveRecipe(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): Recipe;
  updateRecipe(id: string, recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): void;
  deleteRecipe(id: string): void;
  createShoppingList(input: NewShoppingList): void;
  addShoppingItems(listId: string, inputs: NewShoppingItem[]): void;
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

export function AppStateProvider({children,localWorkspace}:PropsWithChildren<{localWorkspace?:any}>) {
  return localWorkspace ? <LocalAppStateProvider workspace={localWorkspace}>{children}</LocalAppStateProvider> : <LegacyAppStateProvider>{children}</LegacyAppStateProvider>;
}
function LegacyAppStateProvider({children}:PropsWithChildren) {
  const [state,setState]=useState<PersistedState>(DEFAULT_STATE);
  const readLegacy=useCallback(async()=>{const saved=await loadState();return {state:saved?mergeState(saved):null,hadData:saved!==null}},[]);
  const content=useContentRuntime(state,setState,readLegacy);
  return <AppStateBody state={state} setState={setState} content={content} storageMode="existing">{children}</AppStateBody>;
}
function LocalAppStateProvider({children,workspace}:PropsWithChildren<{workspace:any}>) {
  const [state,setState]=useState<PersistedState>(DEFAULT_STATE);
  const content=useLoroContentRuntime(state,setState,workspace);
  return <LoroWorkspaceContext workspace={workspace}><AppStateBody state={state} setState={setState} content={content} storageMode="fresh-local">{children}</AppStateBody></LoroWorkspaceContext>;
}
function AppStateBody({children,state,setState,content,storageMode}:PropsWithChildren<{state:PersistedState;setState:Dispatch<SetStateAction<PersistedState>>;content:import('@/content/useContentRuntime').ContentRuntimeSnapshot;storageMode:'fresh-local'|'existing'}>) {
  const appStateRef = useRef(state);
  const pantryRef = useRef(state.pantry);
  appStateRef.current = state;
  pantryRef.current = state.pantry;
  const updateAppState = useCallback((
    update: PersistedState | ((current: PersistedState) => PersistedState)
  ) => {
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

  const ensureSharedEditAllowed = useCallback(() => {
    if (content.canEditShared) return true;
    content.reportEditDenied();
    return false;
  }, [content.canEditShared, content.reportEditDenied]);

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
      .map((name) => createPantryItem(name, preference));

    if (additions.length) commitPantry([...additions, ...current]);
  }, [commitPantry]);

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

  const saveRecipe = useCallback((input: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!ensureSharedEditAllowed()) throw new Error('This workspace is not available for editing.');
    validateRecipe(input);

    const now = new Date().toISOString();
    const recipe: Recipe = normalizeRecipes([{
      ...input,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now,
      updatedAt: now
    }])[0];
    updateAppState((current) => ({ ...current, recipes: [recipe, ...current.recipes] }));
    return recipe;
  }, [ensureSharedEditAllowed, updateAppState, validateRecipe]);

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

  const saveAttemptedRecipeAsCopy = useCallback((conflictId: string): Recipe => {
    if (!ensureSharedEditAllowed()) throw new Error('This workspace is not available for editing.');
    const conflict = content.recipeConflicts.find((item) => item.id === conflictId);
    if (!conflict) throw new Error('This recipe conflict is no longer available. Export recovery data before continuing.');
    const copy = recipeCopyFromConflict(conflict);
    if (!copy) throw new Error('This attempted operation cannot be copied as a recipe. Its full details remain in the recovery export.');

    const existing = appStateRef.current.recipes.find((recipe) => recipe.id === copy.id);
    if (existing) {
      if (!sameRecipeConflictCopy(existing, copy)) {
        throw new Error('A different recipe already uses this recovery identity. The conflict remains available for export.');
      }
      return existing;
    }

    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = copy;
    validateRecipe(input);
    updateAppState((current) => current.recipes.some((recipe) => recipe.id === copy.id)
      ? current
      : { ...current, recipes: [copy, ...current.recipes] });
    return copy;
  }, [content.recipeConflicts, ensureSharedEditAllowed, updateAppState, validateRecipe]);

  const keepWorkspaceRecipeVersion = useCallback(async (conflictId: string) => {
    await content.flushCurrentWorkspace();
    await content.keepWorkspaceRecipeVersion(conflictId);
  }, [content.keepWorkspaceRecipeVersion, content.flushCurrentWorkspace]);

  const createShoppingList = useCallback((input: NewShoppingList) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({ ...current, shopping: createShoppingListCommand(current.shopping, input) }));
  }, [ensureSharedEditAllowed, updateAppState]);

  const addShoppingItems = useCallback((listId: string, inputs: NewShoppingItem[]) => {
    if (!ensureSharedEditAllowed()) return;
    updateAppState((current) => ({ ...current, shopping: appendShoppingItems(current.shopping, listId, inputs) }));
  }, [ensureSharedEditAllowed, updateAppState]);

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
    const planned = planChefProposalEffect(state, content.scope.spaceId, conversationId, proposal);
    return content.applyProposalEffect(conversationId, proposal, state, planned.state);
  }, [content.applyProposalEffect, content.scope.spaceId, content.sharedEditDeniedMessage, ensureSharedEditAllowed, state]);

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
      contentWorkspaceId: content.scope.spaceId,
      contentWorkspaceName: content.workspaceName,
      contentWorkspaceRole: content.role,
      contentSyncStatus: content.syncStatus,
      contentSyncError: content.syncError,
      localPersistenceStatus: content.localPersistenceStatus,
      canEditSharedContent: content.canEditShared,
      guestContentAvailable: content.guestAdoption.available,
      guestContentDecision: content.guestAdoption.decision,
      localRecipeConflicts: content.recipeConflicts,
      saveAttemptedRecipeAsCopy,
      keepWorkspaceRecipeVersion,
      personalContentConflicts: content.personalConflicts,
      recoveryArchives: content.archives,
      retryStorage,
      selectContentWorkspace: content.selectWorkspace,
      mergeGuestContent: content.mergeGuestContent,
      keepGuestContent: content.keepGuestContent,
      prepareAccountExit: content.prepareAccountExit,
      flushCurrentWorkspace: content.flushCurrentWorkspace,
      exportWorkspaceRecovery: content.exportWorkspaceRecovery,
      reportContentEditDenied: content.reportEditDenied,
      addPantryItems,
      updatePantryByName,
      removePantryItem,
      removePantryByName,
      setPantryPreference,
      setPantryPreferenceByName,
      validateRecipe,
      saveRecipe,
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
      saveAttemptedRecipeAsCopy,
      keepWorkspaceRecipeVersion,
      retryStorage,
      addPantryItems,
      updatePantryByName,
      removePantryItem,
      removePantryByName,
      setPantryPreference,
      setPantryPreferenceByName,
      validateRecipe,
      saveRecipe,
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
