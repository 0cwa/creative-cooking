import type { IngredientPreference, PantryItem } from './types';

export function normalizeIngredientName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function parseIngredientInput(value: string): string[] {
  return value
    .split(/[,\n;]/g)
    .map(normalizeIngredientName)
    .filter(Boolean)
    .filter((name, index, all) => all.findIndex((x) => x.toLocaleLowerCase() === name.toLocaleLowerCase()) === index);
}

export function createPantryItem(name: string, preference: IngredientPreference = 3): PantryItem {
  const now = new Date().toISOString();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: normalizeIngredientName(name),
    preference,
    createdAt: now,
    updatedAt: now
  };
}

export function groupPantryForChef(items: PantryItem[]): string {
  const labels: Array<[IngredientPreference, string]> = [
    [5, 'Would like to eat'],
    [4, 'Would probably like eating'],
    [3, 'Open to eating'],
    [2, "Probably don't want to eat"],
    [1, "Don't want to eat"]
  ];

  return labels
    .map(([rating, label]) => {
      const names = items.filter((item) => item.preference === rating).map((item) => item.name);
      return `${label}:\n${names.length ? names.map((name) => `- ${name}`).join('\n') : '- (none)'}`;
    })
    .join('\n\n');
}
