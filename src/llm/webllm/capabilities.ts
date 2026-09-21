import { evaluateWebLlmCapability, type LocalCapabilityResult } from './capabilityPolicy';

export async function getLocalInferenceCapabilities(): Promise<LocalCapabilityResult> {
  return evaluateWebLlmCapability({
    platform: 'native',
    webGpu: false,
    worker: false,
    storageEstimateAvailable: false,
    persistent: true
  });
}
