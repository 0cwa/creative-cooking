import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_FRAME_BYTES, REVIEW_LIMITS, validateFrame, validateReviewBatch, validateGuardianPackage } from './index.ts';
import { fixtureFrame, fixtureObject } from './fixtures.ts';

test('frame limits and structure do not authenticate claimed identity or hash', () => {
  assert.equal(validateFrame(fixtureFrame, 100, INITIAL_FRAME_BYTES).ok, true);
  assert.equal(validateFrame(fixtureFrame, INITIAL_FRAME_BYTES + 1, INITIAL_FRAME_BYTES).error, 'TOO_LARGE');
  assert.equal(validateFrame(fixtureFrame, 100, 99).error, 'TOO_LARGE');
  assert.equal(validateFrame({ ...fixtureFrame, version: 2 }, 100, 100).error, 'UNSUPPORTED_VERSION');
  assert.equal(validateFrame({ ...fixtureFrame, chunkIndex: 1 }, 100, 100).error, 'MALFORMED');
  assert.equal(validateFrame({ ...fixtureFrame, extra: true }, 100, 100).error, 'MALFORMED');
});
test('review budgets use actual bytes and reject duplicate identities', () => {
  assert.equal(validateReviewBatch([fixtureObject], [64]).ok, true);
  assert.equal(validateReviewBatch([fixtureObject, fixtureObject], []).error, 'DUPLICATE');
  assert.equal(validateReviewBatch([{ id: 'large', bytes: new Uint8Array(REVIEW_LIMITS.objectBytes + 1) }], []).error, 'TOO_LARGE');
  assert.equal(validateReviewBatch([], [65]).error, 'TOO_LARGE');
  assert.equal(validateReviewBatch(Array.from({ length: 9 }, (_, i) => ({ id: String(i), bytes: new Uint8Array(REVIEW_LIMITS.objectBytes) })), []).error, 'TOO_LARGE');
});
test('guardian thresholds count distinct holders and shared packages need a grant', () => {
  const p = { version: 1, owner: 'a', scope: 'personal', packageGeneration: 1, guardianRoster: ['a', 'b'], threshold: 2, encryptedCatalogRef: 'c', sharedGrantRef: null, approvalRefs: [] };
  assert.equal(validateGuardianPackage(p).ok, true);
  assert.equal(validateGuardianPackage({ ...p, guardianRoster: ['a', 'a'] }).error, 'MALFORMED');
  assert.equal(validateGuardianPackage({ ...p, threshold: 3 }).error, 'MALFORMED');
  assert.equal(validateGuardianPackage({ ...p, scope: 'shared' }).error, 'MALFORMED');
});

test('guardian untrusted records reject missing and unknown fields', () => {
  assert.equal(validateGuardianPackage(null).error, 'MALFORMED');
  assert.equal(validateGuardianPackage({ version: 1 }).error, 'MALFORMED');
  const p = { version: 1, owner: 'a', scope: 'personal', packageGeneration: 1, guardianRoster: ['b'], threshold: 1, encryptedCatalogRef: 'c', sharedGrantRef: null, approvalRefs: [], extra: true };
  assert.equal(validateGuardianPackage(p).error, 'MALFORMED');
});
