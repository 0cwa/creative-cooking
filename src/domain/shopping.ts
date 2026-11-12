import { normalizeIngredientName } from './pantry.ts';
import { normalizeRecipes } from './recipeIdentity.ts';
import type {
  PantryItem,
  Recipe,
  ShoppingCycle,
  ShoppingItem,
  ShoppingList,
  ShoppingPurchase,
  ShoppingState
} from './types.ts';

export type NewShoppingList = {
  id: string;
  cycleId: string;
  name: string;
  at: string;
};

export type NewShoppingItem = {
  id: string;
  name: string;
  recipeId?: string;
  ingredientId?: string;
  displayQuantity?: string;
  displayUnit?: string;
  at: string;
};

export type PurchaseShoppingItems = {
  id: string;
  listId: string;
  purchaseCycleId: string;
  purchasedAt: string;
};

export type ShoppingPurchaseResult = {
  shopping: ShoppingState;
  pantry: PantryItem[];
  applied: boolean;
  pantryAdded: number;
};

export function emptyShoppingState(): ShoppingState {
  return { lists: [], cycles: [], items: [], purchases: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Shopping data has an invalid ${field}.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Shopping data has an invalid ${field}.`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`Shopping data has an invalid ${field}.`);
  return text;
}

function stringIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Shopping data has an invalid ${field}.`);
  }
  // Purchase arrays are immutable ordered snapshots. Do not deduplicate or
  // filter their values through today's live shopping or pantry rows.
  return [...value] as string[];
}

/** Validates and copies persisted shopping state without dropping record metadata. */
export function validateShoppingState(value: unknown): ShoppingState {
  if (!isRecord(value) || !Array.isArray(value.lists) || !Array.isArray(value.cycles)
    || !Array.isArray(value.items) || !Array.isArray(value.purchases)) {
    throw new Error('Shopping data is incomplete.');
  }

  const lists: ShoppingList[] = value.lists.map((entry) => {
    if (!isRecord(entry)) throw new Error('Shopping data has an invalid list.');
    const removedAt = optionalString(entry.removedAt, 'list removal time');
    return {
      ...entry,
      id: requiredString(entry.id, 'list ID'),
      name: requiredString(entry.name, 'list name'),
      currentCycleId: requiredString(entry.currentCycleId, 'current purchase cycle ID'),
      createdAt: timestamp(entry.createdAt, 'list creation time'),
      updatedAt: timestamp(entry.updatedAt, 'list update time'),
      ...(removedAt === undefined ? {} : { removedAt })
    };
  });
  const cycles: ShoppingCycle[] = value.cycles.map((entry) => {
    if (!isRecord(entry)) throw new Error('Shopping data has an invalid purchase cycle.');
    return {
      ...entry,
      id: requiredString(entry.id, 'purchase cycle ID'),
      listId: requiredString(entry.listId, 'purchase cycle list ID'),
      startedAt: timestamp(entry.startedAt, 'purchase cycle start time')
    };
  });
  const items: ShoppingItem[] = value.items.map((entry) => {
    if (!isRecord(entry) || typeof entry.checked !== 'boolean') throw new Error('Shopping data has an invalid item.');
    const removedAt = optionalString(entry.removedAt, 'item removal time');
    const purchasedCycleId = optionalString(entry.purchasedCycleId, 'item purchase cycle ID');
    const recipeId = optionalString(entry.recipeId, 'item recipe ID');
    const ingredientId = optionalString(entry.ingredientId, 'item ingredient ID');
    const displayQuantity = optionalString(entry.displayQuantity, 'item quantity');
    const displayUnit = optionalString(entry.displayUnit, 'item unit');
    return {
      ...entry,
      id: requiredString(entry.id, 'item ID'),
      listId: requiredString(entry.listId, 'item list ID'),
      name: requiredString(entry.name, 'item name'),
      ...(recipeId === undefined ? {} : { recipeId }),
      ...(ingredientId === undefined ? {} : { ingredientId }),
      ...(displayQuantity === undefined ? {} : { displayQuantity }),
      ...(displayUnit === undefined ? {} : { displayUnit }),
      purchaseCycleId: requiredString(entry.purchaseCycleId, 'item purchase cycle ID'),
      checked: entry.checked,
      ...(purchasedCycleId === undefined ? {} : { purchasedCycleId }),
      createdAt: timestamp(entry.createdAt, 'item creation time'),
      updatedAt: timestamp(entry.updatedAt, 'item update time'),
      ...(removedAt === undefined ? {} : { removedAt })
    };
  });
  const purchases: ShoppingPurchase[] = value.purchases.map((entry) => {
    if (!isRecord(entry)) throw new Error('Shopping data has an invalid purchase.');
    return {
      ...entry,
      id: requiredString(entry.id, 'purchase ID'),
      listId: requiredString(entry.listId, 'purchase list ID'),
      purchaseCycleId: requiredString(entry.purchaseCycleId, 'purchase cycle ID'),
      itemIds: stringIds(entry.itemIds, 'purchase item IDs'),
      pantryItemIds: stringIds(entry.pantryItemIds, 'purchase pantry item IDs'),
      purchasedAt: timestamp(entry.purchasedAt, 'purchase time')
    };
  });

  const listById = new Map<string, ShoppingList>();
  for (const list of lists) {
    if (listById.has(list.id)) throw new Error('Shopping data has duplicate list IDs.');
    listById.set(list.id, list);
  }
  const cycleById = new Map<string, ShoppingCycle>();
  for (const cycle of cycles) {
    if (cycleById.has(cycle.id) || !listById.has(cycle.listId)) throw new Error('Shopping data has invalid purchase cycles.');
    cycleById.set(cycle.id, cycle);
  }
  const itemById = new Map<string, ShoppingItem>();
  for (const item of items) {
    const cycle = cycleById.get(item.purchaseCycleId);
    const list = listById.get(item.listId);
    if (itemById.has(item.id) || !list || cycle?.listId !== item.listId) {
      throw new Error('Shopping data has invalid items.');
    }
    if (item.purchasedCycleId && cycleById.get(item.purchasedCycleId)?.listId !== item.listId) {
      throw new Error('Shopping data has an invalid purchased cycle.');
    }
    itemById.set(item.id, item);
  }
  for (const list of lists) {
    if (cycleById.get(list.currentCycleId)?.listId !== list.id) {
      throw new Error('Shopping data has a list without a current purchase cycle.');
    }
  }
  const purchaseIds = new Set<string>();
  for (const purchase of purchases) {
    if (purchaseIds.has(purchase.id) || cycleById.get(purchase.purchaseCycleId)?.listId !== purchase.listId) {
      throw new Error('Shopping data has invalid purchases.');
    }
    purchaseIds.add(purchase.id);
    // Purchase item/pantry IDs are immutable historical snapshots. Rows may be
    // removed or absent after a later cycle, so they are not live references.
  }

  return { lists, cycles, items, purchases };
}

/** One-time deterministic migration for old recipe rows marked needsShopping. */
export function migrateLegacyShopping(recipes: Recipe[]): ShoppingState {
  const normalized = normalizeRecipes(recipes);
  const flagged = normalized.flatMap((recipe) => recipe.ingredients
    .filter((ingredient) => ingredient.needsShopping === true)
    .map((ingredient) => ({ recipe, ingredient })));
  if (!flagged.length) return emptyShoppingState();

  const at = flagged
    .map(({ recipe }) => recipe.createdAt || recipe.updatedAt)
    .sort()[0] ?? '1970-01-01T00:00:00.000Z';
  const updatedAt = flagged
    .map(({ recipe }) => recipe.updatedAt || recipe.createdAt)
    .sort()
    .at(-1) ?? at;
  const listId = 'shopping-list-legacy';
  const cycleId = 'shopping-cycle-legacy';
  const list: ShoppingList = {
    id: listId,
    name: 'Shopping list',
    currentCycleId: cycleId,
    createdAt: at,
    updatedAt
  };
  const cycle: ShoppingCycle = { id: cycleId, listId, startedAt: at };
  const items: ShoppingItem[] = flagged.map(({ recipe, ingredient }) => ({
    id: `legacy-item:${encodeURIComponent(recipe.id)}:${encodeURIComponent(ingredient.id ?? '')}`,
    listId,
    name: ingredient.name,
    recipeId: recipe.id,
    ingredientId: ingredient.id,
    ...(ingredient.amount === undefined ? {} : { displayQuantity: ingredient.amount }),
    purchaseCycleId: cycleId,
    checked: false,
    createdAt: recipe.createdAt || recipe.updatedAt || at,
    updatedAt: recipe.updatedAt || recipe.createdAt || at
  }));

  return { lists: [list], cycles: [cycle], items, purchases: [] };
}

function activeList(state: ShoppingState, listId: string): ShoppingList | undefined {
  return state.lists.find((list) => list.id === listId && !list.removedAt);
}

export function createShoppingList(state: ShoppingState, input: NewShoppingList): ShoppingState {
  const name = input.name.trim();
  if (!name) throw new Error('Enter a name for this shopping list.');
  if (state.lists.some((list) => list.id === input.id) || state.cycles.some((cycle) => cycle.id === input.cycleId)) {
    throw new Error('Shopping list or purchase cycle ID already exists.');
  }
  const list: ShoppingList = {
    id: input.id,
    name,
    currentCycleId: input.cycleId,
    createdAt: input.at,
    updatedAt: input.at
  };
  const cycle: ShoppingCycle = { id: input.cycleId, listId: input.id, startedAt: input.at };
  return { ...state, lists: [...state.lists, list], cycles: [...state.cycles, cycle] };
}

export function appendShoppingItems(
  state: ShoppingState,
  listId: string,
  inputs: NewShoppingItem[]
): ShoppingState {
  const list = activeList(state, listId);
  if (!list) throw new Error('This shopping list is unavailable.');
  const activeSourceRefs = new Set(state.items
    .filter((item) => item.listId === listId && !item.removedAt && item.recipeId && item.ingredientId)
    .map((item) => `${item.recipeId}\0${item.ingredientId}`));
  const ids = new Set(state.items.map((item) => item.id));
  const additions: ShoppingItem[] = [];

  for (const input of inputs) {
    const name = normalizeIngredientName(input.name);
    if (!name) throw new Error('Shopping items need a name.');
    if (ids.has(input.id)) throw new Error('Shopping item ID already exists.');
    const sourceKey = input.recipeId && input.ingredientId
      ? `${input.recipeId}\0${input.ingredientId}`
      : undefined;
    if (sourceKey && activeSourceRefs.has(sourceKey)) continue;
    ids.add(input.id);
    if (sourceKey) activeSourceRefs.add(sourceKey);
    additions.push({
      id: input.id,
      listId,
      name,
      ...(input.recipeId === undefined ? {} : { recipeId: input.recipeId }),
      ...(input.ingredientId === undefined ? {} : { ingredientId: input.ingredientId }),
      ...(input.displayQuantity === undefined ? {} : { displayQuantity: input.displayQuantity }),
      ...(input.displayUnit === undefined ? {} : { displayUnit: input.displayUnit }),
      purchaseCycleId: list.currentCycleId,
      checked: false,
      createdAt: input.at,
      updatedAt: input.at
    });
  }

  return additions.length ? { ...state, items: [...state.items, ...additions] } : state;
}

export function updateShoppingItem(
  state: ShoppingState,
  itemId: string,
  patch: { name: string; displayQuantity?: string; displayUnit?: string },
  at: string
): ShoppingState {
  const item = state.items.find((candidate) => candidate.id === itemId && !candidate.removedAt);
  if (!item) return state;
  const list = activeList(state, item.listId);
  if (!list || item.purchasedCycleId === list.currentCycleId) return state;
  const name = normalizeIngredientName(patch.name);
  if (!name) throw new Error('Shopping items need a name.');
  return {
    ...state,
    items: state.items.map((candidate) => candidate.id === itemId
      ? {
          ...candidate,
          name,
          ...(patch.displayQuantity === undefined ? { displayQuantity: undefined } : { displayQuantity: patch.displayQuantity }),
          ...(patch.displayUnit === undefined ? { displayUnit: undefined } : { displayUnit: patch.displayUnit }),
          updatedAt: at
        }
      : candidate)
  };
}

export function removeShoppingItem(state: ShoppingState, itemId: string, at: string): ShoppingState {
  const item = state.items.find((candidate) => candidate.id === itemId && !candidate.removedAt);
  if (!item) return state;
  return {
    ...state,
    items: state.items.map((candidate) => candidate.id === itemId
      ? { ...candidate, removedAt: at, updatedAt: at }
      : candidate)
  };
}

export function removeShoppingList(state: ShoppingState, listId: string, at: string): ShoppingState {
  const list = activeList(state, listId);
  if (!list) return state;
  return {
    ...state,
    lists: state.lists.map((candidate) => candidate.id === listId
      ? { ...candidate, removedAt: at, updatedAt: at }
      : candidate),
    items: state.items.map((item) => item.listId === listId && !item.removedAt
      ? { ...item, removedAt: at, updatedAt: at }
      : item)
  };
}

export function setShoppingItemChecked(
  state: ShoppingState,
  itemId: string,
  expectedCycleId: string,
  checked: boolean,
  at: string
): ShoppingState {
  const item = state.items.find((candidate) => candidate.id === itemId && !candidate.removedAt);
  if (!item || item.purchaseCycleId !== expectedCycleId) return state;
  const list = activeList(state, item.listId);
  if (!list || list.currentCycleId !== expectedCycleId || item.purchasedCycleId === expectedCycleId) return state;
  return {
    ...state,
    items: state.items.map((candidate) => candidate.id === itemId
      ? { ...candidate, checked, updatedAt: at }
      : candidate)
  };
}

export function startNewPurchaseCycle(
  state: ShoppingState,
  listId: string,
  cycleId: string,
  startedAt: string
): ShoppingState {
  const list = activeList(state, listId);
  if (!list) return state;
  const existingCycle = state.cycles.find((cycle) => cycle.id === cycleId);
  if (existingCycle) return list.currentCycleId === cycleId ? state : state;
  const cycle: ShoppingCycle = { id: cycleId, listId, startedAt };
  return {
    ...state,
    cycles: [...state.cycles, cycle],
    lists: state.lists.map((candidate) => candidate.id === listId
      ? { ...candidate, currentCycleId: cycleId, updatedAt: startedAt }
      : candidate),
    items: state.items.map((item) => item.listId === listId && !item.removedAt
      ? {
          ...item,
          purchaseCycleId: cycleId,
          checked: false,
          purchasedCycleId: undefined,
          updatedAt: startedAt
        }
      : item)
  };
}

export function applyShoppingPurchase(
  state: ShoppingState,
  pantry: PantryItem[],
  command: PurchaseShoppingItems
): ShoppingPurchaseResult {
  if (state.purchases.some((purchase) => purchase.id === command.id)) {
    return { shopping: state, pantry, applied: false, pantryAdded: 0 };
  }
  const list = activeList(state, command.listId);
  if (!list || list.currentCycleId !== command.purchaseCycleId) {
    return { shopping: state, pantry, applied: false, pantryAdded: 0 };
  }
  const eligible = state.items.filter((item) => (
    item.listId === command.listId
    && !item.removedAt
    && item.purchaseCycleId === command.purchaseCycleId
    && item.checked
    && item.purchasedCycleId !== command.purchaseCycleId
  ));
  if (!eligible.length) return { shopping: state, pantry, applied: false, pantryAdded: 0 };

  const pantryNames = new Set(pantry.map((item) => normalizeIngredientName(item.name).toLocaleLowerCase()));
  const pantryAdditions: PantryItem[] = [];
  for (const item of eligible) {
    const name = normalizeIngredientName(item.name);
    const key = name.toLocaleLowerCase();
    if (!name || pantryNames.has(key)) continue;
    pantryNames.add(key);
    pantryAdditions.push({
      id: `shopping-purchase:${encodeURIComponent(command.id)}:${encodeURIComponent(item.id)}`,
      name,
      preference: 3,
      createdAt: command.purchasedAt,
      updatedAt: command.purchasedAt
    });
  }

  const purchasedIds = new Set(eligible.map((item) => item.id));
  const purchase: ShoppingPurchase = {
    id: command.id,
    listId: command.listId,
    purchaseCycleId: command.purchaseCycleId,
    itemIds: eligible.map((item) => item.id),
    pantryItemIds: pantryAdditions.map((item) => item.id),
    purchasedAt: command.purchasedAt
  };
  const shopping: ShoppingState = {
    ...state,
    items: state.items.map((item) => purchasedIds.has(item.id)
      ? { ...item, purchasedCycleId: command.purchaseCycleId, updatedAt: command.purchasedAt }
      : item),
    purchases: [...state.purchases, purchase]
  };
  return {
    shopping,
    pantry: pantryAdditions.length ? [...pantryAdditions, ...pantry] : pantry,
    applied: true,
    pantryAdded: pantryAdditions.length
  };
}
