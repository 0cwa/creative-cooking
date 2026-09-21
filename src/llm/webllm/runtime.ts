export function resetWebLlmEngine(): void {}

export async function ensureWebLlmEngine(
  _model: string,
  _onStatus?: (status: string) => void,
  _signal?: AbortSignal
): Promise<never> {
  throw new Error('WebLLM is available only in the PWA.');
}
