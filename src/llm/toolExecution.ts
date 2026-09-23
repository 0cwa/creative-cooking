import {
  pantryNamesFromToolArgs,
  parseToolArguments,
  preferenceFromToolValue,
  questionFromToolArgs,
  recipeFromToolArgs
} from '../chef/toolPayload.ts';
import { RecipeAllergyError } from '../domain/allergyValidation.ts';
import type { ChefToolProposal, UiQuestion } from '../domain/types';
import type { ToolExecutor } from './types';

export type ChefToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export function executeChefTool(
  call: ChefToolCall,
  tools: ToolExecutor,
  options: { forceApply?: boolean } = {}
): { result: string; question?: UiQuestion; sideEffectApplied?: boolean } {
  const args = parseToolArguments(call.arguments);
  const shouldPropose = toolHasSideEffects(call.name)
    && !options.forceApply
    && (tools.forceProposals === true || args.propose === true);

  if (shouldPropose) {
    if (!tools.propose) {
      return { result: JSON.stringify({ ok: false, error: 'proposal_unavailable' }) };
    }

    if (call.name === 'recipe_save' && tools.validateRecipe) {
      try {
        tools.validateRecipe(recipeFromToolArgs(args));
      } catch (error) {
        if (error instanceof RecipeAllergyError) {
          return {
            result: JSON.stringify({
              ok: false,
              error: 'allergy_validation_failed',
              message: error.message,
              matches: error.matches
            }),
            sideEffectApplied: false
          };
        }
        throw error;
      }
    }

    const proposal: ChefToolProposal = {
      id: call.id,
      toolName: call.name,
      arguments: call.arguments,
      status: 'pending'
    };
    tools.propose(proposal);
    return { result: JSON.stringify({ ok: true, proposed: true }), sideEffectApplied: false };
  }

  switch (call.name) {
    case 'pantry_add': {
      const names = pantryNamesFromToolArgs(args);
      tools.addPantry(names, preferenceFromToolValue(args.preference));
      return { result: JSON.stringify({ ok: true, added: names }), sideEffectApplied: true };
    }
    case 'pantry_update': {
      const name = typeof args.name === 'string' ? args.name : '';
      const newName = typeof args.newName === 'string' ? args.newName : '';
      const updated = tools.updatePantry(name, newName);
      return { result: JSON.stringify({ ok: updated, name, newName }), sideEffectApplied: updated };
    }
    case 'pantry_remove': {
      const name = typeof args.name === 'string' ? args.name : '';
      const removed = tools.removePantry(name);
      return { result: JSON.stringify({ ok: removed, name }), sideEffectApplied: removed };
    }
    case 'pantry_set_preference': {
      const name = typeof args.name === 'string' ? args.name : '';
      const updated = tools.setPantryPreference(name, preferenceFromToolValue(args.preference));
      return { result: JSON.stringify({ ok: updated, name }), sideEffectApplied: updated };
    }
    case 'recipe_save': {
      try {
        const recipe = tools.saveRecipe(recipeFromToolArgs(args));
        return { result: JSON.stringify({ ok: true, recipeId: recipe.id }), sideEffectApplied: true };
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

export function applyChefProposal(
  proposal: ChefToolProposal,
  tools: ToolExecutor
): { result: string; question?: UiQuestion; sideEffectApplied?: boolean } {
  const args = parseToolArguments(proposal.arguments);
  return executeChefTool({
    id: proposal.id,
    name: proposal.toolName,
    arguments: JSON.stringify({ ...args, propose: false })
  }, tools, { forceApply: true });
}

export function toolHasSideEffects(name: string): boolean {
  return name === 'pantry_add'
    || name === 'pantry_update'
    || name === 'pantry_remove'
    || name === 'pantry_set_preference'
    || name === 'recipe_save';
}
