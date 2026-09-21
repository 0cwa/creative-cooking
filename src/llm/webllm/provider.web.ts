import type {
  ChatCompletionMessageParam,
  MLCEngineInterface
} from '@mlc-ai/web-llm';
import { LlmRequestError, normalizeLlmError } from '@/llm/errors';
import type { ChefRunResult, LlmProvider } from '@/llm/types';
import { getLocalInferenceCapabilities } from './capabilities';
import { isLocalModelCached } from './modelCache';
import { ensureWebLlmEngine, resetWebLlmEngine } from './runtime';

function missingCacheError(): LlmRequestError {
  return new LlmRequestError(
    'The local model is not downloaded on this device. Open Settings → Local models to download it before using local Chef.',
    { kind: 'model_unavailable' }
  );
}

export const webLlmProvider: LlmProvider = {
  id: 'webllm',
  name: 'Experimental local Chef',
  async run({ model, systemPrompt, messages, signal, onTextDelta, onStatus }): Promise<ChefRunResult> {
    const capability = await getLocalInferenceCapabilities();
    if (!capability.available) {
      throw new LlmRequestError(capability.reasons.join(' '), { kind: 'model_unavailable' });
    }

    if (!(await isLocalModelCached(model))) {
      throw missingCacheError();
    }

    if (signal?.aborted) {
      throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
    }

    onStatus?.('Opening downloaded local model…');

    let engine: MLCEngineInterface;
    try {
      engine = await ensureWebLlmEngine(model, onStatus, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
      }

      const stillCached = await isLocalModelCached(model).catch(() => false);
      if (!stillCached) throw missingCacheError();

      throw new LlmRequestError(
        error instanceof Error ? error.message : 'The downloaded local model could not be opened.',
        { kind: 'provider', retryable: true }
      );
    }

    if (signal?.aborted) {
      await engine.interruptGenerate();
      throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
    }

    const working: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({ role: message.role, content: message.content }))
    ];

    const onAbort = () => {
      void engine.interruptGenerate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let text = '';
    try {
      onStatus?.('Local Chef is thinking…');
      const stream = await engine.chat.completions.create({
        messages: working,
        stream: true,
        temperature: 0.7,
        max_tokens: 512
      });

      for await (const chunk of stream) {
        if (signal?.aborted) {
          throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
        }

        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          onTextDelta?.(delta);
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
      }

      resetWebLlmEngine();
      throw normalizeLlmError(error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (!text.trim()) {
      throw new LlmRequestError('The local model returned no text.', {
        kind: 'provider',
        retryable: true
      });
    }

    onStatus?.('');
    return { text };
  }
};
