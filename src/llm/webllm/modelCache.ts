export async function isLocalModelCached(_model: string): Promise<boolean> {
  return false;
}

export async function downloadLocalModel(
  _model: string,
  _onStatus?: (status: string) => void,
  _signal?: AbortSignal
): Promise<void> {
  throw new Error('Local WebLLM downloads are available only in the PWA.');
}

export async function deleteLocalModel(_model: string): Promise<void> {
  throw new Error('Local WebLLM cache management is available only in the PWA.');
}
