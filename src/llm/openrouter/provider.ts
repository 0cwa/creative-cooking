import { CHEF_TOOLS } from '@/chef/tools';
import {
  pantryNamesFromToolArgs,
  parseToolArguments,
  preferenceFromToolValue,
  questionFromToolArgs,
  recipeFromToolArgs
} from '@/chef/toolPayload';
import { RecipeAllergyError } from '@/domain/allergyValidation';
import type { UiQuestion } from '@/domain/types';
import { LlmRequestError, normalizeLlmError } from '@/llm/errors';
import type { ChefRunResult, LlmProvider, ToolExecutor } from '@/llm/types';
import { OpenRouterStreamAccumulator, SseDataParser } from './streaming';

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

type OpenRouterStreamError = {
  error?: {
    message?: string;
    code?: number | string;
  };
};

function executeTool(call: OpenRouterToolCall, tools: ToolExecutor): { result: string; question?: UiQuestion } {
  const args = parseToolArguments(call.function.arguments);

  switch (call.function.name) {
    case 'pantry_add': {
      const names = pantryNamesFromToolArgs(args);
      tools.addPantry(names, preferenceFromToolValue(args.preference));
      return { result: JSON.stringify({ ok: true, added: names }) };
    }
    case 'pantry_remove': {
      const name = typeof args.name === 'string' ? args.name : '';
      const removed = tools.removePantry(name);
      return { result: JSON.stringify({ ok: removed, name }) };
    }
    case 'pantry_set_preference': {
      const name = typeof args.name === 'string' ? args.name : '';
      const updated = tools.setPantryPreference(name, preferenceFromToolValue(args.preference));
      return { result: JSON.stringify({ ok: updated, name }) };
    }
    case 'recipe_save': {
      try {
        const recipe = tools.saveRecipe(recipeFromToolArgs(args));
        return { result: JSON.stringify({ ok: true, recipeId: recipe.id }) };
      } catch (error) {
        if (error instanceof RecipeAllergyError) {
          return {
            result: JSON.stringify({
              ok: false,
              error: 'allergy_validation_failed',
              message: error.message,
              matches: error.matches
            })
          };
        }
        throw error;
      }
    }
    case 'ask_user': {
      return {
        result: JSON.stringify({ awaiting_user: true }),
        question: questionFromToolArgs(args, call.id)
      };
    }
    default:
      return { result: JSON.stringify({ ok: false, error: 'Unknown tool' }) };
  }
}

function toolHasSideEffects(name: string): boolean {
  return name === 'pantry_add' || name === 'pantry_remove' || name === 'pantry_set_preference' || name === 'recipe_save';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 3000);

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 3000);
  return undefined;
}

function openRouterError(status: number, message: string, retryAfterMs?: number): LlmRequestError {
  if (status === 401 || status === 403) {
    return new LlmRequestError(message, { kind: 'auth', status });
  }
  if (status === 402) {
    return new LlmRequestError(message, { kind: 'credits', status });
  }
  if (status === 404) {
    return new LlmRequestError(message, { kind: 'model_unavailable', status });
  }
  if (status === 429) {
    return new LlmRequestError(message, { kind: 'rate_limit', retryable: true, status, retryAfterMs });
  }
  if ([408, 500, 502, 503, 504, 524, 529].includes(status)) {
    return new LlmRequestError(message, { kind: 'provider', retryable: true, status, retryAfterMs });
  }
  if (status >= 400 && status < 500) {
    return new LlmRequestError(message, { kind: 'invalid_request', status });
  }
  return new LlmRequestError(message, { kind: 'provider', status });
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `OpenRouter request failed (${response.status})`;
  try {
    const raw = await response.text();
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === 'string' ? parsed.error.message : fallback;
  } catch {
    return fallback;
  }
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new LlmRequestError('The request was cancelled.', { kind: 'cancelled' }));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function completionOnce(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  options: {
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
    onStreamActivity?: () => void;
  }
): Promise<OpenRouterMessage> {
  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://0cwa.github.io/creative-cooking/',
        'X-Title': 'Creative Cooking'
      },
      signal: options.signal,
      body: JSON.stringify({
        model,
        messages,
        tools: CHEF_TOOLS,
        tool_choice: 'auto',
        temperature: 0.8,
        stream: true
      })
    });
  } catch (error) {
    throw normalizeLlmError(error);
  }

  if (!response.ok) {
    throw openRouterError(
      response.status,
      await readErrorMessage(response),
      parseRetryAfter(response.headers.get('Retry-After'))
    );
  }

  const parser = new SseDataParser();
  const accumulator = new OpenRouterStreamAccumulator();
  let doneSeen = false;

  const consumeEvent = (event: string) => {
    if (event === '[DONE]') {
      doneSeen = true;
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event);
    } catch {
      throw new LlmRequestError('OpenRouter returned an invalid streaming event.', { kind: 'provider' });
    }

    options.onStreamActivity?.();

    const streamError = payload as OpenRouterStreamError;
    if (streamError.error) {
      const numericCode = Number(streamError.error.code);
      const status = Number.isFinite(numericCode) ? numericCode : 500;
      throw openRouterError(status, streamError.error.message ?? 'OpenRouter streaming request failed.');
    }

    const delta = accumulator.apply(payload);
    if (delta) options.onTextDelta?.(delta);
  };

  try {
    const body = response.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const decoder = new TextDecoder();

      while (!doneSeen) {
        const { done, value } = await reader.read();
        if (done) break;
        const events = parser.push(decoder.decode(value, { stream: true }));
        for (const event of events) {
          consumeEvent(event);
          if (doneSeen) break;
        }
      }

      if (!doneSeen) {
        const tail = decoder.decode();
        for (const event of [...parser.push(tail), ...parser.finish()]) consumeEvent(event);
      }
    } else {
      const raw = await response.text();
      for (const event of [...parser.push(raw), ...parser.finish()]) {
        consumeEvent(event);
        if (doneSeen) break;
      }
    }
  } catch (error) {
    throw normalizeLlmError(error);
  }

  const assembled = accumulator.message();
  if (!assembled.content && !assembled.tool_calls?.length) {
    throw new LlmRequestError('OpenRouter returned no message.', { kind: 'provider', retryable: true });
  }

  return assembled as OpenRouterMessage;
}

async function completion(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  options: {
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
  }
): Promise<OpenRouterMessage> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let streamStarted = false;

    try {
      return await completionOnce(apiKey, model, messages, {
        ...options,
        onStreamActivity: () => {
          streamStarted = true;
        }
      });
    } catch (error) {
      const normalized = normalizeLlmError(error);
      const canRetry =
        normalized.retryable &&
        !streamStarted &&
        !options.signal?.aborted &&
        attempt === 0;

      if (!canRetry) throw normalized;
      await waitForRetry(normalized.retryAfterMs ?? 600, options.signal);
    }
  }

  throw new LlmRequestError('OpenRouter request failed.', { kind: 'provider' });
}

export const openRouterProvider: LlmProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  async run({ apiKey, model, systemPrompt, messages, tools, signal, onTextDelta }): Promise<ChefRunResult> {
    const working: OpenRouterMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({ role: message.role, content: message.content }) as OpenRouterMessage)
    ];

    let collectedText = '';
    let executedSideEffect = false;

    try {
      for (let round = 0; round < 5; round += 1) {
        let roundTextStarted = false;
        const assistant = await completion(apiKey, model, working, {
          signal,
          onTextDelta: (delta) => {
            if (!roundTextStarted && collectedText) onTextDelta?.('\n\n');
            roundTextStarted = true;
            onTextDelta?.(delta);
          }
        });
        if (assistant.content) collectedText = [collectedText, assistant.content].filter(Boolean).join('\n\n');
        working.push(assistant);

        if (!assistant.tool_calls?.length) return { text: collectedText || 'Done.' };

        for (const call of assistant.tool_calls) {
          const outcome = executeTool(call, tools);
          if (toolHasSideEffects(call.function.name)) executedSideEffect = true;
          if (outcome.question) {
            return { text: collectedText, question: outcome.question };
          }
          working.push({ role: 'tool', content: outcome.result, tool_call_id: call.id });
        }
      }

      return { text: collectedText || 'I made the requested updates.' };
    } catch (error) {
      const normalized = normalizeLlmError(error);
      if (executedSideEffect && normalized.retryable) {
        throw new LlmRequestError(normalized.message, {
          kind: normalized.kind,
          retryable: false,
          status: normalized.status
        });
      }
      throw normalized;
    }
  }
};
