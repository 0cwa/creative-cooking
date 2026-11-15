import { column, Schema, Table } from '@powersync/common';

const pantryColumns = {
  space_id: column.text,
  entity_id: column.text,
  name: column.text,
  preference: column.integer,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const recipeColumns = {
  space_id: column.text,
  entity_id: column.text,
  title: column.text,
  description: column.text,
  portions: column.integer,
  notes: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const ingredientColumns = {
  space_id: column.text,
  entity_id: column.text,
  recipe_id: column.text,
  position: column.integer,
  name: column.text,
  amount: column.text,
  needs_shopping: column.integer,
  metadata: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const stepColumns = {
  space_id: column.text,
  entity_id: column.text,
  recipe_id: column.text,
  position: column.integer,
  text: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const shoppingListColumns = {
  space_id: column.text,
  entity_id: column.text,
  name: column.text,
  current_cycle_id: column.text,
  created_at: column.text,
  updated_at: column.text,
  removed_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const shoppingCycleColumns = {
  space_id: column.text,
  entity_id: column.text,
  list_id: column.text,
  started_at: column.text
};

const shoppingItemColumns = {
  space_id: column.text,
  entity_id: column.text,
  list_id: column.text,
  name: column.text,
  recipe_id: column.text,
  ingredient_id: column.text,
  display_quantity: column.text,
  display_unit: column.text,
  purchase_cycle_id: column.text,
  checked: column.integer,
  purchased_cycle_id: column.text,
  created_at: column.text,
  updated_at: column.text,
  removed_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const shoppingPurchaseColumns = {
  space_id: column.text,
  entity_id: column.text,
  list_id: column.text,
  purchase_cycle_id: column.text,
  item_ids: column.text,
  pantry_item_ids: column.text,
  purchased_at: column.text
};

const personalProfileFieldColumns = {
  space_id: column.text,
  entity_id: column.text,
  field_key: column.text,
  value: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const personalAllergyColumns = {
  space_id: column.text,
  entity_id: column.text,
  name: column.text,
  normalized_name: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const personalConversationColumns = {
  space_id: column.text,
  entity_id: column.text,
  title: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const personalMessageColumns = {
  space_id: column.text,
  entity_id: column.text,
  conversation_id: column.text,
  role: column.text,
  content: column.text,
  created_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const personalProposalColumns = {
  space_id: column.text,
  entity_id: column.text,
  conversation_id: column.text,
  message_id: column.text,
  tool_name: column.text,
  arguments: column.text,
  status: column.text,
  created_at: column.text,
  updated_at: column.text,
  version: column.integer,
  updated_by: column.text
};

const personalConflictColumns = {
  space_id: column.text,
  entity_id: column.text,
  mutation_id: column.text,
  op_id: column.text,
  entity_type: column.text,
  entity_identity: column.text,
  field_key: column.text,
  base_version: column.integer,
  current_version: column.integer,
  attempted_content: column.text,
  reason: column.text,
  created_by: column.text,
  created_at: column.text,
  resolved_at: column.text
};

const trackPreviousRows = { trackPrevious: true };

const sharedTables = {
  pantry_items: new Table(pantryColumns, { indexes: { by_space: ['space_id'] }, ...trackPreviousRows }),
  recipes: new Table(recipeColumns, { indexes: { by_space: ['space_id'] }, ...trackPreviousRows }),
  recipe_ingredients: new Table(ingredientColumns, { indexes: { by_recipe: ['space_id', 'recipe_id'] }, ...trackPreviousRows }),
  recipe_steps: new Table(stepColumns, { indexes: { by_recipe: ['space_id', 'recipe_id'] }, ...trackPreviousRows }),
  recipe_conflicts: new Table({
    space_id: column.text,
    recipe_id: column.text,
    mutation_id: column.text,
    base_version: column.integer,
    current_version: column.integer,
    attempted_content: column.text,
    created_by: column.text,
    created_at: column.text,
    resolved_at: column.text
  }, { indexes: { by_recipe: ['space_id', 'recipe_id'] } }),
  shopping_lists: new Table(shoppingListColumns, { indexes: { by_space: ['space_id'] }, ...trackPreviousRows }),
  shopping_cycles: new Table(shoppingCycleColumns, { indexes: { by_list: ['space_id', 'list_id'] } }),
  shopping_items: new Table(shoppingItemColumns, { indexes: { by_list: ['space_id', 'list_id'] }, ...trackPreviousRows }),
  shopping_purchases: new Table({ ...shoppingPurchaseColumns, purchased_by: column.text }, { indexes: { by_list: ['space_id', 'list_id'] } })
};

const personalTables = {
  personal_profile_fields: new Table(personalProfileFieldColumns, { indexes: { by_space: ['space_id'] }, ...trackPreviousRows }),
  personal_allergies: new Table(personalAllergyColumns, { indexes: { by_space: ['space_id'] }, ...trackPreviousRows }),
  personal_conversations: new Table(personalConversationColumns, { indexes: { by_space: ['space_id'] }, ...trackPreviousRows }),
  personal_chat_messages: new Table(personalMessageColumns, { indexes: { by_conversation: ['space_id', 'conversation_id'] }, ...trackPreviousRows }),
  personal_chat_proposals: new Table(personalProposalColumns, { indexes: { by_message: ['space_id', 'conversation_id', 'message_id'] }, ...trackPreviousRows }),
  personal_content_conflicts: new Table(personalConflictColumns, { indexes: { by_space: ['space_id'] } })
};

const guestTables = {
  guest_pantry_items: new Table(pantryColumns, { localOnly: true }),
  guest_recipes: new Table(recipeColumns, { localOnly: true }),
  guest_recipe_ingredients: new Table(ingredientColumns, { localOnly: true }),
  guest_recipe_steps: new Table(stepColumns, { localOnly: true }),
  guest_shopping_lists: new Table(shoppingListColumns, { localOnly: true }),
  guest_shopping_cycles: new Table(shoppingCycleColumns, { localOnly: true }),
  guest_shopping_items: new Table(shoppingItemColumns, { localOnly: true }),
  guest_shopping_purchases: new Table(shoppingPurchaseColumns, { localOnly: true })
};

const localTables = {
  local_private_state: new Table({ data_json: column.text, updated_at: column.text }, { localOnly: true }),
  local_profile_preferences: new Table({ value: column.text, updated_at: column.text }, { localOnly: true }),
  local_migrations: new Table({ value: column.text, updated_at: column.text }, { localOnly: true }),
  local_archives: new Table({ scope_id: column.text, kind: column.text, data_json: column.text, created_at: column.text }, { localOnly: true }),
  local_sync_issues: new Table({
    space_id: column.text,
    issue_type: column.text,
    message: column.text,
    data_json: column.text,
    created_at: column.text,
    resolved_at: column.text
  }, { localOnly: true }),
  local_recipe_conflicts: new Table({
    space_id: column.text,
    recipe_id: column.text,
    attempted_json: column.text,
    current_json: column.text,
    reason: column.text,
    created_at: column.text
  }, { localOnly: true }),
  local_mutation_ids: new Table({ transaction_id: column.text, mutation_id: column.text, created_at: column.text }, { localOnly: true }),
  local_content_outbox: new Table({
    space_id: column.text,
    mutation_id: column.text,
    payload_json: column.text,
    state: column.text,
    error_json: column.text,
    created_at: column.text
  }, { localOnly: true }),
  local_proposal_actions: new Table({
    space_id: column.text,
    personal_space_id: column.text,
    conversation_id: column.text,
    message_id: column.text,
    proposal_id: column.text,
    effect_mutation_id: column.text,
    effect_op_id: column.text,
    effect_payload_json: column.text,
    status_mutation_id: column.text,
    status_op_id: column.text,
    base_version: column.integer,
    stage: column.text,
    error_json: column.text,
    created_at: column.text,
    updated_at: column.text
  }, { localOnly: true })
};

/**
 * Shared records are PowerSync managed tables; guest records, Chef state,
 * adoption receipts, recoverable archives, and conflict drafts never upload.
 */
export const AppSchema = new Schema({ ...sharedTables, ...personalTables, ...guestTables, ...localTables });

export const SHARED_TABLES = Object.keys(sharedTables) as Array<keyof typeof sharedTables>;
export const PERSONAL_CONTENT_TABLES = Object.keys(personalTables) as Array<keyof typeof personalTables>;
export const GUEST_TABLE_PREFIX = 'guest_';
export const LOCAL_GUEST_SPACE_ID = 'local-guest';
