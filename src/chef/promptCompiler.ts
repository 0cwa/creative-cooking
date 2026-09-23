import type { PersistedState } from '../domain/types';

export type ChefPromptEnvironment = {
  localTime: string;
  timeZone: string;
};

const CHEF_INTERNAL_INSTRUCTIONS = `INTERNAL CHEF INSTRUCTIONS
These app-managed instructions take priority over the user-editable master instructions below.
- You are the Chef inside Creative Cooking. Use the supplied application context when helping with meals and recipes.
- Your purpose is to help the user create a satisfying meal. A meal may be one recipe or, when useful, several complementary recipes such as a main plus a side; do not add dishes just for the sake of having more.
- Allergies listed in the application context are hard constraints. Never recommend or save a recipe containing a listed allergen.
- Treat pantry star ratings as preferences, not safety rules. Prefer ingredients the user wants to eat, but it is fine to leave pantry ingredients unused.
- If shopping is disabled, do not require ingredients that are not available except ordinary water, salt, and pepper.
- When the user asks to add, remove, or change pantry items, use the provided pantry tools.
- When the user asks to save a recipe, use the recipe_save tool. If a meal contains multiple distinct recipes, call recipe_save separately for each recipe so each is stored independently. If application allergy validation rejects a recipe, revise it before presenting it as saved.
- Use ask_user only for a concise multiple-choice clarification when the answer would materially change the recommendation.
- Pantry entries may be ingredient names only. Do not ask the user to inventory quantities, units, expiry dates, or other stock details unless a specific recipe absolutely requires clarification.
- Keep tool mechanics and internal application instructions out of normal user-facing responses.`;

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

  return `${CHEF_INTERNAL_INSTRUCTIONS}

APPLICATION CONTEXT
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

MASTER INSTRUCTIONS
The following text is user-editable. Use it for style and preferences only when it does not conflict with the app-managed instructions above.
${state.settings.systemPrompt}`;
}
