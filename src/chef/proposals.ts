import {
  pantryNamesFromToolArgs,
  parseToolArguments,
  preferenceFromToolValue,
  recipeFromToolArgs
} from './toolPayload.ts';
import type { ChefToolProposal, Recipe } from '../domain/types';

type RecipeDraft = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;

export type ProposalPresentation = {
  kind: 'recipe' | 'pantry' | 'unknown';
  eyebrow: string;
  title: string;
  summary: string;
  actionLabel: string;
  actionTone: 'positive' | 'neutral' | 'destructive';
  recipe?: RecipeDraft;
};

function summarizeNames(names: string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

function fallback(toolName: string): ProposalPresentation {
  return {
    kind: 'unknown',
    eyebrow: 'SUGGESTED CHANGE',
    title: 'Review this change',
    summary: toolName.replaceAll('_', ' '),
    actionLabel: 'Apply',
    actionTone: 'neutral'
  };
}

export function proposalFingerprint(proposal: ChefToolProposal): string {
  try {
    const args = parseToolArguments(proposal.arguments);
    const { propose: _propose, ...rest } = args;
    return JSON.stringify([proposal.toolName, rest]);
  } catch {
    return JSON.stringify([proposal.toolName, proposal.arguments]);
  }
}

export function proposalPresentation(proposal: ChefToolProposal): ProposalPresentation {
  try {
    const args = parseToolArguments(proposal.arguments);

    switch (proposal.toolName) {
      case 'pantry_add': {
        const names = pantryNamesFromToolArgs(args);
        return {
          kind: 'pantry',
          eyebrow: 'PANTRY',
          title: names.length === 1 ? 'Add to Pantry' : `Add ${names.length} items to Pantry`,
          summary: summarizeNames(names),
          actionLabel: names.length === 1 ? 'Add' : 'Add all',
          actionTone: 'positive'
        };
      }
      case 'pantry_update': {
        const name = typeof args.name === 'string' ? args.name : '';
        const newName = typeof args.newName === 'string' ? args.newName : '';
        return {
          kind: 'pantry',
          eyebrow: 'PANTRY',
          title: 'Update Pantry item',
          summary: [name, newName].filter(Boolean).join(' → '),
          actionLabel: 'Update',
          actionTone: 'neutral'
        };
      }
      case 'pantry_remove': {
        const name = typeof args.name === 'string' ? args.name : '';
        return {
          kind: 'pantry',
          eyebrow: 'PANTRY',
          title: 'Remove from Pantry',
          summary: name,
          actionLabel: 'Remove',
          actionTone: 'destructive'
        };
      }
      case 'pantry_set_preference': {
        const name = typeof args.name === 'string' ? args.name : '';
        const preference = preferenceFromToolValue(args.preference);
        return {
          kind: 'pantry',
          eyebrow: 'PANTRY',
          title: 'Change preference',
          summary: `${name} · ${preference}★`,
          actionLabel: 'Change',
          actionTone: 'neutral'
        };
      }
      case 'recipe_save': {
        const recipe = recipeFromToolArgs(args);
        return {
          kind: 'recipe',
          eyebrow: 'RECIPE IDEA',
          title: recipe.title,
          summary: `${recipe.portions} portion${recipe.portions === 1 ? '' : 's'} · ${recipe.ingredients.length} ingredient${recipe.ingredients.length === 1 ? '' : 's'}`,
          actionLabel: 'Add recipe',
          actionTone: 'positive',
          recipe
        };
      }
      default:
        return fallback(proposal.toolName);
    }
  } catch {
    return fallback(proposal.toolName);
  }
}
