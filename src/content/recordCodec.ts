import type { PantryItem, PersistedState, Recipe, RecipeIngredient, ShoppingState } from '../domain/types';
import { DEFAULT_STATE } from '../domain/defaults.ts';
import { chatConversationFromMessages, sortChatHistory } from '../domain/conversations.ts';
import { emptyShoppingState, validateShoppingState } from '../domain/shopping.ts';
import { normalizeRecipes } from '../domain/recipeIdentity.ts';
import { validateHistorySnapshotIds } from './historySnapshot.ts';

export type ContentRecord = Record<string, string | number | null> & { id: string; entity_id: string; space_id: string };

export type ContentRows = {
  pantry_items: ContentRecord[];
  recipes: ContentRecord[];
  recipe_ingredients: ContentRecord[];
  recipe_steps: ContentRecord[];
  shopping_lists: ContentRecord[];
  shopping_cycles: ContentRecord[];
  shopping_items: ContentRecord[];
  shopping_purchases: ContentRecord[];
};

const INGREDIENT_FIELDS = new Set(['id', 'name', 'amount', 'needsShopping']);

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function contentStorageId(
  table: string,
  spaceId: string,
  parentEntityId: string | null,
  entityId: string
): string {
  const parentToken = parentEntityId === null ? 'n' : `s${encodeURIComponent(parentEntityId)}`;
  return `cc1:${table}:${spaceId.toLowerCase()}:${parentToken}:s${encodeURIComponent(entityId)}`;
}

export function nestedStorageId(kind: 'ingredient' | 'step', spaceId: string, recipeId: string, domainId: string): string {
  const table = kind === 'ingredient' ? 'recipe_ingredients' : 'recipe_steps';
  return contentStorageId(table, spaceId, recipeId, domainId);
}

function sharedRecord(spaceId: string, table: keyof ContentRows, domainId: string, parentEntityId: string | null, row: Record<string, unknown>): ContentRecord {
  return {
    id: contentStorageId(table, spaceId, parentEntityId, domainId),
    entity_id: domainId,
    space_id: spaceId,
    ...row
  } as ContentRecord;
}

export function privateStateFrom(state: PersistedState): Pick<PersistedState,
  'chatMessages' | 'chatHistory' | 'activeConversationId' | 'mealContext' | 'settings'> {
  return {
    chatMessages: state.chatMessages,
    chatHistory: state.chatHistory,
    activeConversationId: state.activeConversationId,
    mealContext: state.mealContext,
    settings: state.settings
  };
}

export function encodeContentRows(state: PersistedState, spaceId: string): ContentRows {
  const recipes = normalizeRecipes(state.recipes);
  const recipeRows: ContentRecord[] = [];
  const ingredientRows: ContentRecord[] = [];
  const stepRows: ContentRecord[] = [];

  for (const recipe of recipes) {
    recipeRows.push(sharedRecord(spaceId, 'recipes', recipe.id, null, {
      title: recipe.title,
      description: recipe.description ?? null,
      portions: recipe.portions,
      notes: jsonString(recipe.notes ?? []),
      created_at: recipe.createdAt,
      updated_at: recipe.updatedAt,
      deleted_at: null,
      version: 1,
      updated_by: null
    }));

    recipe.ingredients.forEach((ingredient, position) => {
      const metadata = Object.fromEntries(Object.entries(ingredient).filter(([key]) => !INGREDIENT_FIELDS.has(key)));
      ingredientRows.push(sharedRecord(spaceId, 'recipe_ingredients', ingredient.id!, recipe.id, {
        recipe_id: recipe.id,
        position,
        name: ingredient.name,
        amount: ingredient.amount ?? null,
        needs_shopping: ingredient.needsShopping ? 1 : 0,
        metadata: jsonString(metadata),
        created_at: recipe.createdAt,
        updated_at: recipe.updatedAt,
        deleted_at: null,
        version: 1,
        updated_by: null
      }));
    });

    recipe.steps.forEach((text, position) => {
      const domainStepId = recipe.stepIds?.[position] ?? `step-${recipe.id}-${position}`;
      stepRows.push(sharedRecord(spaceId, 'recipe_steps', domainStepId, recipe.id, {
        recipe_id: recipe.id,
        position,
        text,
        created_at: recipe.createdAt,
        updated_at: recipe.updatedAt,
        deleted_at: null,
        version: 1,
        updated_by: null
      }));
    });
  }

  const shopping: ShoppingState = validateShoppingState(state.shopping);
  return {
    pantry_items: state.pantry.map((item) => sharedRecord(spaceId, 'pantry_items', item.id, null, {
      name: item.name,
      preference: item.preference,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      deleted_at: null,
      version: 1,
      updated_by: null
    })),
    recipes: recipeRows,
    recipe_ingredients: ingredientRows,
    recipe_steps: stepRows,
    shopping_lists: shopping.lists.map((list) => sharedRecord(spaceId, 'shopping_lists', list.id, null, {
      name: list.name,
      current_cycle_id: list.currentCycleId,
      created_at: list.createdAt,
      updated_at: list.updatedAt,
      removed_at: list.removedAt ?? null,
      version: 1,
      updated_by: null
    })),
    shopping_cycles: shopping.cycles.map((cycle) => sharedRecord(spaceId, 'shopping_cycles', cycle.id, cycle.listId, {
      list_id: cycle.listId,
      started_at: cycle.startedAt
    })),
    shopping_items: shopping.items.map((item) => sharedRecord(spaceId, 'shopping_items', item.id, item.listId, {
      list_id: item.listId,
      name: item.name,
      recipe_id: item.recipeId ?? null,
      ingredient_id: item.ingredientId ?? null,
      display_quantity: item.displayQuantity ?? null,
      display_unit: item.displayUnit ?? null,
      purchase_cycle_id: item.purchaseCycleId,
      checked: item.checked ? 1 : 0,
      purchased_cycle_id: item.purchasedCycleId ?? null,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      removed_at: item.removedAt ?? null,
      version: 1,
      updated_by: null
    })),
    shopping_purchases: shopping.purchases.map((purchase) => sharedRecord(spaceId, 'shopping_purchases', purchase.id, purchase.listId, {
      list_id: purchase.listId,
      purchase_cycle_id: purchase.purchaseCycleId,
      item_ids: jsonString(validateHistorySnapshotIds(purchase.itemIds, 'item IDs')),
      pantry_item_ids: jsonString(validateHistorySnapshotIds(purchase.pantryItemIds, 'pantry IDs')),
      purchased_at: purchase.purchasedAt
    }))
  };
}

export type ContentRowSets = Partial<ContentRows>;

export function decodeContentRows(
  rows: ContentRowSets,
  defaults: PersistedState
): Pick<PersistedState, 'pantry' | 'recipes' | 'shopping'> {
  const active = (record: ContentRecord) => !record.deleted_at && !record.removed_at;
  const pantry: PantryItem[] = (rows.pantry_items ?? [])
    .filter(active)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((row) => ({
      id: String(row.entity_id ?? row.id),
      name: String(row.name ?? ''),
      preference: [1, 2, 3, 4, 5].includes(Number(row.preference)) ? Number(row.preference) as PantryItem['preference'] : 3,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? row.created_at ?? '')
    }));

  const ingredientsByRecipe = groupBy(rows.recipe_ingredients ?? [], 'recipe_id');
  const stepsByRecipe = groupBy(rows.recipe_steps ?? [], 'recipe_id');
  const purchases = (rows.shopping_purchases ?? []).map((row) => ({
    id: String(row.entity_id ?? row.id),
    listId: String(row.list_id ?? ''),
    purchaseCycleId: String(row.purchase_cycle_id ?? ''),
    itemIds: validateHistorySnapshotIds(parseJson<unknown>(row.item_ids, null), 'item IDs'),
    pantryItemIds: validateHistorySnapshotIds(parseJson<unknown>(row.pantry_item_ids, null), 'pantry IDs'),
    purchasedAt: String(row.purchased_at ?? '')
  }));
  const purchasedItemsByCycle = new Set(purchases.flatMap((purchase) =>
    purchase.itemIds.map((itemId) => `${purchase.listId}\0${purchase.purchaseCycleId}\0${itemId}`)
  ));
  const recipes: Recipe[] = (rows.recipes ?? [])
    .filter(active)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((row) => {
      const recipeId = String(row.entity_id ?? row.id);
      const ingredients = (ingredientsByRecipe.get(recipeId) ?? [])
        .filter(active)
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((ingredient) => ({
          ...parseJson<Record<string, unknown>>(ingredient.metadata, {}),
          id: String(ingredient.entity_id ?? ingredient.ingredient_id ?? ingredient.id),
          name: String(ingredient.name ?? ''),
          ...(ingredient.amount === null || ingredient.amount === undefined ? {} : { amount: String(ingredient.amount) }),
          ...(Number(ingredient.needs_shopping) ? { needsShopping: true } : {})
        } as RecipeIngredient));
      const steps = (stepsByRecipe.get(recipeId) ?? [])
        .filter(active)
        .sort((a, b) => Number(a.position) - Number(b.position));
      return {
        id: recipeId,
        title: String(row.title ?? ''),
        ...(row.description === null || row.description === undefined ? {} : { description: String(row.description) }),
        portions: Number(row.portions) || 1,
        ingredients,
        steps: steps.map((step) => String(step.text ?? '')),
        stepIds: steps.map((step) => String(step.entity_id ?? step.step_id ?? step.id)),
        notes: parseJson<string[]>(row.notes, []),
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? row.created_at ?? '')
      };
    });

  const shopping: ShoppingState = {
    lists: (rows.shopping_lists ?? []).map((row) => ({
      id: String(row.entity_id ?? row.id),
      name: String(row.name ?? ''),
      currentCycleId: String(row.current_cycle_id ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? row.created_at ?? ''),
      ...(row.removed_at ? { removedAt: String(row.removed_at) } : {})
    })),
    cycles: (rows.shopping_cycles ?? []).map((row) => ({
      id: String(row.entity_id ?? row.id),
      listId: String(row.list_id ?? ''),
      startedAt: String(row.started_at ?? '')
    })),
    items: (rows.shopping_items ?? []).map((row) => {
      const id = String(row.entity_id ?? row.id);
      const listId = String(row.list_id ?? '');
      const purchaseCycleId = String(row.purchase_cycle_id ?? '');
      const storedPurchasedCycleId = String(row.purchased_cycle_id ?? '');
      const purchasedCycleId = storedPurchasedCycleId === purchaseCycleId && storedPurchasedCycleId
        ? storedPurchasedCycleId
        : purchasedItemsByCycle.has(`${listId}\0${purchaseCycleId}\0${id}`) ? purchaseCycleId : '';
      return {
        id,
        listId,
        name: String(row.name ?? ''),
        ...(row.recipe_id ? { recipeId: String(row.recipe_id) } : {}),
        ...(row.ingredient_id ? { ingredientId: String(row.ingredient_id) } : {}),
        ...(row.display_quantity === null || row.display_quantity === undefined ? {} : { displayQuantity: String(row.display_quantity) }),
        ...(row.display_unit === null || row.display_unit === undefined ? {} : { displayUnit: String(row.display_unit) }),
        purchaseCycleId,
        checked: Boolean(Number(row.checked)),
        ...(purchasedCycleId ? { purchasedCycleId } : {}),
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? row.created_at ?? ''),
        ...(row.removed_at ? { removedAt: String(row.removed_at) } : {})
      };
    }),
    purchases
  };

  return {
    pantry,
    recipes: normalizeRecipes(recipes),
    shopping: shopping.lists.length || shopping.cycles.length || shopping.items.length || shopping.purchases.length
      ? validateShoppingState(shopping)
      : emptyShoppingState()
  };
}

function groupBy(rows: ContentRecord[], key: string): Map<string, ContentRecord[]> {
  const grouped = new Map<string, ContentRecord[]>();
  for (const row of rows) {
    const groupId = String(row[key] ?? '');
    const group = grouped.get(groupId) ?? [];
    group.push(row);
    grouped.set(groupId, group);
  }
  return grouped;
}

export function mergeGuestPrivateState(
  account: Pick<PersistedState, 'chatMessages' | 'chatHistory' | 'activeConversationId' | 'mealContext' | 'settings'>,
  guest: Pick<PersistedState, 'chatMessages' | 'chatHistory' | 'activeConversationId' | 'mealContext' | 'settings'>
): Pick<PersistedState, 'chatMessages' | 'chatHistory' | 'activeConversationId' | 'mealContext' | 'settings'> {
  const conversations = (state: typeof account) => [
    ...state.chatHistory,
    ...(state.activeConversationId
      ? [chatConversationFromMessages(state.activeConversationId, state.chatMessages)].filter((item) => item !== null)
      : [])
  ];
  const conversationById = new Map(conversations(account).map((item) => [item.id, item]));
  for (const conversation of conversations(guest)) {
    const current = conversationById.get(conversation.id);
    if (!current) {
      conversationById.set(conversation.id, conversation);
      continue;
    }
    const messages = new Map(current.messages.map((item) => [item.id, item]));
    for (const message of conversation.messages) {
      const prior = messages.get(message.id);
      if (!prior) messages.set(message.id, message);
      else if (message.proposals?.length) {
        const proposals = new Map((prior.proposals ?? []).map((proposal) => [proposal.id, proposal]));
        for (const proposal of message.proposals) if (!proposals.has(proposal.id)) proposals.set(proposal.id, proposal);
        messages.set(message.id, { ...prior, proposals: [...proposals.values()] });
      }
    }
    const combined = [...messages.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    conversationById.set(conversation.id, {
      ...current,
      title: current.title || conversation.title,
      messages: combined,
      createdAt: current.createdAt <= conversation.createdAt ? current.createdAt : conversation.createdAt,
      updatedAt: current.updatedAt >= conversation.updatedAt ? current.updatedAt : conversation.updatedAt
    });
  }
  const activeConversationId = account.activeConversationId ?? guest.activeConversationId;
  const allConversations = [...conversationById.values()];
  const activeConversation = activeConversationId
    ? allConversations.find((conversation) => conversation.id === activeConversationId) ?? null
    : null;
  const chatMessages = activeConversation?.messages ?? [];
  const chatHistory = sortChatHistory(allConversations.filter((conversation) => conversation.id !== activeConversation?.id));
  const allergies = new Map<string, string>();
  for (const name of [...account.settings.allergies, ...guest.settings.allergies]) {
    const normalized = name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
    if (normalized && !allergies.has(normalized)) allergies.set(normalized, name.trim().replace(/\s+/g, ' '));
  }
  const mealContext = {
    willingToShop: account.mealContext.willingToShop !== DEFAULT_STATE.mealContext.willingToShop
      ? account.mealContext.willingToShop : guest.mealContext.willingToShop,
    portions: account.mealContext.portions !== DEFAULT_STATE.mealContext.portions
      ? account.mealContext.portions : guest.mealContext.portions,
    cooks: JSON.stringify(account.mealContext.cooks) !== JSON.stringify(DEFAULT_STATE.mealContext.cooks)
      ? account.mealContext.cooks : guest.mealContext.cooks
  };
  return {
    chatMessages,
    chatHistory,
    activeConversationId,
    mealContext,
    settings: {
      ...account.settings,
      allergies: [...allergies.values()],
      systemPrompt: account.settings.systemPrompt !== DEFAULT_STATE.settings.systemPrompt
        ? account.settings.systemPrompt : guest.settings.systemPrompt,
      city: account.settings.city || guest.settings.city,
      sendLocalTime: account.settings.sendLocalTime,
      providerId: account.settings.providerId,
      model: account.settings.model,
      dictationEngine: account.settings.dictationEngine
    }
  };
}
