import { groupPantryForChef } from '@/domain/pantry';
import type { PersistedState } from '@/domain/types';
import { compileChefSystemPrompt } from './promptCompiler';

export function buildChefSystemPrompt(state: PersistedState): string {
  return compileChefSystemPrompt(state, groupPantryForChef(state.pantry), {
    localTime: new Date().toLocaleString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
  });
}
