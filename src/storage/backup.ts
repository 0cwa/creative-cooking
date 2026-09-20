import { DEFAULT_STATE } from '@/domain/defaults';
import type { AppSettings, ChatMessage, MealContext, PantryItem, PersistedState, Recipe } from '@/domain/types';

type BackupEnvelope = {
  format: 'creative-cooking-backup';
  version: 1;
  exportedAt: string;
  state: PersistedState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function serializeBackup(state: PersistedState): string {
  const envelope: BackupEnvelope = {
    format: 'creative-cooking-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    state
  };
  return JSON.stringify(envelope, null, 2);
}

export function parseBackup(raw: string): PersistedState {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.format !== 'creative-cooking-backup' || parsed.version !== 1 || !isRecord(parsed.state)) {
    throw new Error('This is not a supported Creative Cooking backup.');
  }

  const state = parsed.state;
  const pantry = Array.isArray(state.pantry) ? (state.pantry as PantryItem[]) : [];
  const recipes = Array.isArray(state.recipes) ? (state.recipes as Recipe[]) : [];
  const chatMessages = Array.isArray(state.chatMessages) ? (state.chatMessages as ChatMessage[]) : [];
  const mealContext = isRecord(state.mealContext)
    ? ({ ...DEFAULT_STATE.mealContext, ...state.mealContext } as MealContext)
    : DEFAULT_STATE.mealContext;
  const settings = isRecord(state.settings)
    ? ({ ...DEFAULT_STATE.settings, ...state.settings } as AppSettings)
    : DEFAULT_STATE.settings;

  return {
    pantry,
    recipes,
    chatMessages,
    mealContext,
    settings
  };
}

export function freshDefaultState(): PersistedState {
  return {
    pantry: [],
    recipes: [],
    chatMessages: [],
    mealContext: { ...DEFAULT_STATE.mealContext, cooks: [...DEFAULT_STATE.mealContext.cooks] },
    settings: { ...DEFAULT_STATE.settings, allergies: [...DEFAULT_STATE.settings.allergies] }
  };
}
