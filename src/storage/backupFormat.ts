import type { AppSettings, ChatMessage, MealContext, PantryItem, PersistedState, Recipe } from '../domain/types';

type BackupEnvelope = {
  format: 'creative-cooking-backup';
  version: 1;
  exportedAt: string;
  state: PersistedState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const PROVIDER_IDS = ['openrouter', 'openai', 'anthropic', 'gemini', 'mistral', 'webllm'] as const;

function isProviderId(value: unknown): value is AppSettings['providerId'] {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function serializeBackupEnvelope(state: PersistedState, exportedAt: string): string {
  const envelope: BackupEnvelope = {
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt,
    state
  };
  return JSON.stringify(envelope, null, 2);
}

export function parseBackupEnvelope(raw: string, defaults: PersistedState): PersistedState {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.format !== 'creative-cooking-backup' || parsed.version !== 1 || !isRecord(parsed.state)) {
    throw new Error('This is not a supported Creative Cooking backup.');
  }

  const state = parsed.state;
  const pantry = Array.isArray(state.pantry) ? (state.pantry as PantryItem[]) : [];
  const recipes = Array.isArray(state.recipes) ? (state.recipes as Recipe[]) : [];
  const chatMessages = Array.isArray(state.chatMessages) ? (state.chatMessages as ChatMessage[]) : [];

  const mealContextRecord = isRecord(state.mealContext) ? state.mealContext : {};
  const mealContext = {
    ...defaults.mealContext,
    ...mealContextRecord,
    cooks: Array.isArray(mealContextRecord.cooks)
      ? (mealContextRecord.cooks as MealContext['cooks'])
      : [...defaults.mealContext.cooks]
  } as MealContext;

  const settingsRecord = isRecord(state.settings) ? state.settings : {};
  const providerId = isProviderId(settingsRecord.providerId)
    ? settingsRecord.providerId
    : defaults.settings.providerId;
  const providerWasInvalid = settingsRecord.providerId !== undefined && !isProviderId(settingsRecord.providerId);
  const model = providerWasInvalid
    ? defaults.settings.model
    : typeof settingsRecord.model === 'string'
      ? settingsRecord.model
      : defaults.settings.model;
  const settings = {
    ...defaults.settings,
    ...settingsRecord,
    providerId,
    model,
    allergies: Array.isArray(settingsRecord.allergies)
      ? (settingsRecord.allergies as AppSettings['allergies'])
      : [...defaults.settings.allergies]
  } as AppSettings;

  return { pantry, recipes, chatMessages, mealContext, settings };
}

export function freshStateFromDefaults(defaults: PersistedState): PersistedState {
  return {
    pantry: [],
    recipes: [],
    chatMessages: [],
    mealContext: { ...defaults.mealContext, cooks: [...defaults.mealContext.cooks] },
    settings: { ...defaults.settings, allergies: [...defaults.settings.allergies] }
  };
}
