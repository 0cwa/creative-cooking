import { createOpenAiCompatibleProvider } from '@/llm/openaiCompatibleProvider';

export const openAiProvider = createOpenAiCompatibleProvider({
  id: 'openai',
  name: 'OpenAI',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  headers: (apiKey) => ({
    Authorization: `Bearer ${apiKey}`
  })
});
