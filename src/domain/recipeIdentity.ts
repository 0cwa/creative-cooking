import type { Recipe, RecipeIngredient } from './types';

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

/** Deterministically fills legacy row identities without dropping recipe metadata. */
export function normalizeRecipeIdentity(recipe: Recipe): Recipe {
  const usedIngredients = new Set<string>();
  const ingredients: RecipeIngredient[] = recipe.ingredients.map((ingredient, index) => ({
    ...ingredient,
    id: ingredient.id
      ? uniqueId(ingredient.id, usedIngredients)
      : uniqueId(`ing-${hash(`${recipe.id}\0${index}\0${ingredient.name}`)}`, usedIngredients)
  }));
  const usedSteps = new Set<string>();
  const stepIds = recipe.steps.map((step, index) => {
    const existing = recipe.stepIds?.[index];
    return existing
      ? uniqueId(existing, usedSteps)
      : uniqueId(`step-${hash(`${recipe.id}\0${index}\0${step}`)}`, usedSteps);
  });
  return { ...recipe, ingredients, stepIds };
}

export function normalizeRecipes(recipes: Recipe[]): Recipe[] {
  return recipes.map(normalizeRecipeIdentity);
}
