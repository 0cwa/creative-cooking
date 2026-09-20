import { groupPantryForChef } from '@/domain/pantry';
import type { PersistedState } from '@/domain/types';

export function buildChefSystemPrompt(state: PersistedState): string {
  const allergies = state.settings.allergies.length
    ? state.settings.allergies.map((item) => `- ${item}`).join('\n')
    : '- (none listed)';

  const timeBlock = state.settings.sendLocalTime
    ? `Local time: ${new Date().toLocaleString()}\nTime zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'}`
    : 'Local time: not shared';

  const cityBlock = state.settings.city.trim() ? `City: ${state.settings.city.trim()}` : 'City: not shared';
  const cookEnergy = state.mealContext.cooks.map((energy, index) => `Cook ${index + 1}: ${energy}`).join(', ');

  return `${state.settings.systemPrompt}\n\nAPPLICATION CONSTRAINTS\nAllergies (hard constraint — never include these):\n${allergies}\n\nPANTRY PREFERENCES\n${groupPantryForChef(state.pantry)}\n\nMEAL CONTEXT\nWilling to shop: ${state.mealContext.willingToShop ? 'yes' : 'no'}\nPortions: ${state.mealContext.portions}\nCooks: ${state.mealContext.cooks.length}\nEnergy: ${cookEnergy}\n${timeBlock}\n${cityBlock}\n\nPantry entries may contain names only. Do not ask the user to inventory quantities unless a specific recipe absolutely requires that clarification.`;
}
