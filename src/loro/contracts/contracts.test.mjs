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
  const op = { expectedAuthority:{version:2,scope:{kind:'personal',id:'scope'},record:null}, scopeId:'scope', operationId:'op', documents:[{documentId:'a',bytes:new Uint8Array([1]),expectedRevision:null},{documentId:'b',bytes:new Uint8Array([2]),expectedRevision:0}], commands:[{version:1,commandId:'c',effectId:'e',documentId:'a',kind:'chef',payload:new Uint8Array([3]),dependencyEffectIds:[]}], outbound:[{object:{id:'o',bytes:new Uint8Array([4])},branchHead:'h',epochId:'epoch'}] };
  const key = storageOperationKey(op,'local'); assert.equal(key.ok,true);
  assert.equal(storageOperationKey(structuredClone(op),'local').value,key.value);
  assert.notEqual(storageOperationKey({...op,expectedAuthority:{version:2,scope:{kind:'personal',id:'other'},record:null},scopeId:'other'},'local').value,key.value);
  assert.notEqual(storageOperationKey({...op,outbound:[{...op.outbound[0],object:{id:'o',bytes:new Uint8Array([5])}}]},'local').value,key.value);
  assert.equal(storageOperationKey({...op,documents:[op.documents[0],op.documents[0]]},'local').error,'MALFORMED');
  assert.equal(storageOperationKey({...op,documents:[op.documents[1],op.documents[0]]},'local').error,'MALFORMED');
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER, undefined]) assert.equal(storageOperationKey({...op,documents:[{...op.documents[0],expectedRevision:revision}]},'local').error,'MALFORMED');
  assert.equal(storageOperationKey({...op,documents:[{...op.documents[0],bytes:[1]}]},'local').error,'MALFORMED');
  assert.equal(storageOperationKey({...op,documents:[{...op.documents[0],bytes:new Uint8Array(STORAGE_LIMITS.itemBytes+1)}]},'local').error,'TOO_LARGE');
  assert.equal(storageOperationKey({...op,commands:[op.commands[0],op.commands[0]]},'local').error,'MALFORMED');
  const imp = {version:2,commands:[op.commands[0]],expectedAuthority:{version:2,scope:{kind:'personal',id:'scope'},record:null},scopeId:'scope',operationId:'import',itemId:'in',documents:op.documents,effectIds:['e']};
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

test('atomic group compares personal and household children and rejects partial identities', async () => {
  const { storageGroupKey, classifyStorageGroup, STORAGE_LIMITS } = await import('./index.ts');
  const child = (scope, operation, byte) => ({expectedAuthority:{version:2,scope:{kind:'personal',id:scope},record:null},scopeId:scope,operationId:operation,documents:[{documentId:'doc',expectedRevision:null,bytes:new Uint8Array([byte])}],commands:[{version:1,commandId:'command',effectId:'effect',documentId:'doc',kind:'accept',payload:new Uint8Array([byte]),dependencyEffectIds:[]}],outbound:[{object:{id:'object',bytes:new Uint8Array([byte])},branchHead:'head',epochId:'epoch'}]});
  const group = {groupId:'chef-accept',children:[child('personal','proposal',1),child('household','effect',2)]};
  const result = storageGroupKey(group); assert.equal(result.ok,true);
  assert.equal(storageGroupKey(structuredClone(group)).value,result.value);
  const changed = structuredClone(group); changed.children[1].outbound[0].object.bytes[0] = 3;
  const changedKey = storageGroupKey(changed).value;
  assert.notEqual(changedKey,result.value);
  assert.notEqual(storageGroupKey({...group,children:[...group.children].reverse()}).value,result.value);
  assert.equal(storageGroupKey({...group,children:[group.children[0],group.children[0]]}).error,'MALFORMED');
  assert.equal(storageGroupKey({...group,children:Array.from({length:STORAGE_LIMITS.groups+1},(_,i)=>child(String(i),'op',1))}).error,'TOO_LARGE');
  const large = Array.from({length:9},(_,i) => { const c = child(String(i),'op',1); c.documents[0].bytes = new Uint8Array(STORAGE_LIMITS.itemBytes); return c; });
  assert.equal(storageGroupKey({groupId:'large',children:large}).error,'TOO_LARGE');
  assert.equal(classifyStorageGroup(result.value,null,false),'new');
  assert.equal(classifyStorageGroup(result.value,null,true),'conflict');
  assert.equal(classifyStorageGroup(result.value,result.value,true),'replay');
  assert.equal(classifyStorageGroup(changedKey,result.value,true),'conflict');
});

test('pairing comparison covers complete ceremony, packet and independent guard', async () => {
  const { pairingReleaseKey, classifyPairingRelease, PAIRING_LIMITS } = await import('./pairing.ts');
  const { fixturePairingRelease: p } = await import('./fixtures.ts');
  const k = pairingReleaseKey(p); assert.equal(k.ok,true);
  assert.equal(pairingReleaseKey(structuredClone(p)).value,k.value);
  for (const mutate of [x => x.transcript.signaling.reverse(), x => x.packet.bytes[0]++, x => x.guard.guardId += 'x', x => x.transcript.authorizationSnapshot += 'x', x => x.expectedAuthorityRevision++]) {
    const changed = structuredClone(p); mutate(changed); assert.notEqual(pairingReleaseKey(changed).value,k.value);
  }
  assert.equal(classifyPairingRelease(k.value,k.value,true,true),'replay');
  assert.equal(classifyPairingRelease(k.value,'other',true,true),'conflict');
  assert.equal(classifyPairingRelease(k.value,null,true,false),'conflict');
  assert.equal(classifyPairingRelease(k.value,null,false,true),'conflict');
  assert.equal(classifyPairingRelease(k.value,null,false,false),'new');
  const bad = structuredClone(p); bad.transcript.responder.nonce = bad.transcript.initiator.nonce; assert.equal(pairingReleaseKey(bad).error,'MALFORMED');
  const wrong = structuredClone(p); wrong.guard.scope.id = 'other'; assert.equal(pairingReleaseKey(wrong).error,'MALFORMED');
  const extra = structuredClone(p); extra.transcript.extra = 1; assert.equal(pairingReleaseKey(extra).error,'MALFORMED');
  const large = structuredClone(p); large.packet.bytes = new Uint8Array(PAIRING_LIMITS.itemBytes+1); assert.equal(pairingReleaseKey(large).error,'TOO_LARGE');
  const version = structuredClone(p); version.transcript.version = 2; assert.equal(pairingReleaseKey(version).error,'UNSUPPORTED_VERSION');
});
