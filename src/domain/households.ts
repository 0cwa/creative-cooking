import type { Recipe, ShoppingItem } from './types';

export type HouseholdDiet = 'none' | 'vegetarian' | 'vegan';
export type HouseholdRequirements = { allergies: string[]; diet: HouseholdDiet };
export type HouseholdRecipeCopy = { id: string; sourceRecipeId: string; recipe: Recipe; addedAt: string };
export type HouseholdWorkspace = {
  id: string;
  name: string;
  shoppingList: ShoppingItem[];
  recipes: HouseholdRecipeCopy[];
  requirements: HouseholdRequirements;
  createdAt: string;
  updatedAt: string;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`Invalid ${label}`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${label}`);
  return result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function uniqueIds<T extends { id: string }>(items: T[], label: string): T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Duplicate ${label} ID`);
  return items;
}

export function normalizeHouseholdRequirements(value: unknown): HouseholdRequirements {
  const input = record(value, 'household requirements');
  const diet = input.diet;
  if (diet !== 'none' && diet !== 'vegetarian' && diet !== 'vegan') throw new Error('Invalid household diet');
  return { allergies: array(input.allergies, 'allergies').map((value) => string(value, 'allergy')), diet };
}

function normalizeShoppingItem(value: unknown): ShoppingItem {
  const input = record(value, 'shopping item');
  if (typeof input.checked !== 'boolean') throw new Error('Invalid shopping checked flag');
  const output: ShoppingItem = {
    id: string(input.id, 'shopping ID'), name: string(input.name, 'shopping name'), checked: input.checked,
    createdAt: timestamp(input.createdAt, 'shopping createdAt'), updatedAt: timestamp(input.updatedAt, 'shopping updatedAt')
  };
  if (input.amount !== undefined) output.amount = string(input.amount, 'shopping amount', true);
  if (input.pantryPreference !== undefined) {
    const preference = input.pantryPreference;
    if (preference !== 1 && preference !== 2 && preference !== 3 && preference !== 4 && preference !== 5) {
      throw new Error('Invalid shopping preference');
    }
    output.pantryPreference = preference;
  }
  return output;
}

/** Explicit shared snapshot: private notes and personal shopping flags are never copied. */
export function copyRecipeForHousehold(value: unknown): Recipe {
  const input = record(value, 'recipe');
  if (typeof input.portions !== 'number' || !Number.isFinite(input.portions) || input.portions <= 0) {
    throw new Error('Invalid recipe portions');
  }
  const output: Recipe = {
    id: string(input.id, 'recipe ID'), title: string(input.title, 'recipe title'), portions: input.portions,
    ingredients: array(input.ingredients, 'recipe ingredients').map((value) => {
      const ingredient = record(value, 'ingredient');
      return {
        name: string(ingredient.name, 'ingredient name'),
        ...(ingredient.amount !== undefined ? { amount: string(ingredient.amount, 'ingredient amount', true) } : {})
      };
    }),
    steps: array(input.steps, 'recipe steps').map((value) => string(value, 'recipe step', true)),
    createdAt: timestamp(input.createdAt, 'recipe createdAt'), updatedAt: timestamp(input.updatedAt, 'recipe updatedAt')
  };
  if (input.description !== undefined) output.description = string(input.description, 'recipe description', true);
  return output;
}

function normalizeRecipeCopy(value: unknown): HouseholdRecipeCopy {
  const input = record(value, 'household recipe');
  return {
    id: string(input.id, 'household recipe ID'), sourceRecipeId: string(input.sourceRecipeId, 'source recipe ID'),
    recipe: copyRecipeForHousehold(input.recipe), addedAt: timestamp(input.addedAt, 'recipe addedAt')
  };
}

/** Validate imports and construct a safe allowlist at every shared document level. */
export function normalizeHouseholds(value: unknown): HouseholdWorkspace[] {
  return uniqueIds(array(value, 'households').map((value) => {
    const input = record(value, 'household');
    const recipes = uniqueIds(array(input.recipes, 'household recipes').map(normalizeRecipeCopy), 'household recipe');
    if (new Set(recipes.map((copy) => copy.sourceRecipeId)).size !== recipes.length) {
      throw new Error('Duplicate household source recipe ID');
    }
    return {
      id: string(input.id, 'household ID'), name: string(input.name, 'household name'),
      shoppingList: uniqueIds(array(input.shoppingList, 'household shopping list').map(normalizeShoppingItem), 'shopping'),
      recipes, requirements: normalizeHouseholdRequirements(input.requirements),
      createdAt: timestamp(input.createdAt, 'household createdAt'), updatedAt: timestamp(input.updatedAt, 'household updatedAt')
    };
  }), 'household');
}

export function normalizeHouseholdSelection(households: HouseholdWorkspace[], activeId: unknown): string | null {
  return typeof activeId === 'string' && households.some((household) => household.id === activeId) ? activeId : null;
}

/** Existing personal state stays separate; missing v1 fields select the personal workspace. */
export function normalizeHouseholdState(value: { households?: unknown; activeHouseholdId?: unknown }): {
  households: HouseholdWorkspace[]; activeHouseholdId: string | null;
} {
  const households = value.households === undefined ? [] : normalizeHouseholds(value.households);
  return { households, activeHouseholdId: normalizeHouseholdSelection(households, value.activeHouseholdId) };
}

export function createHousehold(id: string, name: string, now: string): HouseholdWorkspace {
  return normalizeHouseholds([{
    id, name, shoppingList: [], recipes: [], requirements: { allergies: [], diet: 'none' }, createdAt: now, updatedAt: now
  }])[0];
}

export function addHouseholdRecipe(household: HouseholdWorkspace, recipe: Recipe, copyId: string, now: string): HouseholdWorkspace {
  const safeHousehold = normalizeHouseholds([household])[0];
  const snapshot = copyRecipeForHousehold(recipe);
  if (safeHousehold.recipes.some((copy) => copy.sourceRecipeId === snapshot.id)) return safeHousehold;
  return normalizeHouseholds([{
    ...safeHousehold, updatedAt: now,
    recipes: [...safeHousehold.recipes, { id: copyId, sourceRecipeId: snapshot.id, recipe: snapshot, addedAt: now }]
  }])[0];
}

export function removeHouseholdRecipe(household: HouseholdWorkspace, copyId: string, now: string): HouseholdWorkspace {
  const safeHousehold = normalizeHouseholds([household])[0];
  if (!safeHousehold.recipes.some((copy) => copy.id === copyId)) return safeHousehold;
  return normalizeHouseholds([{
    ...safeHousehold, recipes: safeHousehold.recipes.filter((copy) => copy.id !== copyId), updatedAt: now
  }])[0];
}

export function updateHouseholdRequirements(household: HouseholdWorkspace, requirements: HouseholdRequirements, now: string): HouseholdWorkspace {
  return normalizeHouseholds([{ ...household, requirements, updatedAt: now }])[0];
}

/** Compute the selected cooking context locally; never write personal allergies into shared requirements. */
export function effectiveHouseholdAllergies(personal: string[], household: HouseholdWorkspace | null): string[] {
  const seen = new Set<string>();
  return [...personal, ...(household?.requirements.allergies ?? [])]
    .map((allergy) => allergy.trim().replace(/\s+/g, ' '))
    .filter((allergy) => {
      const key = allergy.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
