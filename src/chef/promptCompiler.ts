import type { PersistedState } from '../domain/types';

export type ChefPromptEnvironment = {
  localTime: string;
  timeZone: string;
};

export function compileChefSystemPrompt(
  state: PersistedState,
  pantryBlock: string,
  environment: ChefPromptEnvironment
): string {
  const allergies = state.settings.allergies.length
    ? state.settings.allergies.map((item) => `- ${item}`).join('\n')
    : '- (none listed)';

  const timeBlock = state.settings.sendLocalTime
    ? `Local time: ${environment.localTime}\nTime zone: ${environment.timeZone || 'unknown'}`
    : 'Local time: not shared';

  const cityBlock = state.settings.city.trim() ? `City: ${state.settings.city.trim()}` : 'City: not shared';
  const cookEnergy = state.mealContext.cooks.map((energy, index) => `Cook ${index + 1}: ${energy}`).join(', ');

  return `${state.settings.systemPrompt}

APPLICATION CONSTRAINTS
Allergies (hard constraint — never include these):
${allergies}

PANTRY PREFERENCES
${pantryBlock}

MEAL CONTEXT
Willing to shop: ${state.mealContext.willingToShop ? 'yes' : 'no'}
Portions: ${state.mealContext.portions}
Cooks: ${state.mealContext.cooks.length}
Energy: ${cookEnergy}
${timeBlock}
${cityBlock}

Pantry entries may contain names only. Do not ask the user to inventory quantities unless a specific recipe absolutely requires that clarification.`;
}
