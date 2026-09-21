import {
  pantryNamesFromToolArgs,
  parseToolArguments,
  preferenceFromToolValue,
  questionFromToolArgs,
  recipeFromToolArgs
} from '@/chef/toolPayload';
import { RecipeAllergyError } from '@/domain/allergyValidation';
import type { UiQuestion } from '@/domain/types';
import type { ToolExecutor } from '@/llm/types';

export type ChefToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export function executeChefTool(
  call: ChefToolCall,
  tools: ToolExecutor
): { result: string; question?: UiQuestion } {
  const args = parseToolArguments(call.arguments);

  switch (call.name) {
    case 'pantry_add': {
      const names = pantryNamesFromToolArgs(args);
      tools.addPantry(names, preferenceFromToolValue(args.preference));
      return { result: JSON.stringify({ ok: true, added: names }) };
    }
    case 'pantry_remove': {
      const name = typeof args.name === 'string' ? args.name : '';
      const removed = tools.removePantry(name);
      return { result: JSON.stringify({ ok: removed, name }) };
    }
    case 'pantry_set_preference': {
      const name = typeof args.name === 'string' ? args.name : '';
      const updated = tools.setPantryPreference(name, preferenceFromToolValue(args.preference));
      return { result: JSON.stringify({ ok: updated, name }) };
    }
    case 'recipe_save': {
      try {
        const recipe = tools.saveRecipe(recipeFromToolArgs(args));
        return { result: JSON.stringify({ ok: true, recipeId: recipe.id }) };
      } catch (error) {
        if (error instanceof RecipeAllergyError) {
          return {
            result: JSON.stringify({
              ok: false,
              error: 'allergy_validation_failed',
              message: error.message,
              matches: error.matches
            })
          };
        }
        throw error;
      }
    }
    case 'ask_user':
      return {
        result: JSON.stringify({ awaiting_user: true }),
        question: questionFromToolArgs(args, call.id)
      };
    default:
      return { result: JSON.stringify({ ok: false, error: 'Unknown tool' }) };
  }
}

export function toolHasSideEffects(name: string): boolean {
  return name === 'pantry_add'
    || name === 'pantry_remove'
    || name === 'pantry_set_preference'
    || name === 'recipe_save';
}
