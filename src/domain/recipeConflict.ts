import type { PersistedState, Recipe, RecipeIngredient } from './types';
import { normalizeRecipes } from './recipeIdentity.ts';

export type RecipeConflictAttempt = {
  id: string;
  attempted_json: string;
  recipe_id?: string;
  current_json?: string;
  created_at: string;
};

export type RecipeConflictSnapshot = {
  recipe: Recipe | null;
  version: number | null;
  updatedAt: string | null;
  deletedAt: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function recipeConflictCopyId(conflictId: string): string {
  if (!conflictId || conflictId.length > 180) throw new Error('This recipe conflict has an invalid recovery identity.');
  return `recovered-${conflictId}`;
}

/** Convert the server's immutable recipe.save payload into an idempotent local recipe copy. */
export function recipeCopyFromConflict(conflict: RecipeConflictAttempt): Recipe | null {
  let value: Record<string, unknown> | null;
  try {
    value = record(JSON.parse(conflict.attempted_json));
  } catch {
    return null;
  }
  if (!value || value.action === 'delete' || typeof value.title !== 'string'
    || !Array.isArray(value.ingredients) || !value.ingredients.length || !Array.isArray(value.steps) || !value.steps.length
    || typeof value.portions !== 'number' || !Number.isInteger(value.portions) || value.portions < 1) return null;

  const ingredients: RecipeIngredient[] = [];
  for (const rawIngredient of value.ingredients) {
    const ingredient = record(rawIngredient);
    if (!ingredient || typeof ingredient.name !== 'string') return null;
    const metadata = record(ingredient.metadata) ?? {};
    ingredients.push({
      ...metadata,
      ...(typeof ingredient.id === 'string' && ingredient.id ? { id: ingredient.id } : {}),
      name: ingredient.name,
      ...(typeof ingredient.amount === 'string' ? { amount: ingredient.amount } : {}),
      needsShopping: ingredient.needsShopping === true
    });
  }

  const steps: string[] = [];
  const stepIds: string[] = [];
  for (const rawStep of value.steps) {
    if (typeof rawStep === 'string') {
      steps.push(rawStep);
      stepIds.push('');
      continue;
    }
    const step = record(rawStep);
    if (!step || typeof step.text !== 'string') return null;
    steps.push(step.text);
    stepIds.push(typeof step.id === 'string' ? step.id : '');
  }

  const createdAt = Number.isNaN(Date.parse(conflict.created_at))
    ? '1970-01-01T00:00:00.000Z'
    : new Date(conflict.created_at).toISOString();
  const notes = Array.isArray(value.notes) && value.notes.every((note) => typeof note === 'string')
    ? value.notes as string[]
    : undefined;

  return normalizeRecipes([{
    id: recipeConflictCopyId(conflict.id),
    title: value.title,
    ...(typeof value.description === 'string' && value.description ? { description: value.description } : {}),
    portions: value.portions,
    ingredients,
    steps,
    stepIds,
    ...(notes?.length ? { notes } : {}),
    createdAt,
    updatedAt: createdAt
  }])[0];
}

/** Parse the exact server snapshot returned with a recipe version conflict. */
export function recipeSnapshotFromConflict(conflict: RecipeConflictAttempt): RecipeConflictSnapshot | null {
  if (typeof conflict.recipe_id !== 'string' || typeof conflict.current_json !== 'string') return null;

  let value: Record<string, unknown> | null;
  try {
    const parsed: unknown = JSON.parse(conflict.current_json);
    value = parsed === null ? null : record(parsed);
    if (parsed !== null && !value) return null;
  } catch {
    return null;
  }
  if (!value) return { recipe: null, version: null, updatedAt: null, deletedAt: null };

  const version = typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 0
    ? value.version
    : null;
  const updatedAt = typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt))
    ? new Date(value.updatedAt).toISOString()
    : null;
  const deletedAt = value.deletedAt === null || value.deletedAt === undefined
    ? null
    : typeof value.deletedAt === 'string' && !Number.isNaN(Date.parse(value.deletedAt))
      ? new Date(value.deletedAt).toISOString()
      : null;

  if (value.id !== conflict.recipe_id || version === null || updatedAt === null
    || typeof value.title !== 'string' || !Array.isArray(value.ingredients) || !value.ingredients.length
    || !Array.isArray(value.steps) || !value.steps.length
    || typeof value.portions !== 'number' || !Number.isInteger(value.portions) || value.portions < 1
    || (value.deletedAt !== null && value.deletedAt !== undefined && deletedAt === null)) return null;

  const ingredients: RecipeIngredient[] = [];
  for (const rawIngredient of value.ingredients) {
    const ingredient = record(rawIngredient);
    if (!ingredient || typeof ingredient.name !== 'string' || typeof ingredient.id !== 'string') return null;
    const metadata = record(ingredient.metadata) ?? {};
    ingredients.push({
      ...metadata,
      id: ingredient.id,
      name: ingredient.name,
      ...(typeof ingredient.amount === 'string' ? { amount: ingredient.amount } : {}),
      needsShopping: ingredient.needsShopping === true
    });
  }

  const steps: string[] = [];
  const stepIds: string[] = [];
  for (const rawStep of value.steps) {
    const step = record(rawStep);
    if (!step || typeof step.text !== 'string' || typeof step.id !== 'string') return null;
    steps.push(step.text);
    stepIds.push(step.id);
  }

  const recipe = normalizeRecipes([{
    id: conflict.recipe_id,
    title: value.title,
    ...(typeof value.description === 'string' && value.description ? { description: value.description } : {}),
    portions: value.portions,
    ingredients,
    steps,
    stepIds,
    notes: Array.isArray(value.notes) && value.notes.every((note) => typeof note === 'string')
      ? value.notes as string[]
      : [],
    createdAt: typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt))
      ? new Date(value.createdAt).toISOString()
      : updatedAt,
    updatedAt
  }])[0];

  return {
    recipe: deletedAt ? null : recipe,
    version,
    updatedAt,
    deletedAt
  };
}

/** Apply the captured workspace side of a conflict without changing other state. */
export function keepWorkspaceRecipeVersion(
  state: PersistedState,
  conflict: RecipeConflictAttempt
): { state: PersistedState; snapshot: RecipeConflictSnapshot } | null {
  if (typeof conflict.recipe_id !== 'string') return null;
  const snapshot = recipeSnapshotFromConflict(conflict);
  if (!snapshot) return null;

  const recipes = state.recipes.filter((recipe) => recipe.id !== conflict.recipe_id);
  if (snapshot.recipe) {
    recipes.push(snapshot.recipe);
    recipes.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }
  return { state: { ...state, recipes }, snapshot };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = record(value);
  if (!object) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

export function sameRecipeConflictCopy(left: Recipe, right: Recipe): boolean {
  return stable({
    id: left.id,
    title: left.title,
    description: left.description,
    portions: left.portions,
    ingredients: left.ingredients,
    steps: left.steps,
    stepIds: left.stepIds,
    notes: left.notes,
    createdAt: left.createdAt,
    updatedAt: left.updatedAt
  }) === stable({
    id: right.id,
    title: right.title,
    description: right.description,
    portions: right.portions,
    ingredients: right.ingredients,
    steps: right.steps,
    stepIds: right.stepIds,
    notes: right.notes,
    createdAt: right.createdAt,
    updatedAt: right.updatedAt
  });
}
