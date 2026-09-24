import type { RecipeIngredient } from './types';

function normalizeIngredientName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function stripListMarker(value: string): string {
  return value.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '').trim();
}

function normalizeIngredientLine(value: string): string {
  return stripListMarker(value).replace(/\s+/g, ' ');
}

const FRACTIONS: Array<[number, string]> = [
  [1 / 8, '1/8'],
  [1 / 6, '1/6'],
  [1 / 4, '1/4'],
  [1 / 3, '1/3'],
  [3 / 8, '3/8'],
  [1 / 2, '1/2'],
  [5 / 8, '5/8'],
  [2 / 3, '2/3'],
  [3 / 4, '3/4'],
  [5 / 6, '5/6'],
  [7 / 8, '7/8']
];

const INGREDIENT_UNIT_PATTERN = [
  'cups?', 'c',
  'tablespoons?', 'tbsp?s?',
  'teaspoons?', 'tsps?',
  'grams?', 'g',
  'kilograms?', 'kgs?',
  'millilit(?:er|re)s?', 'ml',
  'lit(?:er|re)s?', 'l',
  'ounces?', 'oz',
  'pounds?', 'lbs?',
  'cloves?',
  'cans?', 'tins?',
  'packages?', 'packs?',
  'bunch(?:es)?',
  'heads?',
  'pieces?',
  'slices?',
  'sticks?',
  'sprigs?',
  'handfuls?',
  'pinches?'
].join('|');

const QUANTITY_PATTERN = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';
const NATURAL_INGREDIENT_PATTERN = new RegExp(
  `^((?:${QUANTITY_PATTERN})(?:\\s*(?:[-–—]|to)\\s*(?:${QUANTITY_PATTERN}))?(?:\\s+(?:${INGREDIENT_UNIT_PATTERN}))?)\\s+(.+)$`,
  'i'
);

function parseQuantity(value: string): number | null {
  const mixed = value.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const numerator = Number(mixed[2]);
    const denominator = Number(mixed[3]);
    if (!denominator || numerator >= denominator) return null;
    return whole + numerator / denominator;
  }

  const fraction = value.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (!denominator) return null;
    return numerator / denominator;
  }

  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatQuantity(value: number): string {
  const roundedInteger = Math.round(value);
  if (Math.abs(value - roundedInteger) < 0.0001) return String(roundedInteger);

  const whole = Math.floor(value);
  const remainder = value - whole;
  let best: [number, string] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of FRACTIONS) {
    const distance = Math.abs(remainder - candidate[0]);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  if (best && bestDistance <= 0.015) {
    return whole > 0 ? `${whole} ${best[1]}` : best[1];
  }

  return String(Math.round(value * 100) / 100);
}

export function formatRecipeIngredientLine(ingredient: RecipeIngredient): string {
  const name = ingredient.name.trim();
  const amount = ingredient.amount?.trim();
  if (!amount) return name;
  if (/^(?:to taste|as needed)$/i.test(amount)) return [name, amount].filter(Boolean).join(' ');
  return [amount, name].filter(Boolean).join(' ');
}

export function formatRecipeIngredientsText(ingredients: RecipeIngredient[]): string {
  return ingredients.map(formatRecipeIngredientLine).join('\n');
}

export function parseRecipeIngredientLine(value: string): RecipeIngredient | null {
  const line = stripListMarker(value);
  if (!line) return null;

  const trailingAmount = line.match(/^(.+?)\s+(to taste|as needed)$/i);
  if (trailingAmount) {
    return { name: trailingAmount[1].trim(), amount: trailingAmount[2].toLocaleLowerCase() };
  }

  const match = line.match(NATURAL_INGREDIENT_PATTERN);
  if (!match) return { name: line };

  const amount = match[1].trim();
  const name = match[2].trim().replace(/^of\s+/i, '');
  if (!name) return { name: line };

  return { name, amount };
}

export function parseRecipeIngredientsText(
  value: string,
  previousIngredients: RecipeIngredient[] = []
): RecipeIngredient[] {
  const lines = value
    .split(/\r?\n/)
    .map(stripListMarker)
    .filter(Boolean);

  const usedPrevious = new Set<number>();

  return lines.flatMap((line, index) => {
    const normalized = normalizeIngredientLine(line);
    const sameIndex = previousIngredients[index];

    if (
      sameIndex
      && normalizeIngredientLine(formatRecipeIngredientLine(sameIndex)) === normalized
      && !usedPrevious.has(index)
    ) {
      usedPrevious.add(index);
      return [{ ...sameIndex }];
    }

    const exactIndex = previousIngredients.findIndex((ingredient, previousIndex) => (
      !usedPrevious.has(previousIndex)
      && normalizeIngredientLine(formatRecipeIngredientLine(ingredient)) === normalized
    ));

    if (exactIndex >= 0) {
      usedPrevious.add(exactIndex);
      return [{ ...previousIngredients[exactIndex] }];
    }

    const parsed = parseRecipeIngredientLine(line);
    return parsed ? [parsed] : [];
  });
}

export function formatRecipeTextList(items: string[] | undefined): string {
  return (items ?? []).join('\n');
}

export function parseRecipeTextList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(stripListMarker)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function scaleIngredientAmount(
  amount: string | undefined,
  fromPortions: number,
  toPortions: number
): string | undefined {
  if (!amount || fromPortions <= 0 || toPortions <= 0 || fromPortions === toPortions) return amount;

  const trimmed = amount.trim();
  const match = trimmed.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)(.*)$/);
  if (!match) return amount;

  const [, quantityText, suffix] = match;
  // Ranges ("2-3", "2 to 3"), dimensions ("2-inch"), and alternatives are ambiguous.
  if (/^\s*(?:[-–—]|to\b|or\b)/i.test(suffix)) return amount;

  const quantity = parseQuantity(quantityText);
  if (quantity === null) return amount;

  const scaled = quantity * (toPortions / fromPortions);
  if (!Number.isFinite(scaled) || scaled < 0) return amount;

  const leadingWhitespace = amount.match(/^\s*/)?.[0] ?? '';
  const trailingWhitespace = amount.match(/\s*$/)?.[0] ?? '';
  return `${leadingWhitespace}${formatQuantity(scaled)}${suffix.trimEnd()}${trailingWhitespace}`;
}

export function scaleRecipeIngredients(
  ingredients: RecipeIngredient[],
  fromPortions: number,
  toPortions: number
): RecipeIngredient[] {
  return ingredients.map((ingredient) => ({
    ...ingredient,
    amount: scaleIngredientAmount(ingredient.amount, fromPortions, toPortions)
  }));
}

export function shoppingIngredients(
  ingredients: RecipeIngredient[],
  pantryNames?: string[]
): RecipeIngredient[] {
  const pantry = pantryNames === undefined
    ? null
    : new Set(pantryNames.map((name) => normalizeIngredientName(name).toLocaleLowerCase()));

  return ingredients.filter((ingredient) => (
    Boolean(ingredient.needsShopping)
    || Boolean(pantry && !pantry.has(normalizeIngredientName(ingredient.name).toLocaleLowerCase()))
  ));
}
