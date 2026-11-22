import type {ChefToolProposal, PersistedState, Recipe} from '@/domain/types';

export type LocalPersistenceStatus = 'saving' | 'saved' | 'error';


export type RecipeHistoryEntry = {
  effectId: string;
  context: string;
  head: string;
  kind: 'recipe-field' | 'recipe-ingredient-field' | 'recipe-step-field';
  id?: string;
  field: string;
  value: string | string[];
  at: string;
  status: 'current' | 'earlier' | 'competing';
};

export type ContentRuntimeSnapshot = {
  /** True only after cooking and personal content have both opened successfully. */
  hydrated: boolean;
  storageError: string | null;
  workspaceName: string;
  scopeId: string;
  localPersistenceStatus: LocalPersistenceStatus;
  canEditShared: boolean;
  sharedEditDeniedMessage: string;
  markLocalStateChange(): number;
  separateRecipeIds?: string[];
  recoverShoppingCopy?(attempt: {actionId: string; commands: unknown[] | null}): Promise<boolean>;
  saveShoppingCopy?(attempt: {actionId: string; at: string; commands: unknown[] | null}, before: PersistedState, after: PersistedState['shopping']): Promise<void>;
  createRecipe?(actionId: string, recipe: Recipe, beforeNewCommit: () => void): Promise<void>;
  readRecipeHistory?(recipeId: string): Promise<RecipeHistoryEntry[]>;
  restoreRecipeEdit?(recipeId: string, entry: RecipeHistoryEntry): Promise<void>;
  applyProposalEffect(conversationId: string, proposal: ChefToolProposal, before: PersistedState, after: PersistedState): Promise<'applied' | 'queued'>;
  flushCurrentWorkspace(target?: PersistedState): Promise<void>;
  refreshSharedCooking?(): Promise<PersistedState>;
  retryStorage(): Promise<boolean>;
  reportEditDenied(): void;
};
