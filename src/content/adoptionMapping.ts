import type { PersistedState } from '../domain/types';
import { personalConversationsFromState } from './personalRecordCodec.ts';
import { encodeContentRows, type ContentRows } from './recordCodec.ts';

function hash(value: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed, seedIndex) => {
    let result = seed;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index) + seedIndex;
      result = Math.imul(result, 0x01000193);
    }
    return (result >>> 0).toString(16).padStart(8, '0');
  }).join('');
}

function adoptionId(migrationId: string, spaceId: string, table: string, sourceId: string): string {
  return `guest-${hash(`${spaceId}\0${migrationId}\0${table}\0${sourceId}`)}`;
}

/**
 * Map a guest aggregate into a chosen workspace without carrying globally
 * colliding guest root IDs across workspaces. Nested recipe IDs stay scoped to
 * their recipe and retain their original values.
 */
export function remapGuestStateForWorkspace(
  state: PersistedState,
  migrationId: string,
  spaceId: string
): { state: PersistedState; rows: ContentRows } {
  const remap = (table: string, id: string) => adoptionId(migrationId, spaceId, table, id);
  const recipeIds = new Map(state.recipes.map((recipe) => [recipe.id, remap('recipes', recipe.id)]));
  const listIds = new Map(state.shopping.lists.map((list) => [list.id, remap('shopping_lists', list.id)]));
  const cycleIds = new Map(state.shopping.cycles.map((cycle) => [cycle.id, remap('shopping_cycles', cycle.id)]));
  const itemIds = new Map(state.shopping.items.map((item) => [item.id, remap('shopping_items', item.id)]));
  const pantryIds = new Map(state.pantry.map((item) => [item.id, remap('pantry_items', item.id)]));

  const remapped: PersistedState = {
    ...state,
    pantry: state.pantry.map((item) => ({ ...item, id: pantryIds.get(item.id)! })),
    recipes: state.recipes.map((recipe) => ({
      ...recipe,
      id: recipeIds.get(recipe.id)!,
      ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient })),
      stepIds: recipe.stepIds ? [...recipe.stepIds] : undefined
    })),
    shopping: {
      lists: state.shopping.lists.map((list) => ({
        ...list,
        id: listIds.get(list.id)!,
        currentCycleId: cycleIds.get(list.currentCycleId) ?? remap('shopping_cycles', list.currentCycleId)
      })),
      cycles: state.shopping.cycles.map((cycle) => ({
        ...cycle,
        id: cycleIds.get(cycle.id)!,
        listId: listIds.get(cycle.listId) ?? remap('shopping_lists', cycle.listId)
      })),
      items: state.shopping.items.map((item) => ({
        ...item,
        id: itemIds.get(item.id)!,
        listId: listIds.get(item.listId) ?? remap('shopping_lists', item.listId),
        ...(item.recipeId ? { recipeId: recipeIds.get(item.recipeId) ?? remap('recipes', item.recipeId) } : {}),
        purchaseCycleId: cycleIds.get(item.purchaseCycleId) ?? remap('shopping_cycles', item.purchaseCycleId),
        ...(item.purchasedCycleId ? { purchasedCycleId: cycleIds.get(item.purchasedCycleId) ?? remap('shopping_cycles', item.purchasedCycleId) } : {})
      })),
      purchases: state.shopping.purchases.map((purchase) => ({
        ...purchase,
        id: remap('shopping_purchases', purchase.id),
        listId: listIds.get(purchase.listId) ?? remap('shopping_lists', purchase.listId),
        purchaseCycleId: cycleIds.get(purchase.purchaseCycleId) ?? remap('shopping_cycles', purchase.purchaseCycleId),
        itemIds: purchase.itemIds.map((id) => itemIds.get(id) ?? remap('shopping_items', id)),
        pantryItemIds: purchase.pantryItemIds.map((id) => pantryIds.get(id) ?? remap('pantry_items', id))
      }))
    }
  };
  return { state: remapped, rows: encodeContentRows(remapped, spaceId) };
}

/**
 * Guest Chef identities are copied into the destination personal workspace
 * with deterministic, migration-scoped IDs. Initial proposal status is kept
 * verbatim, including historical `applied` status; this mapping never creates
 * a cooking effect or a server receipt.
 */
export function remapGuestPersonalStateForWorkspace(
  state: PersistedState,
  migrationId: string,
  personalSpaceId: string
): Pick<PersistedState, 'chatMessages' | 'chatHistory' | 'activeConversationId' | 'mealContext' | 'settings'> {
  const conversations = personalConversationsFromState(state).map((conversation) => {
    const id = adoptionId(migrationId, personalSpaceId, 'personal_conversations', conversation.id);
    return {
      ...conversation,
      id,
      messages: conversation.messages.map((message) => ({
        ...message,
        id: adoptionId(migrationId, personalSpaceId, `personal_chat_messages:${conversation.id}`, message.id),
        ...(message.proposals ? {
          proposals: message.proposals.map((proposal) => ({
            ...proposal,
            id: adoptionId(migrationId, personalSpaceId,
              `personal_chat_proposals:${conversation.id}:${message.id}`, proposal.id)
          }))
        } : {})
      }))
    };
  });
  const sourceActiveConversationId = state.activeConversationId;
  const activeConversation = sourceActiveConversationId
    ? conversations.find((conversation) => conversation.id === adoptionId(migrationId, personalSpaceId, 'personal_conversations', sourceActiveConversationId)) ?? null
    : null;
  const activeConversationId = activeConversation?.id ?? null;
  return {
    chatMessages: activeConversation?.messages ?? [],
    chatHistory: conversations.filter((conversation) => conversation.id !== activeConversationId),
    activeConversationId,
    mealContext: state.mealContext,
    settings: {
      ...state.settings,
      sendLocalTime: state.settings.sendLocalTime,
      providerId: state.settings.providerId,
      model: state.settings.model,
      dictationEngine: state.settings.dictationEngine
    }
  };
}
