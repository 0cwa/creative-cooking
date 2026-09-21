import { evaluateWebLlmCapability, type LocalCapabilityResult } from './capabilityPolicy';

type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter?: () => Promise<unknown>;
  };
};

export async function getLocalInferenceCapabilities(): Promise<LocalCapabilityResult> {
  const storage = navigator.storage;
  const storageEstimateAvailable = Boolean(storage?.estimate);
  const estimate = storageEstimateAvailable ? await storage.estimate() : {};
  const persistent = storage?.persisted ? await storage.persisted() : false;

  const gpu = (navigator as NavigatorWithGpu).gpu;
  let webGpu = false;
  try {
    webGpu = Boolean(gpu?.requestAdapter && await gpu.requestAdapter());
  } catch {
    webGpu = false;
  }

  return evaluateWebLlmCapability({
    platform: 'web',
    webGpu,
    worker: typeof Worker !== 'undefined',
    storageEstimateAvailable,
    usage: estimate.usage,
    quota: estimate.quota,
    persistent
  });
}
