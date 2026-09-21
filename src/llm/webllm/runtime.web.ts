import type { MLCEngineInterface } from '@mlc-ai/web-llm';

let worker: Worker | null = null;
let enginePromise: Promise<MLCEngineInterface> | null = null;
let loadedModel: string | null = null;

export function resetWebLlmEngine(): void {
  worker?.terminate();
  worker = null;
  enginePromise = null;
  loadedModel = null;
}

export async function ensureWebLlmEngine(
  model: string,
  onStatus?: (status: string) => void,
  signal?: AbortSignal
): Promise<MLCEngineInterface> {
  if (enginePromise && loadedModel === model) return enginePromise;

  resetWebLlmEngine();
  loadedModel = model;

  const onAbort = () => {
    resetWebLlmEngine();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  enginePromise = (async () => {
    const webllm = await import('@mlc-ai/web-llm');
    worker = new Worker(new URL('./webllm.worker', window.location.href));

    return webllm.CreateWebWorkerMLCEngine(worker, model, {
      initProgressCallback: (report) => {
        const percent = Math.round(report.progress * 100);
        onStatus?.(report.text || `Loading local model… ${percent}%`);
      },
      logLevel: 'WARN'
    });
  })();

  try {
    const engine = await enginePromise;
    if (signal?.aborted) {
      resetWebLlmEngine();
      throw new DOMException('The request was cancelled.', 'AbortError');
    }
    return engine;
  } catch (error) {
    resetWebLlmEngine();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
