export type IngredientPreference = 1 | 2 | 3 | 4 | 5;

export const PROVIDER_IDS = ['openrouter', 'openai', 'anthropic', 'gemini', 'mistral', 'webllm'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const DICTATION_ENGINES = ['browser', 'whisper'] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];

export function isDictationEngine(value: unknown): value is DictationEngine {
  return typeof value === 'string' && (DICTATION_ENGINES as readonly string[]).includes(value);
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export type PantryItem = {
  id: string;
  name: string;
  preference: IngredientPreference;
  createdAt: string;
  updatedAt: string;
};

export type RecipeIngredient = {
  name: string;
  amount?: string;
  needsShopping?: boolean;
};

export type Recipe = {
  id: string;
  title: string;
  description?: string;
  portions: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  notes?: string[];
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type CookEnergy = 'low' | 'medium' | 'high';

export type MealContext = {
  willingToShop: boolean;
  portions: number;
  cooks: CookEnergy[];
};

export type AppSettings = {
  systemPrompt: string;
  allergies: string[];
  sendLocalTime: boolean;
  city: string;
  providerId: ProviderId;
  model: string;
  dictationEngine: DictationEngine;
};

export type PersistedState = {
  pantry: PantryItem[];
  recipes: Recipe[];
  chatMessages: ChatMessage[];
  mealContext: MealContext;
  settings: AppSettings;
};

export type UiQuestion = {
  id: string;
  prompt: string;
  options: string[];
};
