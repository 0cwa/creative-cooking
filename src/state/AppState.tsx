import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { RecipeAllergyError, validateRecipeAllergies } from '@/domain/allergyValidation';
import { DEFAULT_STATE, migrateLegacySystemPrompt } from '@/domain/defaults';
import { createPantryItem, normalizeIngredientName, updatePantryItemName } from '@/domain/pantry';
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
import { loadState, saveState } from '@/storage/appStorage';

function mergeState(saved: Partial<PersistedState> | null): PersistedState {
  if (!saved) return DEFAULT_STATE;

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

  return {
    ...DEFAULT_STATE,
    ...saved,
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

type AppStateApi = PersistedState & {
  hydrated: boolean;
  storageError: string | null;
  retryStorage(): Promise<boolean>;
  addPantryItems(names: string[], preference?: IngredientPreference): void;
  updatePantryByName(name: string, newName: string): boolean;
  removePantryItem(id: string): void;
  removePantryByName(name: string): boolean;
  setPantryPreference(id: string, preference: IngredientPreference): void;
  setPantryPreferenceByName(name: string, preference: IngredientPreference): boolean;
  saveRecipe(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): Recipe;
  updateRecipe(id: string, recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): void;
  deleteRecipe(id: string): void;
  setChatMessages(messages: ChatMessage[]): void;
  appendChatMessage(message: ChatMessage): void;
  setChatProposalStatus(messageId: string, proposalId: string, status: ChefToolProposalStatus): void;
  newChat(): void;
  updateMealContext(patch: Partial<MealContext>): void;
  updateCookEnergy(index: number, energy: CookEnergy): void;
  updateSettings(patch: Partial<AppSettings>): void;
  restoreState(state: PersistedState): void;
};

const AppStateContext = createContext<AppStateApi | null>(null);

export function AppStateProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<PersistedState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageWritable, setStorageWritable] = useState(true);

  const describeStorageError = useCallback((error: unknown) => (
    error instanceof Error ? error.message : 'Creative Cooking could not save local data.'
  ), []);

  useEffect(() => {
    let active = true;
    loadState()
      .then((saved) => {
        if (active) setState(mergeState(saved));
      })
      .catch((error) => {
        if (!active) return;
        setStorageError(describeStorageError(error));
        setStorageWritable(false);
      })
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, [describeStorageError]);

  useEffect(() => {
    if (!hydrated || !storageWritable) return;
    let active = true;
    void saveState(state)
      .then(() => {
        if (active) setStorageError(null);
      })
      .catch((error) => {
        if (!active) return;
        setStorageError(describeStorageError(error));
        setStorageWritable(false);
      });
    return () => {
      active = false;
    };
  }, [describeStorageError, hydrated, state, storageWritable]);

  const retryStorage = useCallback(async () => {
    try {
      await saveState(state);
      setStorageWritable(true);
      setStorageError(null);
      return true;
    } catch (error) {
      setStorageWritable(false);
      setStorageError(describeStorageError(error));
      return false;
    }
  }, [describeStorageError, state]);

  const addPantryItems = useCallback((names: string[], preference: IngredientPreference = 3) => {
    setState((current) => {
      const existing = new Set(current.pantry.map((item) => item.name.toLocaleLowerCase()));
      const additions = names
        .map(normalizeIngredientName)
        .filter(Boolean)
        .filter((name) => !existing.has(name.toLocaleLowerCase()))
        .map((name) => createPantryItem(name, preference));
      return { ...current, pantry: [...additions, ...current.pantry] };
    });
  }, []);

  const updatePantryByName = useCallback((name: string, newName: string) => {
    let updated = false;
    setState((current) => {
      const result = updatePantryItemName(current.pantry, name, newName);
      updated = result.updated;
      return result.updated ? { ...current, pantry: result.items } : current;
    });
    return updated;
  }, []);

  const removePantryItem = useCallback((id: string) => {
    setState((current) => ({ ...current, pantry: current.pantry.filter((item) => item.id !== id) }));
  }, []);

  const removePantryByName = useCallback((name: string) => {
    let removed = false;
    setState((current) => {
      const target = normalizeIngredientName(name).toLocaleLowerCase();
      const next = current.pantry.filter((item) => {
        const isMatch = item.name.toLocaleLowerCase() === target;
        if (isMatch) removed = true;
        return !isMatch;
      });
      return { ...current, pantry: next };
    });
    return removed;
  }, []);

  const setPantryPreference = useCallback((id: string, preference: IngredientPreference) => {
    setState((current) => ({
      ...current,
      pantry: current.pantry.map((item) =>
        item.id === id ? { ...item, preference, updatedAt: new Date().toISOString() } : item
      )
    }));
  }, []);

  const setPantryPreferenceByName = useCallback((name: string, preference: IngredientPreference) => {
    let updated = false;
    const target = normalizeIngredientName(name).toLocaleLowerCase();
    setState((current) => ({
      ...current,
      pantry: current.pantry.map((item) => {
        if (item.name.toLocaleLowerCase() !== target) return item;
        updated = true;
        return { ...item, preference, updatedAt: new Date().toISOString() };
      })
    }));
    return updated;
  }, []);

  const saveRecipe = useCallback((input: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>) => {
    const validation = validateRecipeAllergies(input.ingredients, state.settings.allergies);
    if (!validation.ok) throw new RecipeAllergyError(validation.matches);

    const now = new Date().toISOString();
    const recipe: Recipe = {
      ...input,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now,
      updatedAt: now
    };
    setState((current) => ({ ...current, recipes: [recipe, ...current.recipes] }));
    return recipe;
  }, [state.settings.allergies]);

  const updateRecipe = useCallback((id: string, input: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>) => {
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

    setState((current) => ({
      ...current,
      recipes: current.recipes.map((recipe) => (
        recipe.id === id
          ? { ...recipe, ...input, updatedAt: new Date().toISOString() }
          : recipe
      ))
    }));
  }, [state.recipes, state.settings.allergies]);

  const deleteRecipe = useCallback((id: string) => {
    setState((current) => ({ ...current, recipes: current.recipes.filter((recipe) => recipe.id !== id) }));
  }, []);

  const setChatMessages = useCallback((messages: ChatMessage[]) => {
    setState((current) => ({ ...current, chatMessages: messages }));
  }, []);

  const appendChatMessage = useCallback((message: ChatMessage) => {
    setState((current) => ({ ...current, chatMessages: [...current.chatMessages, message] }));
  }, []);

  const setChatProposalStatus = useCallback((
    messageId: string,
    proposalId: string,
    status: ChefToolProposalStatus
  ) => {
    setState((current) => ({
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
  }, []);

  const newChat = useCallback(() => {
    setState((current) => ({ ...current, chatMessages: [] }));
  }, []);

  const updateMealContext = useCallback((patch: Partial<MealContext>) => {
    setState((current) => ({ ...current, mealContext: { ...current.mealContext, ...patch } }));
  }, []);

  const updateCookEnergy = useCallback((index: number, energy: CookEnergy) => {
    setState((current) => {
      const cooks = [...current.mealContext.cooks];
      cooks[index] = energy;
      return { ...current, mealContext: { ...current.mealContext, cooks } };
    });
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  }, []);

  const restoreState = useCallback((next: PersistedState) => {
    setState(next);
  }, []);

  const value = useMemo<AppStateApi>(
    () => ({
      ...state,
      hydrated,
      storageError,
      retryStorage,
      addPantryItems,
      updatePantryByName,
      removePantryItem,
      removePantryByName,
      setPantryPreference,
      setPantryPreferenceByName,
      saveRecipe,
      updateRecipe,
      deleteRecipe,
      setChatMessages,
      appendChatMessage,
      setChatProposalStatus,
      newChat,
      updateMealContext,
      updateCookEnergy,
      updateSettings,
      restoreState
    }),
    [
      state,
      hydrated,
      storageError,
      retryStorage,
      addPantryItems,
      updatePantryByName,
      removePantryItem,
      removePantryByName,
      setPantryPreference,
      setPantryPreferenceByName,
      saveRecipe,
      updateRecipe,
      deleteRecipe,
      setChatMessages,
      appendChatMessage,
      setChatProposalStatus,
      newChat,
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
