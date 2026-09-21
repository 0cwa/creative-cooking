import { createOpenAiCompatibleProvider } from '@/llm/openaiCompatibleProvider';

export const mistralProvider = createOpenAiCompatibleProvider({
  id: 'mistral',
  name: 'Mistral',
  endpoint: 'https://api.mistral.ai/v1/chat/completions',
  headers: (apiKey) => ({
    Authorization: `Bearer ${apiKey}`
  })
});
