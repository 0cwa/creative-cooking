export async function isLocalModelCached(_model: string): Promise<boolean> {
  return false;
}

export async function downloadLocalModel(): Promise<void> {
  throw new Error('Local WebLLM downloads are available only in the PWA.');
}

export async function deleteLocalModel(): Promise<void> {
  throw new Error('Local WebLLM cache management is available only in the PWA.');
}
