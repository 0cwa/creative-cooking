// Only the application's embedded WebLLM provider is treated as on-device.
// A URL, hostname or provider label containing "local" is not evidence.
export function allowsLocalInference(providerId) {
 return providerId==='webllm';
}
