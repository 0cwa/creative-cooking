import { CHEF_TOOLS } from '@/chef/tools';
import { LlmRequestError, normalizeLlmError } from '@/llm/errors';
import { SseDataParser } from '@/llm/openrouter/streaming';
import { executeChefTool, toolHasSideEffects } from '@/llm/toolExecution';
import type { ChefRunResult, LlmProvider, ToolExecutor } from '@/llm/types';

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string };
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock;
type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Array<AnthropicBlock | AnthropicToolResultBlock>;
};

type PendingBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; arguments: string };

function anthropicTools() {
  return CHEF_TOOLS.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 3000);
  return undefined;
}

function anthropicError(status: number, message: string, retryAfterMs?: number): LlmRequestError {
  if (status === 401 || status === 403) return new LlmRequestError(message, { kind: 'auth', status });
  if (status === 404) return new LlmRequestError(message, { kind: 'model_unavailable', status });
  if (status === 429) return new LlmRequestError(message, { kind: 'rate_limit', retryable: true, status, retryAfterMs });
  if ([408, 500, 502, 503, 504, 529].includes(status)) {
    return new LlmRequestError(message, { kind: 'provider', retryable: true, status, retryAfterMs });
  }
  if (status >= 400 && status < 500) return new LlmRequestError(message, { kind: 'invalid_request', status });
  return new LlmRequestError(message, { kind: 'provider', status });
}

async function readError(response: Response): Promise<string> {
  const fallback = `Anthropic request failed (${response.status})`;
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
  if (signal?.aborted) throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new LlmRequestError('The request was cancelled.', { kind: 'cancelled' }));
    }, { once: true });
  });
}

async function messageOnce(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: AnthropicMessage[],
  toolsEnabled: boolean,
  options: {
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
    onStreamActivity?: () => void;
  }
): Promise<AnthropicBlock[]> {
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type': 'application/json'
      },
      signal: options.signal,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        ...(toolsEnabled ? { tools: anthropicTools() } : {}),
        stream: true
      })
    });
  } catch (error) {
    throw normalizeLlmError(error);
  }

  if (!response.ok) {
    throw anthropicError(
      response.status,
      await readError(response),
      parseRetryAfter(response.headers.get('Retry-After'))
    );
  }

  const parser = new SseDataParser();
  const blocks: Array<PendingBlock | undefined> = [];
  let stopped = false;

  const consume = (event: string) => {
    let payload: any;
    try {
      payload = JSON.parse(event);
    } catch {
      throw new LlmRequestError('Anthropic returned an invalid streaming event.', { kind: 'provider' });
    }

    options.onStreamActivity?.();

    if (payload?.type === 'error') {
      const errorType = String(payload.error?.type ?? '');
      const status = errorType === 'overloaded_error' ? 529 : 500;
      throw anthropicError(status, String(payload.error?.message ?? 'Anthropic streaming request failed.'));
    }

    if (payload?.type === 'message_stop') {
      stopped = true;
      return;
    }

    if (payload?.type === 'content_block_start') {
      const index = Number(payload.index);
      const block = payload.content_block;
      if (!Number.isInteger(index) || !block) return;
      if (block.type === 'text') {
        blocks[index] = { type: 'text', text: String(block.text ?? '') };
      } else if (block.type === 'tool_use') {
        blocks[index] = {
          type: 'tool_use',
          id: String(block.id ?? ''),
          name: String(block.name ?? ''),
          arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : ''
        };
      }
      return;
    }

    if (payload?.type === 'content_block_delta') {
      const index = Number(payload.index);
      const current = blocks[index];
      if (!current) return;
      if (current.type === 'text' && payload.delta?.type === 'text_delta') {
        const delta = String(payload.delta.text ?? '');
        current.text += delta;
        if (delta) options.onTextDelta?.(delta);
      } else if (current.type === 'tool_use' && payload.delta?.type === 'input_json_delta') {
        current.arguments += String(payload.delta.partial_json ?? '');
      }
    }
  };

  const consumeRaw = (raw: string) => {
    for (const event of [...parser.push(raw), ...parser.finish()]) {
      consume(event);
      if (stopped) break;
    }
  };

  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          consume(event);
          if (stopped) break;
        }
      }
      if (!stopped) consumeRaw(decoder.decode());
    } else {
      consumeRaw(await response.text());
    }
  } catch (error) {
    throw normalizeLlmError(error);
  }

  const output: AnthropicBlock[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text') {
      if (block.text) output.push({ type: 'text', text: block.text });
      continue;
    }

    let input: Record<string, unknown>;
    try {
      input = block.arguments ? JSON.parse(block.arguments) as Record<string, unknown> : {};
    } catch {
      throw new LlmRequestError('Anthropic returned invalid tool arguments.', { kind: 'provider' });
    }
    output.push({ type: 'tool_use', id: block.id, name: block.name, input });
  }

  if (!output.length) {
    throw new LlmRequestError('Anthropic returned no message.', { kind: 'provider', retryable: true });
  }
  return output;
}

async function message(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: AnthropicMessage[],
  toolsEnabled: boolean,
  options: { signal?: AbortSignal; onTextDelta?: (delta: string) => void }
): Promise<AnthropicBlock[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let streamStarted = false;
    try {
      return await messageOnce(apiKey, model, systemPrompt, messages, toolsEnabled, {
        ...options,
        onStreamActivity: () => {
          streamStarted = true;
        }
      });
    } catch (error) {
      const normalized = normalizeLlmError(error);
      if (!(normalized.retryable && !streamStarted && !options.signal?.aborted && attempt === 0)) throw normalized;
      await waitForRetry(normalized.retryAfterMs ?? 600, options.signal);
    }
  }
  throw new LlmRequestError('Anthropic request failed.', { kind: 'provider' });
}

function runTool(block: AnthropicToolUseBlock, tools: ToolExecutor) {
  return executeChefTool({
    id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input)
  }, tools);
}

export const anthropicProvider: LlmProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  async run({ apiKey, model, systemPrompt, messages, tools, signal, onTextDelta }): Promise<ChefRunResult> {
    const working: AnthropicMessage[] = messages.map((item) => ({
      role: item.role,
      content: item.content
    }));
    let collectedText = '';
    let executedSideEffect = false;

    try {
      for (let round = 0; round < 5; round += 1) {
        let roundTextStarted = false;
        const blocks = await message(apiKey, model, systemPrompt, working, Boolean(tools), {
          signal,
          onTextDelta: (delta) => {
            if (!roundTextStarted && collectedText) onTextDelta?.('\n\n');
            roundTextStarted = true;
            onTextDelta?.(delta);
          }
        });

        const text = blocks
          .filter((block): block is AnthropicTextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text) collectedText = [collectedText, text].filter(Boolean).join('\n\n');

        working.push({ role: 'assistant', content: blocks });

        const calls = blocks.filter((block): block is AnthropicToolUseBlock => block.type === 'tool_use');
        if (!calls.length || !tools) return { text: collectedText || 'Done.' };

        const results: AnthropicToolResultBlock[] = [];
        for (const call of calls) {
          const outcome = runTool(call, tools);
          if (toolHasSideEffects(call.name)) executedSideEffect = true;
          if (outcome.question) return { text: collectedText, question: outcome.question };
          results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.result });
        }
        working.push({ role: 'user', content: results });
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
