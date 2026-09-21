import { ensureWebLlmEngine, resetWebLlmEngine } from './runtime';

export async function isLocalModelCached(model: string): Promise<boolean> {
  const webllm = await import('@mlc-ai/web-llm');
  return webllm.hasModelInCache(model);
}

export async function downloadLocalModel(
  model: string,
  onStatus?: (status: string) => void,
  signal?: AbortSignal
): Promise<void> {
  await ensureWebLlmEngine(model, onStatus, signal);
}

export async function deleteLocalModel(model: string): Promise<void> {
  resetWebLlmEngine();
  const webllm = await import('@mlc-ai/web-llm');
  await webllm.deleteModelAllInfoInCache(model);
}
