import type { ChatMessage, ChefToolProposal, IngredientPreference, Recipe, UiQuestion } from '@/domain/types';

export type ToolExecutor = {
  addPantry(names: string[], preference?: IngredientPreference): void;
  updatePantry(name: string, newName: string): boolean;
  removePantry(name: string): boolean;
  setPantryPreference(name: string, preference: IngredientPreference): boolean;
  saveRecipe(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): Recipe;
  validateRecipe?(recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>): void;
  propose?(proposal: ChefToolProposal): void;
  forceProposals?: boolean;
};

export type ChefRunResult = {
  text: string;
  question?: UiQuestion;
};

export type LlmProvider = {
  id: string;
  name: string;
  run(args: {
    apiKey: string;
    model: string;
    systemPrompt: string;
    messages: ChatMessage[];
    tools?: ToolExecutor;
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
    onStatus?: (status: string) => void;
  }): Promise<ChefRunResult>;
};
