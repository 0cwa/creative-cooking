export const CHEF_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'pantry_add',
      description: 'Add one or more concise ingredient descriptions to the pantry. Preserve useful known details such as dried, fresh, frozen, cooked, pickled, ground, or refrigerated in the description; quantities are not required.',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' } },
          preference: { type: 'integer', minimum: 1, maximum: 5, default: 3 }
        },
        required: ['names']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pantry_update',
      description: 'Refine the description of an existing pantry item without changing its star preference. Use this when the user clarifies form, condition, preparation, or storage, for example mint → mint (dried) or okra → okra (frozen).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          newName: { type: 'string' }
        },
        required: ['name', 'newName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pantry_remove',
      description: 'Remove an ingredient from the pantry by name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pantry_set_preference',
      description: 'Set how much the user wants to eat an ingredient: 5 strongly wants, 3 neutral/open, 1 strongly does not want.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          preference: { type: 'integer', minimum: 1, maximum: 5 }
        },
        required: ['name', 'preference']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recipe_save',
      description: 'Save one complete recipe to the user recipe collection. For a meal with multiple distinct recipes, call recipe_save once per recipe so each is stored independently. Application-level allergy validation may reject ingredients that match or plausibly contain a configured allergen; if rejected, revise the recipe before presenting it as saved.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          portions: { type: 'integer', minimum: 1 },
          ingredients: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                amount: { type: 'string' },
                needsShopping: { type: 'boolean' }
              },
              required: ['name']
            }
          },
          steps: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'portions', 'ingredients', 'steps']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask one concise multiple-choice clarification question. Use only when the answer materially changes the recommendation.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          options: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } }
        },
        required: ['prompt', 'options']
      }
    }
  }
] as const;
