import type { ChefToolProposal, PersistedState, Recipe } from '../domain/types';
import { RecipeAllergyError, validateRecipeAllergies } from '../domain/allergyValidation.ts';
import { normalizeIngredientName } from '../domain/pantry.ts';
import { normalizeRecipes } from '../domain/recipeIdentity.ts';
import { parseToolArguments } from './toolPayload.ts';
import { applyChefProposal } from '../llm/toolExecution.ts';

function hash(value: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed, seedIndex) => {
    let result = seed;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index) + seedIndex;
      result = Math.imul(result, 0x01000193);
    }
    return (result >>> 0).toString(16).padStart(8, '0');
  }).join('');
}

function stableAt(state: PersistedState, conversationId: string, proposalId: string): string {
  const conversation = state.chatHistory.find((item) => item.id === conversationId)
    ?? (state.activeConversationId === conversationId
      ? { messages: state.chatMessages }
      : null);
  const message = conversation?.messages.find((item) => item.proposals?.some((proposal) => proposal.id === proposalId));
  return message?.createdAt ?? new Date(0).toISOString();
}

export type PlannedProposalEffect = {
  state: PersistedState;
  result: string;
};

/** Compute Chef's existing domain effects without mutating React state. */
export function planChefProposalEffect(
  state: PersistedState,
  scopeId: string,
  conversationId: string,
  proposal: ChefToolProposal
): PlannedProposalEffect {
  let next = state;
  const at = stableAt(state, conversationId, proposal.id);
  const identity = (kind: string, index: number, value: string) => `chef-${hash(`${scopeId}\0${conversationId}\0${proposal.id}\0${kind}\0${index}\0${value}`)}`;
  const outcome = applyChefProposal(proposal, {
    addPantry: (names, selectedPreference = 3) => {
      const existing = new Set(next.pantry.map((item) => item.name.toLocaleLowerCase()));
      const additions = names.map(normalizeIngredientName)
        .filter(Boolean)
        .filter((name) => !existing.has(name.toLocaleLowerCase()))
        .map((name, index) => ({
          id: identity('pantry', index, name.toLocaleLowerCase()),
          name,
          preference: selectedPreference,
          createdAt: at,
          updatedAt: at
        }));
      if (additions.length) next = { ...next, pantry: [...additions, ...next.pantry] };
    },
    updatePantry: (name, newName) => {
      const target = normalizeIngredientName(name).toLocaleLowerCase();
      const replacement = normalizeIngredientName(newName);
      if (!target || !replacement) return false;
      const index = next.pantry.findIndex((item) => item.name.toLocaleLowerCase() === target);
      if (index < 0 || next.pantry.some((item, itemIndex) => itemIndex !== index && item.name.toLocaleLowerCase() === replacement.toLocaleLowerCase())) return false;
      next = { ...next, pantry: next.pantry.map((item, itemIndex) => itemIndex === index ? { ...item, name: replacement, updatedAt: at } : item) };
      return true;
    },
    removePantry: (name) => {
      const target = normalizeIngredientName(name).toLocaleLowerCase();
      if (!target) return false;
      const pantry = next.pantry.filter((item) => item.name.toLocaleLowerCase() !== target);
      if (pantry.length === next.pantry.length) return false;
      next = { ...next, pantry };
      return true;
    },
    setPantryPreference: (name, selectedPreference) => {
      const target = normalizeIngredientName(name).toLocaleLowerCase();
      const index = next.pantry.findIndex((item) => item.name.toLocaleLowerCase() === target);
      if (!target || index < 0) return false;
      next = { ...next, pantry: next.pantry.map((item, itemIndex) => itemIndex === index ? { ...item, preference: selectedPreference, updatedAt: at } : item) };
      return true;
    },
    validateRecipe: (recipe) => {
      const validation = validateRecipeAllergies(recipe.ingredients, next.settings.allergies);
      if (!validation.ok) throw new RecipeAllergyError(validation.matches);
    },
    saveRecipe: (recipe) => {
      const validation = validateRecipeAllergies(recipe.ingredients, next.settings.allergies);
      if (!validation.ok) throw new RecipeAllergyError(validation.matches);
      const args = parseToolArguments(proposal.arguments);
      const input = recipe as Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;
      const created: Recipe = normalizeRecipes([{
        ...input,
        id: identity('recipe', 0, typeof args.title === 'string' ? args.title : ''),
        createdAt: at,
        updatedAt: at
      }])[0];
      next = { ...next, recipes: [created, ...next.recipes] };
      return created;
    }
  });
  let result: { ok?: boolean; message?: string; error?: string };
  try {
    result = JSON.parse(outcome.result) as typeof result;
  } catch {
    throw new Error('Chef returned an unreadable change result.');
  }
  if (result.ok !== true || outcome.sideEffectApplied !== true) {
    throw new Error(result.message || result.error || 'That suggested change could not be applied.');
  }
  return { state: next, result: outcome.result };
}
