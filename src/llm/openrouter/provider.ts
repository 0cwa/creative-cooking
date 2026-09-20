import { CHEF_TOOLS } from '@/chef/tools';
import type { IngredientPreference, Recipe, UiQuestion } from '@/domain/types';
import type { ChefRunResult, LlmProvider, ToolExecutor } from '@/llm/types';

type OpenRouterToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type OpenRouterMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
};

type CompletionResponse = {
  choices?: Array<{ message?: OpenRouterMessage }>;
  error?: { message?: string };
};

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asPreference(value: unknown): IngredientPreference {
  const numeric = Number(value);
  if (numeric >= 1 && numeric <= 5) return numeric as IngredientPreference;
  return 3;
}

function executeTool(call: OpenRouterToolCall, tools: ToolExecutor): { result: string; question?: UiQuestion } {
  const args = parseArgs(call.function.arguments);

  switch (call.function.name) {
    case 'pantry_add': {
      const names = Array.isArray(args.names) ? args.names.filter((x): x is string => typeof x === 'string') : [];
      tools.addPantry(names, asPreference(args.preference));
      return { result: JSON.stringify({ ok: true, added: names }) };
    }
    case 'pantry_remove': {
      const name = typeof args.name === 'string' ? args.name : '';
      const removed = tools.removePantry(name);
      return { result: JSON.stringify({ ok: removed, name }) };
    }
    case 'pantry_set_preference': {
      const name = typeof args.name === 'string' ? args.name : '';
      const updated = tools.setPantryPreference(name, asPreference(args.preference));
      return { result: JSON.stringify({ ok: updated, name }) };
    }
    case 'recipe_save': {
      const title = typeof args.title === 'string' ? args.title.trim() : 'Untitled recipe';
      const portions = Math.max(1, Number(args.portions) || 2);
      const ingredients = Array.isArray(args.ingredients)
        ? args.ingredients
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
            .map((item) => ({
              name: typeof item.name === 'string' ? item.name : '',
              amount: typeof item.amount === 'string' ? item.amount : undefined,
              needsShopping: typeof item.needsShopping === 'boolean' ? item.needsShopping : undefined
            }))
            .filter((item) => item.name)
        : [];
      const steps = Array.isArray(args.steps) ? args.steps.filter((x): x is string => typeof x === 'string') : [];
      const notes = Array.isArray(args.notes) ? args.notes.filter((x): x is string => typeof x === 'string') : undefined;
      const recipe = tools.saveRecipe({
        title,
        description: typeof args.description === 'string' ? args.description : undefined,
        portions,
        ingredients,
        steps,
        notes
      } as Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>);
      return { result: JSON.stringify({ ok: true, recipeId: recipe.id }) };
    }
    case 'ask_user': {
      const prompt = typeof args.prompt === 'string' ? args.prompt : 'Which option do you prefer?';
      const options = Array.isArray(args.options) ? args.options.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
      return {
        result: JSON.stringify({ awaiting_user: true }),
        question: {
          id: call.id,
          prompt,
          options: options.length >= 2 ? options : ['First option', 'Second option']
        }
      };
    }
    default:
      return { result: JSON.stringify({ ok: false, error: 'Unknown tool' }) };
  }
}

async function completion(apiKey: string, model: string, messages: OpenRouterMessage[]): Promise<OpenRouterMessage> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://0cwa.github.io/creative-cooking/',
      'X-Title': 'Creative Cooking'
    },
    body: JSON.stringify({
      model,
      messages,
      tools: CHEF_TOOLS,
      tool_choice: 'auto',
      temperature: 0.8
    })
  });

  const data = (await response.json()) as CompletionResponse;
  if (!response.ok) throw new Error(data.error?.message ?? `OpenRouter request failed (${response.status})`);
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('OpenRouter returned no message.');
  return message;
}

export const openRouterProvider: LlmProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  async run({ apiKey, model, systemPrompt, messages, tools }): Promise<ChefRunResult> {
    const working: OpenRouterMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({ role: message.role, content: message.content }) as OpenRouterMessage)
    ];

    let collectedText = '';

    for (let round = 0; round < 5; round += 1) {
      const assistant = await completion(apiKey, model, working);
      if (assistant.content) collectedText = [collectedText, assistant.content].filter(Boolean).join('\n\n');
      working.push(assistant);

      if (!assistant.tool_calls?.length) return { text: collectedText || 'Done.' };

      for (const call of assistant.tool_calls) {
        const outcome = executeTool(call, tools);
        if (outcome.question) {
          return { text: collectedText, question: outcome.question };
        }
        working.push({ role: 'tool', content: outcome.result, tool_call_id: call.id });
      }
    }

    return { text: collectedText || 'I made the requested updates.' };
  }
};
