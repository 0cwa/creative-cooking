/** @param {string} value */
export function normalizeIngredientName(value) {
  return value.trim().replace(/\s+/g, ' ');
}
