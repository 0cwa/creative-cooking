import { LlmRequestError } from '@/llm/errors';
import type { LlmProvider } from '@/llm/types';

export const webLlmProvider: LlmProvider = {
  id: 'webllm',
  name: 'Experimental local Chef',
  async run() {
    throw new LlmRequestError(
      'Experimental local Chef currently requires the PWA in a browser with WebGPU support.',
      { kind: 'model_unavailable' }
    );
  }
};
