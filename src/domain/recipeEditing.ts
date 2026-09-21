import type { RecipeIngredient } from './types';

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

export function shoppingIngredients(ingredients: RecipeIngredient[]): RecipeIngredient[] {
  return ingredients.filter((ingredient) => ingredient.needsShopping);
}
