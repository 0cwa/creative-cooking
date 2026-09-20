import type { IngredientPreference, Recipe, UiQuestion } from '../domain/types';

export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function preferenceFromToolValue(value: unknown): IngredientPreference {
  const numeric = Number(value);
  if (numeric >= 1 && numeric <= 5) return numeric as IngredientPreference;
  return 3;
}

export function pantryNamesFromToolArgs(args: Record<string, unknown>): string[] {
  return Array.isArray(args.names)
    ? args.names.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
}

export function recipeFromToolArgs(
  args: Record<string, unknown>
): Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'> {
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Untitled recipe';
  const portions = Math.max(1, Number(args.portions) || 2);
  const ingredients = Array.isArray(args.ingredients)
    ? args.ingredients
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({
          name: typeof item.name === 'string' ? item.name.trim() : '',
          amount: typeof item.amount === 'string' ? item.amount : undefined,
          needsShopping: typeof item.needsShopping === 'boolean' ? item.needsShopping : undefined
        }))
        .filter((item) => item.name)
    : [];
  const steps = Array.isArray(args.steps)
    ? args.steps.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  const notes = Array.isArray(args.notes)
    ? args.notes.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : undefined;

  return {
    title,
    description: typeof args.description === 'string' ? args.description : undefined,
    portions,
    ingredients,
    steps,
    notes
  };
}

export function questionFromToolArgs(args: Record<string, unknown>, id: string): UiQuestion {
  const prompt = typeof args.prompt === 'string' && args.prompt.trim()
    ? args.prompt.trim()
    : 'Which option do you prefer?';
  const options = Array.isArray(args.options)
    ? args.options.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).slice(0, 5)
    : [];

  return {
    id,
    prompt,
    options: options.length >= 2 ? options : ['First option', 'Second option']
  };
}
