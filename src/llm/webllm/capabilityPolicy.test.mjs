import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WEBLLM_RECOMMENDED_FREE_BYTES,
  evaluateWebLlmCapability
} from './capabilityPolicy.ts';

const ready = {
  platform: 'web',
  webGpu: true,
  worker: true,
  storageEstimateAvailable: true,
  usage: 100,
  quota: WEBLLM_RECOMMENDED_FREE_BYTES + 100,
  persistent: true
};

test('local WebLLM is available only when web GPU, worker, and storage gates pass', () => {
  const result = evaluateWebLlmCapability(ready);
  assert.equal(result.available, true);
  assert.equal(result.freeBytes, WEBLLM_RECOMMENDED_FREE_BYTES);
  assert.deepEqual(result.reasons, []);
});

test('local WebLLM explains unsupported capability and storage conditions', () => {
  const result = evaluateWebLlmCapability({
    ...ready,
    webGpu: false,
    worker: false,
    quota: 1024
  });
  assert.equal(result.available, false);
  assert.match(result.reasons.join(' '), /WebGPU/);
  assert.match(result.reasons.join(' '), /Web Workers/);
  assert.match(result.reasons.join(' '), /1.5 GB/);
});

test('native builds fail closed and unknown browser storage is not treated as safe', () => {
  const native = evaluateWebLlmCapability({
    platform: 'native',
    webGpu: false,
    worker: false,
    storageEstimateAvailable: false,
    persistent: true
  });
  assert.equal(native.available, false);
  assert.match(native.reasons.join(' '), /PWA/);

  const unknownStorage = evaluateWebLlmCapability({
    ...ready,
    storageEstimateAvailable: false,
    usage: undefined,
    quota: undefined
  });
  assert.equal(unknownStorage.available, false);
  assert.match(unknownStorage.reasons.join(' '), /storage capacity/);
});
