import type { ContentMutationOperation } from '../account/contracts';
import type { PersistedState, Recipe } from '../domain/types';
import { validateHistorySnapshotIds } from './historySnapshot.ts';

type Versions = {
  recipes: Map<string, number>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function mapById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function recipePayload(recipe: Recipe) {
  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description ?? null,
    portions: recipe.portions,
    notes: recipe.notes ?? [],
    ingredients: recipe.ingredients.map((ingredient) => {
      const { id, name, amount, needsShopping, ...metadata } = ingredient;
      return {
        id: id ?? '',
        name,
        amount: amount ?? null,
        needsShopping: needsShopping ?? false,
        metadata
      };
    }),
    steps: recipe.steps.map((text, index) => ({ id: recipe.stepIds?.[index] ?? `step-${recipe.id}-${index}`, text }))
  };
}

function knownShoppingTime(value: string | null): string {
  if (value === null) throw new Error('This shopping record has no known timestamp and cannot be sent to the existing workspace.');
  return value;
}

function shoppingItemPayload(item: PersistedState['shopping']['items'][number]) {
  return {
    id: item.id,
    listId: item.listId,
    name: item.name,
    recipeId: item.recipeId ?? null,
    ingredientId: item.ingredientId ?? null,
    displayQuantity: item.displayQuantity ?? null,
    displayUnit: item.displayUnit ?? null,
    purchaseCycleId: item.purchaseCycleId,
    checked: item.checked,
    purchasedCycleId: item.purchasedCycleId ?? null,
    createdAt: knownShoppingTime(item.createdAt),
    updatedAt: knownShoppingTime(item.updatedAt)
  };
}

function itemIdFromOperation(operation: ContentMutationOperation): string | null {
  if (operation.type === 'shopping.item.upsert') return operation.item.id;
  if (operation.type === 'shopping.item.check' || operation.type === 'shopping.item.remove') return operation.id;
  return null;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

/**
 * Translate one local state transition into the concrete server domain commands.
 * These are deliberately app-level commands, not PowerSync table CRUD or an
 * engine-neutral adapter interface.
 */
export function buildContentMutationOperations(
  before: PersistedState,
  after: PersistedState,
  versions: Versions = { recipes: new Map() }
): ContentMutationOperation[] {
  const operations: ContentMutationOperation[] = [];
  const priorPantry = mapById(before.pantry);
  const nextPantry = mapById(after.pantry);
  const priorPurchases = mapById(before.shopping.purchases);
  const newPurchases = after.shopping.purchases.filter((purchase) => !priorPurchases.has(purchase.id));
  for (const purchase of newPurchases) {
    validateHistorySnapshotIds(purchase.itemIds, 'item IDs');
    validateHistorySnapshotIds(purchase.pantryItemIds, 'pantry IDs');
  }
  const purchaseCreatedPantryIds = new Set(newPurchases.flatMap((purchase) => purchase.pantryItemIds));
  for (const [id, item] of nextPantry) {
    // A purchase creates its pantry additions inside the same server transaction
    // as the ledger and item completion. Do not also send those as standalone
    // pantry upserts, which could survive a rejected or stale purchase.
    if (!priorPantry.has(id) && purchaseCreatedPantryIds.has(id)) continue;
    if (stable(item) !== stable(priorPantry.get(id))) {
      operations.push({ opId: '', type: 'pantry.upsert', id, name: item.name, preference: item.preference });
    }
  }
  for (const id of priorPantry.keys()) {
    if (!nextPantry.has(id)) operations.push({ opId: '', type: 'pantry.delete', id });
  }

  const priorRecipes = mapById(before.recipes);
  const nextRecipes = mapById(after.recipes);
  for (const [id, recipe] of nextRecipes) {
    if (stable(recipe) !== stable(priorRecipes.get(id))) {
      operations.push({
        opId: '', type: 'recipe.save', baseVersion: versions.recipes.get(id) ?? null,
        recipe: recipePayload(recipe)
      });
    }
  }
  for (const id of priorRecipes.keys()) {
    if (nextRecipes.has(id)) continue;
    operations.push({ opId: '', type: 'recipe.delete', id, baseVersion: versions.recipes.get(id) ?? 1 });
  }

  const priorLists = mapById(before.shopping.lists);
  const nextLists = mapById(after.shopping.lists);
  const priorCycles = mapById(before.shopping.cycles);
  const nextCycles = mapById(after.shopping.cycles);
  const startedCycleLists = new Set<string>();
  for (const [id, list] of nextLists) {
    const prior = priorLists.get(id);
    if (!prior) {
      const cycle = nextCycles.get(list.currentCycleId);
      if (cycle) {
        operations.push({
          opId: '', type: 'shopping.list.create',
          list: { id, name: list.name, currentCycleId: list.currentCycleId, createdAt: knownShoppingTime(list.createdAt), updatedAt: knownShoppingTime(list.updatedAt) },
          cycle: { id: cycle.id, listId: cycle.listId, startedAt: cycle.startedAt }
        });
        startedCycleLists.add(id);
      }
      continue;
    }
    if (!prior.removedAt && list.removedAt) {
      operations.push({ opId: '', type: 'shopping.list.remove', id, removedAt: list.removedAt });
      continue;
    }
    if (prior.name !== list.name) {
      operations.push({ opId: '', type: 'shopping.list.rename', id, name: list.name, updatedAt: knownShoppingTime(list.updatedAt) });
    }
    if (prior.currentCycleId !== list.currentCycleId) {
      const cycle = nextCycles.get(list.currentCycleId);
      if (cycle && !priorCycles.has(cycle.id)) {
        operations.push({ opId: '', type: 'shopping.cycle.start', listId: id, cycle: { id: cycle.id, startedAt: cycle.startedAt } });
        startedCycleLists.add(id);
      }
    }
  }

  const priorItems = mapById(before.shopping.items);
  const nextItems = mapById(after.shopping.items);
  const purchaseByItem = new Map(newPurchases.flatMap((purchase) => purchase.itemIds.map((id) => [id, purchase] as const)));
  for (const [id, item] of nextItems) {
    const prior = priorItems.get(id);
    // Logical removal is terminal. The server retains a tombstone, so later
    // aggregate differences must not try to restore or edit that identity.
    if (prior?.removedAt) continue;
    const purchase = purchaseByItem.get(id);
    if (purchase) {
      const beforePurchase = prior
        ? { ...shoppingItemPayload(item), checked: prior.checked, purchasedCycleId: prior.purchasedCycleId ?? null }
        : { ...shoppingItemPayload(item), checked: false, purchasedCycleId: null };
      if (!prior || stable(beforePurchase) !== stable(shoppingItemPayload(prior))) {
        operations.push({ opId: '', type: 'shopping.item.upsert', item: beforePurchase });
      }
      continue;
    }
    if (!prior) {
      operations.push({ opId: '', type: 'shopping.item.upsert', item: shoppingItemPayload(item) });
      if (item.removedAt) {
        operations.push({ opId: '', type: 'shopping.item.remove', id, listId: item.listId, purchaseCycleId: item.purchaseCycleId, removedAt: item.removedAt });
      }
      continue;
    }
    if (!prior.removedAt && item.removedAt) {
      operations.push({ opId: '', type: 'shopping.item.remove', id, listId: item.listId, purchaseCycleId: prior.purchaseCycleId, removedAt: item.removedAt });
      continue;
    }
    if (startedCycleLists.has(item.listId) && item.purchaseCycleId !== prior.purchaseCycleId) continue;
    if (item.checked !== prior.checked && item.purchaseCycleId === prior.purchaseCycleId) {
      operations.push({ opId: '', type: 'shopping.item.check', id, listId: item.listId, purchaseCycleId: item.purchaseCycleId, checked: item.checked });
      continue;
    }
    if (stable(item) !== stable(prior)) {
      operations.push({ opId: '', type: 'shopping.item.upsert', item: shoppingItemPayload(item) });
    }
  }

  for (const purchase of newPurchases) {
    operations.push({
      opId: '',
      type: 'shopping.purchase',
      purchase: {
        id: purchase.id,
        listId: purchase.listId,
        purchaseCycleId: purchase.purchaseCycleId,
        itemIds: purchase.itemIds,
        pantryItemIds: purchase.pantryItemIds,
        purchasedAt: purchase.purchasedAt
      },
      pantryAdds: purchase.pantryItemIds.flatMap((id) => {
        const item = nextPantry.get(id);
        return item && !priorPantry.has(id) ? [{ id, name: item.name, preference: item.preference }] : [];
      })
    });
  }

  const rank = (operation: ContentMutationOperation): number => {
    if (operation.type.startsWith('pantry.')) return 0;
    if (operation.type.startsWith('recipe.')) return 1;
    if (operation.type === 'shopping.list.remove') return 7;
    if (operation.type.startsWith('shopping.list.')) return 2;
    if (operation.type === 'shopping.cycle.start') return 3;
    if (operation.type.startsWith('shopping.item.')) return 4;
    return 5;
  };
  return operations.sort((left, right) => rank(left) - rank(right));
}

/**
 * Adoption copies the current pantry/items as ordinary rows and imports the
 * purchase ledger without replaying its pantry or completion side effects.
 */
export function buildGuestAdoptionMutationOperations(
  before: PersistedState,
  after: PersistedState,
  versions: Versions = { recipes: new Map() }
): ContentMutationOperation[] {
  const base = buildContentMutationOperations(before, after, versions);
  const previousPurchases = mapById(before.shopping.purchases);
  const newPurchases = after.shopping.purchases.filter((purchase) => !previousPurchases.has(purchase.id));
  const importedItemIds = new Set(newPurchases.flatMap((purchase) => purchase.itemIds));

  const operations = base.filter((operation) => (
    operation.type !== 'shopping.purchase'
    && !(itemIdFromOperation(operation) && importedItemIds.has(itemIdFromOperation(operation)!))
  ));

  // The normal transition builder keeps purchase-created pantry rows inside
  // `shopping.purchase`; adoption imports the existing pantry as state, so add
  // those rows explicitly and leave history import effect-free.
  const previousPantry = mapById(before.pantry);
  const nextPantry = mapById(after.pantry);
  const importPantryIds = new Set(newPurchases.flatMap((purchase) => purchase.pantryItemIds));
  for (const id of importPantryIds) {
    const pantry = nextPantry.get(id);
    if (pantry && !previousPantry.has(id)) {
      operations.push({ opId: '', type: 'pantry.upsert', id, name: pantry.name, preference: pantry.preference });
    }
  }

  // Current item rows remain normal workspace records. The matching ledger
  // later supplies the purchased marker when that row is decoded; the import
  // command itself never changes item completion.
  const nextItems = mapById(after.shopping.items);
  const listById = mapById(after.shopping.lists);
  for (const id of importedItemIds) {
    const item = nextItems.get(id);
    if (!item || item.removedAt) continue;
    const list = listById.get(item.listId);
    if (!list || item.purchaseCycleId !== list.currentCycleId) continue;
    operations.push({
      opId: '',
      type: 'shopping.item.upsert',
      item: { ...shoppingItemPayload(item), checked: item.checked, purchasedCycleId: null }
    });
  }

  const priorCycleIds = new Set(before.shopping.cycles.map((cycle) => cycle.id));
  const priorListIds = new Set(before.shopping.lists.map((list) => list.id));
  const histories: ContentMutationOperation[] = [];
  for (const list of after.shopping.lists) {
    const cycles = after.shopping.cycles
      .filter((cycle) => cycle.listId === list.id && cycle.id !== list.currentCycleId && !priorCycleIds.has(cycle.id))
      .map((cycle) => ({ id: cycle.id, startedAt: cycle.startedAt }));
    const purchases = newPurchases
      .filter((purchase) => purchase.listId === list.id)
      .map((purchase) => ({
        id: purchase.id,
        purchaseCycleId: purchase.purchaseCycleId,
        itemIds: purchase.itemIds,
        pantryItemIds: purchase.pantryItemIds,
        purchasedAt: purchase.purchasedAt
      }));
    if (!cycles.length && !purchases.length) continue;

    // Cycle chunks precede purchase chunks so a purchase can name a cycle
    // inserted by an earlier history-import transaction after interruption.
    for (const cycleBatch of chunks(cycles, 100)) {
      histories.push({
        opId: '', type: 'shopping.history.import', listId: list.id, currentCycleId: list.currentCycleId,
        cycles: cycleBatch, purchases: []
      });
    }
    for (const purchaseBatch of chunks(purchases, 100)) {
      histories.push({
        opId: '', type: 'shopping.history.import', listId: list.id, currentCycleId: list.currentCycleId,
        cycles: [], purchases: purchaseBatch
      });
    }
  }
  operations.push(...histories);

  // New removed lists must be created long enough to import their rows and
  // historical ledgers, then tombstoned after those commands are accepted.
  for (const list of after.shopping.lists) {
    if (!priorListIds.has(list.id) && list.removedAt) {
      operations.push({ opId: '', type: 'shopping.list.remove', id: list.id, removedAt: list.removedAt });
    }
  }

  const rank = (operation: ContentMutationOperation): number => {
    if (operation.type.startsWith('pantry.')) return 0;
    if (operation.type.startsWith('recipe.')) return 1;
    if (operation.type === 'shopping.list.remove') return 7;
    if (operation.type.startsWith('shopping.list.')) return 2;
    if (operation.type === 'shopping.cycle.start') return 3;
    if (operation.type.startsWith('shopping.item.')) return 4;
    if (operation.type === 'shopping.history.import') return 6;
    return 5;
  };
  return operations.sort((left, right) => rank(left) - rank(right));
}

export function withOperationIds(mutationId: string, operations: ContentMutationOperation[]): ContentMutationOperation[] {
  return operations.map((operation, index) => ({ ...operation, opId: `${mutationId}:${index}` }));
}

export function splitContentOperations(operations: ContentMutationOperation[], limit = 100): ContentMutationOperation[][] {
  const batches: ContentMutationOperation[][] = [];
  for (let index = 0; index < operations.length; index += limit) batches.push(operations.slice(index, index + limit));
  return batches;
}
