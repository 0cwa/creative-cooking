import { CHEF_TOOLS } from '@/chef/tools';
import { LlmRequestError, normalizeLlmError } from '@/llm/errors';
import { executeChefTool } from '@/llm/toolExecution';
import type { ChefRunResult, LlmProvider, ToolExecutor } from '@/llm/types';
import { OpenRouterStreamAccumulator, SseDataParser } from '@/llm/openrouter/streaming';

type CompatibleToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type CompatibleMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: CompatibleToolCall[];
  tool_call_id?: string;
};

type CompatibleStreamError = {
  error?: {
    message?: string;
    code?: number | string;
  };
};

export type OpenAiCompatibleProviderConfig = {
  id: string;
  name: string;
  endpoint: string;
  headers(apiKey: string): Record<string, string>;
};

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 3000);

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 3000);
  return undefined;
}

function providerError(
  providerName: string,
  status: number,
  message: string,
  retryAfterMs?: number
): LlmRequestError {
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
  return new LlmRequestError(message || `${providerName} request failed.`, { kind: 'provider', status });
}

async function readErrorMessage(providerName: string, response: Response): Promise<string> {
  const fallback = `${providerName} request failed (${response.status})`;
  try {
    const raw = await response.text();
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown };
      message?: unknown;
      detail?: unknown;
    };
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
    return fallback;
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
  config: OpenAiCompatibleProviderConfig,
  apiKey: string,
  model: string,
  messages: CompatibleMessage[],
  toolsEnabled: boolean,
  options: {
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
    onStreamActivity?: () => void;
  }
): Promise<CompatibleMessage> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        ...config.headers(apiKey),
        'Content-Type': 'application/json'
      },
      signal: options.signal,
      body: JSON.stringify({
        model,
        messages,
        ...(toolsEnabled ? { tools: CHEF_TOOLS, tool_choice: 'auto' } : {}),
        stream: true
      })
    });
  } catch (error) {
    throw normalizeLlmError(error);
  }

  if (!response.ok) {
    throw providerError(
      config.name,
      response.status,
      await readErrorMessage(config.name, response),
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
      throw new LlmRequestError(`${config.name} returned an invalid streaming event.`, { kind: 'provider' });
    }

    options.onStreamActivity?.();

    const streamError = payload as CompatibleStreamError;
    if (streamError.error) {
      const numericCode = Number(streamError.error.code);
      const status = Number.isFinite(numericCode) ? numericCode : 500;
      throw providerError(config.name, status, streamError.error.message ?? `${config.name} streaming request failed.`);
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
    throw new LlmRequestError(`${config.name} returned no message.`, { kind: 'provider', retryable: true });
  }

  return assembled as CompatibleMessage;
}

async function completion(
  config: OpenAiCompatibleProviderConfig,
  apiKey: string,
  model: string,
  messages: CompatibleMessage[],
  toolsEnabled: boolean,
  options: {
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
  }
): Promise<CompatibleMessage> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let streamStarted = false;

    try {
      return await completionOnce(config, apiKey, model, messages, toolsEnabled, {
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

  throw new LlmRequestError(`${config.name} request failed.`, { kind: 'provider' });
}

function executeCompatibleTool(call: CompatibleToolCall, tools: ToolExecutor) {
  return executeChefTool({
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments
  }, tools);
}

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleProviderConfig): LlmProvider {
  return {
    id: config.id,
    name: config.name,
    async run({ apiKey, model, systemPrompt, messages, tools, signal, onTextDelta }): Promise<ChefRunResult> {
      const toolsEnabled = Boolean(tools);
      const working: CompatibleMessage[] = [
        { role: 'system', content: systemPrompt },
        ...messages.map((message) => ({ role: message.role, content: message.content }) as CompatibleMessage)
      ];

      let collectedText = '';
      let executedSideEffect = false;

      try {
        for (let round = 0; round < 5; round += 1) {
          let roundTextStarted = false;
          const assistant = await completion(config, apiKey, model, working, toolsEnabled, {
            signal,
            onTextDelta: (delta) => {
              if (!roundTextStarted && collectedText) onTextDelta?.('\n\n');
              roundTextStarted = true;
              onTextDelta?.(delta);
            }
          });
          if (assistant.content) collectedText = [collectedText, assistant.content].filter(Boolean).join('\n\n');
          working.push(assistant);

          if (!assistant.tool_calls?.length || !tools) return { text: collectedText || 'Done.' };

          for (const call of assistant.tool_calls) {
            const outcome = executeCompatibleTool(call, tools);
            if (outcome.sideEffectApplied) executedSideEffect = true;
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
}
