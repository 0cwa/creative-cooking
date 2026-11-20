// Only the application's embedded WebLLM provider is treated as on-device.
// A URL, hostname or provider label containing "local" is not evidence.
export function allowsFreshLocalInference(storageMode,providerId) {
 return storageMode==='existing'||(storageMode==='fresh-local'&&providerId==='webllm');
}
