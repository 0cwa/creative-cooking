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

test('storage operations validate multi-document identity and compare the entire ordered input', async () => {
  const { storageOperationKey, STORAGE_LIMITS } = await import('./index.ts');
  const op = { scopeId:'scope', operationId:'op', documents:[{documentId:'a',bytes:new Uint8Array([1]),expectedRevision:null},{documentId:'b',bytes:new Uint8Array([2]),expectedRevision:0}], commands:[{version:1,commandId:'c',effectId:'e',documentId:'a',kind:'chef',payload:new Uint8Array([3]),dependencyEffectIds:[]}], outbound:[{object:{id:'o',bytes:new Uint8Array([4])},branchHead:'h',epochId:'epoch'}] };
  const key = storageOperationKey(op,'local'); assert.equal(key.ok,true);
  assert.equal(storageOperationKey(structuredClone(op),'local').value,key.value);
  assert.notEqual(storageOperationKey({...op,scopeId:'other'},'local').value,key.value);
  assert.notEqual(storageOperationKey({...op,outbound:[{...op.outbound[0],object:{id:'o',bytes:new Uint8Array([5])}}]},'local').value,key.value);
  assert.equal(storageOperationKey({...op,documents:[op.documents[0],op.documents[0]]},'local').error,'MALFORMED');
  assert.equal(storageOperationKey({...op,documents:[op.documents[1],op.documents[0]]},'local').error,'MALFORMED');
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER, undefined]) assert.equal(storageOperationKey({...op,documents:[{...op.documents[0],expectedRevision:revision}]},'local').error,'MALFORMED');
  assert.equal(storageOperationKey({...op,documents:[{...op.documents[0],bytes:[1]}]},'local').error,'MALFORMED');
  assert.equal(storageOperationKey({...op,documents:[{...op.documents[0],bytes:new Uint8Array(STORAGE_LIMITS.itemBytes+1)}]},'local').error,'TOO_LARGE');
  assert.equal(storageOperationKey({...op,commands:[op.commands[0],op.commands[0]]},'local').error,'MALFORMED');
  const imp = {scopeId:'scope',operationId:'import',itemId:'in',documents:op.documents,effectIds:['e']};
  assert.equal(storageOperationKey(imp,'import').ok,true);
  assert.equal(storageOperationKey({...imp,effectIds:['e','e']},'import').error,'MALFORMED');
});

test('receipt and cursor validation preserve distinct states and opaque cursors', async () => {
  const { validateStorageReceipt, validateInboxItem } = await import('./index.ts');
  const r = {scopeId:'s',objectId:'o',receiptId:'r',destination:'relay',recipientId:'relay',state:'stored',bytes:new Uint8Array([1])};
  assert.equal(validateStorageReceipt(r).ok,true);
  assert.equal(validateStorageReceipt({...r,state:'applied'}).error,'MALFORMED');
  assert.equal(validateStorageReceipt({...r,destination:'peer',state:'applied'}).ok,true);
  const item = {scopeId:'s',object:{id:'o',bytes:new Uint8Array([1])},source:'p',expectedCursor:'z',cursor:'a'};
  assert.equal(validateInboxItem(item).ok,true);
  assert.equal(validateInboxItem({...item,expectedCursor:null}).ok,true);
  assert.equal(validateInboxItem({...item,cursor:4}).error,'MALFORMED');
});
