import { PROVIDER_IDS as DOMAIN_PROVIDER_IDS, type ProviderId } from '@/domain/types';

export type CapabilitySupport = boolean | 'unknown';

export type ModelCapabilities = {
  toolCalling: CapabilitySupport;
  structuredOutput: CapabilitySupport;
  streaming: CapabilitySupport;
  location: 'cloud' | 'local';
  freeTier: CapabilitySupport;
};

export type ModelMetadata = {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
};

export type ProviderMetadata = {
  id: ProviderId;
  name: string;
  apiKeyLabel: string;
  defaultModel: string;
  knownModels: ModelMetadata[];
  unknownModelCapabilities: ModelCapabilities;
};

const CLOUD_UNKNOWN: ModelCapabilities = {
  toolCalling: 'unknown',
  structuredOutput: 'unknown',
  streaming: 'unknown',
  location: 'cloud',
  freeTier: 'unknown'
};

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderMetadata> = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    apiKeyLabel: 'OpenRouter API key',
    defaultModel: 'openrouter/free',
    knownModels: [{
      id: 'openrouter/free',
      label: 'OpenRouter Free router',
      capabilities: {
        toolCalling: true,
        structuredOutput: 'unknown',
        streaming: true,
        location: 'cloud',
        freeTier: true
      }
    }],
    unknownModelCapabilities: CLOUD_UNKNOWN
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    apiKeyLabel: 'OpenAI API key',
    defaultModel: 'gpt-5',
    knownModels: [{
      id: 'gpt-5',
      label: 'GPT-5',
      capabilities: {
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        location: 'cloud',
        freeTier: false
      }
    }],
    unknownModelCapabilities: CLOUD_UNKNOWN
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    apiKeyLabel: 'Anthropic API key',
    defaultModel: 'claude-sonnet-5',
    knownModels: [{
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      capabilities: {
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        location: 'cloud',
        freeTier: false
      }
    }],
    unknownModelCapabilities: CLOUD_UNKNOWN
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    apiKeyLabel: 'Gemini API key',
    defaultModel: 'gemini-3.8-flash',
    knownModels: [{
      id: 'gemini-3.8-flash',
      label: 'Gemini 3.8 Flash',
      capabilities: {
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        location: 'cloud',
        freeTier: true
      }
    }],
    unknownModelCapabilities: CLOUD_UNKNOWN
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    apiKeyLabel: 'Mistral API key',
    defaultModel: 'mistral-large-latest',
    knownModels: [{
      id: 'mistral-large-latest',
      label: 'Mistral Large (latest)',
      capabilities: {
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        location: 'cloud',
        freeTier: true
      }
    }],
    unknownModelCapabilities: CLOUD_UNKNOWN
  }
};

export const PROVIDER_IDS = [...DOMAIN_PROVIDER_IDS];

export function providerMetadata(providerId: ProviderId): ProviderMetadata {
  return PROVIDER_REGISTRY[providerId];
}

export function modelMetadata(providerId: ProviderId, modelId: string): ModelMetadata | null {
  const normalized = modelId.trim();
  return PROVIDER_REGISTRY[providerId].knownModels.find((model) => model.id === normalized) ?? null;
}

export function modelCapabilities(providerId: ProviderId, modelId: string): ModelCapabilities {
  return modelMetadata(providerId, modelId)?.capabilities ?? PROVIDER_REGISTRY[providerId].unknownModelCapabilities;
}
