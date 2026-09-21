export function resetWebLlmEngine(): void {}

export async function ensureWebLlmEngine(): Promise<never> {
  throw new Error('WebLLM is available only in the PWA.');
}
