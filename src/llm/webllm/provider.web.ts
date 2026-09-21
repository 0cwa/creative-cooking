import type {
  ChatCompletionMessageParam,
  MLCEngineInterface
} from '@mlc-ai/web-llm';
import { LlmRequestError, normalizeLlmError } from '@/llm/errors';
import type { ChefRunResult, LlmProvider } from '@/llm/types';
import { getLocalInferenceCapabilities } from './capabilities';

let worker: Worker | null = null;
let enginePromise: Promise<MLCEngineInterface> | null = null;
let loadedModel: string | null = null;

function resetEngine(): void {
  worker?.terminate();
  worker = null;
  enginePromise = null;
  loadedModel = null;
}

async function getEngine(model: string, onStatus?: (status: string) => void): Promise<MLCEngineInterface> {
  if (enginePromise && loadedModel === model) return enginePromise;

  resetEngine();
  loadedModel = model;

  enginePromise = (async () => {
    const webllm = await import('@mlc-ai/web-llm');
    worker = new Worker(new URL('./webllm.worker', window.location.href));

    return webllm.CreateWebWorkerMLCEngine(worker, model, {
      initProgressCallback: (report) => {
        onStatus?.(report.text || `Loading local model… ${Math.round(report.progress * 100)}%`);
      },
      logLevel: 'WARN'
    });
  })();

  try {
    return await enginePromise;
  } catch (error) {
    resetEngine();
    throw error;
  }
}

export const webLlmProvider: LlmProvider = {
  id: 'webllm',
  name: 'Experimental local Chef',
  async run({ model, systemPrompt, messages, signal, onTextDelta, onStatus }): Promise<ChefRunResult> {
    const capability = await getLocalInferenceCapabilities();
    if (!capability.available) {
      throw new LlmRequestError(capability.reasons.join(' '), { kind: 'model_unavailable' });
    }

    if (signal?.aborted) {
      throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
    }

    onStatus?.('Preparing local model…');

    let engine: MLCEngineInterface;
    const onAbortDuringLoad = () => {
      resetEngine();
    };
    signal?.addEventListener('abort', onAbortDuringLoad, { once: true });
    try {
      engine = await getEngine(model, onStatus);
    } catch (error) {
      if (signal?.aborted) {
        throw new LlmRequestError('The request was cancelled.', { kind: 'cancelled' });
      }
      throw new LlmRequestError(
        error instanceof Error ? error.message : 'The local model could not be loaded.',
        { kind: 'provider', retryable: true }
      );
    } finally {
      signal?.removeEventListener('abort', onAbortDuringLoad);
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

      resetEngine();
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
