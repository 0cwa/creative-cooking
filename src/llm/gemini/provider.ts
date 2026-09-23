import { CHEF_TOOLS } from '@/chef/tools';
import { LlmRequestError, normalizeLlmError } from '@/llm/errors';
import { SseDataParser } from '@/llm/openrouter/streaming';
import { executeChefTool } from '@/llm/toolExecution';
import type { ChefRunResult, LlmProvider, ToolExecutor } from '@/llm/types';

type GeminiFunctionCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};

type GeminiFunctionResponse = {
  id?: string;
  name: string;
  response: Record<string, unknown>;
};

type GeminiPart =
  | { text: string; thoughtSignature?: string }
  | { functionCall: GeminiFunctionCall; thoughtSignature?: string }
  | { functionResponse: GeminiFunctionResponse };

type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

function geminiTools() {
  return [{
    functionDeclarations: CHEF_TOOLS.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }))
  }];
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds * 1000, 0), 3000) : undefined;
}

function geminiError(status: number, message: string, retryAfterMs?: number): LlmRequestError {
  if (status === 401 || status === 403) return new LlmRequestError(message, { kind: 'auth', status });
  if (status === 404) return new LlmRequestError(message, { kind: 'model_unavailable', status });
  if (status === 429) return new LlmRequestError(message, { kind: 'rate_limit', retryable: true, status, retryAfterMs });
  if ([408, 500, 502, 503, 504].includes(status)) {
    return new LlmRequestError(message, { kind: 'provider', retryable: true, status, retryAfterMs });
  }
  if (status >= 400 && status < 500) return new LlmRequestError(message, { kind: 'invalid_request', status });
  return new LlmRequestError(message, { kind: 'provider', status });
}

async function readError(response: Response): Promise<string> {
  const fallback = `Gemini request failed (${response.status})`;
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

async function generateOnce(
  apiKey: string,
  model: string,
  systemPrompt: string,
  contents: GeminiContent[],
  toolsEnabled: boolean,
  options: {
    signal?: AbortSignal;
    onTextDelta?: (delta: string) => void;
    onStreamActivity?: () => void;
  }
): Promise<GeminiContent> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      signal: options.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...(toolsEnabled ? { tools: geminiTools() } : {})
      })
    });
  } catch (error) {
    throw normalizeLlmError(error);
  }

  if (!response.ok) {
    throw geminiError(
      response.status,
      await readError(response),
      parseRetryAfter(response.headers.get('Retry-After'))
    );
  }

  const parser = new SseDataParser();
  const assembledParts: GeminiPart[] = [];

  const appendTextPart = (text: string, thoughtSignature?: string) => {
    if (!text && !thoughtSignature) return;
    const previous = assembledParts.at(-1);
    if ('text' in (previous ?? {}) && !thoughtSignature && !(previous as { thoughtSignature?: string }).thoughtSignature) {
      (previous as { text: string }).text += text;
    } else {
      assembledParts.push({ text, ...(thoughtSignature ? { thoughtSignature } : {}) });
    }
    if (text) options.onTextDelta?.(text);
  };

  const appendFunctionCallPart = (rawPart: any) => {
    const call = rawPart.functionCall as GeminiFunctionCall;
    const identity = call.id || JSON.stringify([call.name, call.args ?? {}]);
    const existing = assembledParts.find((part) => (
      'functionCall' in part
      && (part.functionCall.id || JSON.stringify([part.functionCall.name, part.functionCall.args ?? {}])) === identity
    ));
    if (existing && 'functionCall' in existing) {
      if (rawPart.thoughtSignature && !existing.thoughtSignature) existing.thoughtSignature = rawPart.thoughtSignature;
      return;
    }
    assembledParts.push({
      functionCall: call,
      ...(typeof rawPart.thoughtSignature === 'string' ? { thoughtSignature: rawPart.thoughtSignature } : {})
    });
  };

  const consume = (event: string) => {
    let payload: any;
    try {
      payload = JSON.parse(event);
    } catch {
      throw new LlmRequestError('Gemini returned an invalid streaming event.', { kind: 'provider' });
    }

    options.onStreamActivity?.();

    const parts = payload?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return;

    for (const part of parts) {
      if (typeof part?.text === 'string') {
        appendTextPart(
          part.text,
          typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined
        );
      }
      if (part?.functionCall && typeof part.functionCall.name === 'string') {
        appendFunctionCallPart(part);
      }
    }
  };

  const consumeTail = (tail: string) => {
    for (const event of [...parser.push(tail), ...parser.finish()]) consume(event);
  };

  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) consume(event);
      }
      consumeTail(decoder.decode());
    } else {
      consumeTail(await response.text());
    }
  } catch (error) {
    throw normalizeLlmError(error);
  }

  if (!assembledParts.length) {
    throw new LlmRequestError('Gemini returned no message.', { kind: 'provider', retryable: true });
  }

  return { role: 'model', parts: assembledParts };
}

async function generate(
  apiKey: string,
  model: string,
  systemPrompt: string,
  contents: GeminiContent[],
  toolsEnabled: boolean,
  options: { signal?: AbortSignal; onTextDelta?: (delta: string) => void }
): Promise<GeminiContent> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let streamStarted = false;
    try {
      return await generateOnce(apiKey, model, systemPrompt, contents, toolsEnabled, {
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
  throw new LlmRequestError('Gemini request failed.', { kind: 'provider' });
}

function parseToolResult(result: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { result: parsed };
  } catch {
    return { result };
  }
}

function runTool(call: GeminiFunctionCall, internalId: string, tools: ToolExecutor) {
  return executeChefTool({
    id: internalId,
    name: call.name,
    arguments: JSON.stringify(call.args ?? {})
  }, tools);
}

export const geminiProvider: LlmProvider = {
  id: 'gemini',
  name: 'Google Gemini',
  async run({ apiKey, model, systemPrompt, messages, tools, signal, onTextDelta }): Promise<ChefRunResult> {
    const working: GeminiContent[] = messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));

    let collectedText = '';
    let executedSideEffect = false;

    try {
      for (let round = 0; round < 5; round += 1) {
        let roundTextStarted = false;
        const assistant = await generate(apiKey, model, systemPrompt, working, Boolean(tools), {
          signal,
          onTextDelta: (delta) => {
            if (!roundTextStarted && collectedText) onTextDelta?.('\n\n');
            roundTextStarted = true;
            onTextDelta?.(delta);
          }
        });

        const text = assistant.parts
          .filter((part): part is { text: string } => 'text' in part)
          .map((part) => part.text)
          .join('');
        if (text) collectedText = [collectedText, text].filter(Boolean).join('\n\n');

        working.push(assistant);

        const calls = assistant.parts
          .filter((part): part is { functionCall: GeminiFunctionCall } => 'functionCall' in part)
          .map((part) => part.functionCall);
        if (!calls.length || !tools) return { text: collectedText || 'Done.' };

        const responseParts: GeminiPart[] = [];
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index];
          const internalId = call.id || `gemini-${round}-${index}`;
          const outcome = runTool(call, internalId, tools);
          if (outcome.sideEffectApplied) executedSideEffect = true;
          if (outcome.question) return { text: collectedText, question: outcome.question };
          responseParts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: parseToolResult(outcome.result)
            }
          });
        }
        working.push({ role: 'user', parts: responseParts });
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
