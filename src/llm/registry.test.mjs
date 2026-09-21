import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_IDS,
  modelCapabilities,
  modelMetadata,
  providerMetadata
} from './registry.ts';

test('registry exposes every supported cloud provider with a default model', () => {
  assert.deepEqual(PROVIDER_IDS, ['openrouter', 'openai', 'anthropic', 'gemini', 'mistral']);
  for (const id of PROVIDER_IDS) {
    assert.equal(providerMetadata(id).id, id);
    assert.ok(providerMetadata(id).defaultModel);
  }
});

test('known model capability metadata is explicit', () => {
  assert.equal(modelCapabilities('openai', 'gpt-5').toolCalling, true);
  assert.equal(modelCapabilities('gemini', 'gemini-3.8-flash').freeTier, true);
  assert.equal(modelCapabilities('anthropic', 'claude-opus-5').location, 'cloud');
});

test('unknown model slugs remain usable without guessed capability claims', () => {
  assert.equal(modelMetadata('mistral', 'custom-future-model'), null);
  assert.equal(modelCapabilities('mistral', 'custom-future-model').toolCalling, 'unknown');
  assert.equal(modelCapabilities('mistral', 'custom-future-model').streaming, 'unknown');
});
