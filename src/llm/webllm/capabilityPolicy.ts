export const WEBLLM_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
export const WEBLLM_MODEL_VRAM_MB = 879.04;
export const WEBLLM_RECOMMENDED_FREE_BYTES = 1.5 * 1024 * 1024 * 1024;

export type LocalCapabilitySnapshot = {
  platform: 'web' | 'native';
  webGpu: boolean;
  worker: boolean;
  storageEstimateAvailable: boolean;
  usage?: number;
  quota?: number;
  persistent: boolean;
};

export type LocalCapabilityResult = LocalCapabilitySnapshot & {
  available: boolean;
  freeBytes?: number;
  recommendedFreeBytes: number;
  reasons: string[];
};

export function evaluateWebLlmCapability(snapshot: LocalCapabilitySnapshot): LocalCapabilityResult {
  const reasons: string[] = [];
  const freeBytes = typeof snapshot.quota === 'number' && typeof snapshot.usage === 'number'
    ? Math.max(0, snapshot.quota - snapshot.usage)
    : undefined;

  if (snapshot.platform !== 'web') reasons.push('Local WebLLM is currently available only in the PWA.');
  if (!snapshot.webGpu) reasons.push('WebGPU is unavailable in this browser.');
  if (!snapshot.worker) reasons.push('Web Workers are unavailable in this browser.');
  if (!snapshot.storageEstimateAvailable || freeBytes === undefined) {
    reasons.push('Browser storage capacity could not be checked.');
  } else if (freeBytes < WEBLLM_RECOMMENDED_FREE_BYTES) {
    reasons.push('At least 1.5 GB of free browser storage is recommended before downloading the model.');
  }

  return {
    ...snapshot,
    freeBytes,
    recommendedFreeBytes: WEBLLM_RECOMMENDED_FREE_BYTES,
    available: reasons.length === 0,
    reasons
  };
}
