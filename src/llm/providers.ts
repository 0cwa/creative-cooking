import type { ProviderId } from '@/domain/types';
import { anthropicProvider } from '@/llm/anthropic/provider';
import { geminiProvider } from '@/llm/gemini/provider';
import { mistralProvider } from '@/llm/mistral/provider';
import { openAiProvider } from '@/llm/openai/provider';
import { openRouterProvider } from '@/llm/openrouter/provider';
import type { LlmProvider } from '@/llm/types';

export const LLM_PROVIDERS: Record<ProviderId, LlmProvider> = {
  openrouter: openRouterProvider,
  openai: openAiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  mistral: mistralProvider
};

export function providerForId(providerId: ProviderId): LlmProvider {
  return LLM_PROVIDERS[providerId];
}
