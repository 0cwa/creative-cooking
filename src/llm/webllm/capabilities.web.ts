import { evaluateWebLlmCapability, type LocalCapabilityResult } from './capabilityPolicy';

export async function getLocalInferenceCapabilities(): Promise<LocalCapabilityResult> {
  const storage = navigator.storage;
  const storageEstimateAvailable = Boolean(storage?.estimate);
  const estimate = storageEstimateAvailable ? await storage.estimate() : {};
  const persistent = storage?.persisted ? await storage.persisted() : false;

  return evaluateWebLlmCapability({
    platform: 'web',
    webGpu: Boolean((navigator as Navigator & { gpu?: unknown }).gpu),
    worker: typeof Worker !== 'undefined',
    storageEstimateAvailable,
    usage: estimate.usage,
    quota: estimate.quota,
    persistent
  });
}
