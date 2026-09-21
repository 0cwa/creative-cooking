import { createOpenAiCompatibleProvider } from '@/llm/openaiCompatibleProvider';

export const openRouterProvider = createOpenAiCompatibleProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  endpoint: 'https://openrouter.ai/api/v1/chat/completions',
  headers: (apiKey) => ({
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://0cwa.github.io/creative-cooking/',
    'X-Title': 'Creative Cooking'
  })
});
