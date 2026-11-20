import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admission, disclosure, newcomerGrant, freezeReviewBatch, reviewDisposition, REVIEW_LIMITS } from './agreed-contracts.mjs';

const memberRequest = roster => ({ roster, approvals: [], parent: 'head-1', proposalParent: 'head-1',
  parentPolicy: { kind: 'allMinusOne' } });
const payload = () => ({ action: 'aiProcess', actor: 'ana', owner: 'ana', scope: 'sharedCooking', readable: true,
  destination: 'external', provider: 'provider-a', purpose: 'meal-advice', contentHash: 'payload-1',
  policyHash: 'policy-1', policyState: 'accepted', mode: 'preference', permitted: false, override: null });
const overrideFor = r => Object.fromEntries(['action', 'actor', 'contentHash', 'provider', 'purpose', 'policyHash', 'destination']
  .map(key => [key, r[key]]));
const grant = () => ({ membership: 'approved', delegation: 'currentCooking', material: 'freshProjection',
  classes: ['recipe', 'pantry', 'shopping'], newDocument: true, freshKey: true });
const change = (id, authorDevice, dependencies = []) => ({ id, authorDevice, dependencies, measuredBytes: 100 });
const review = () => ({ id: 'review-1', checkpoint: 'checkpoint-1', suspectDevice: 'ana-phone',
  trustedBase: ['checkpoint-item'], changes: [change('honest', 'ben-phone', ['checkpoint-item']),
    change('bad', 'ana-phone'), change('dependent', 'ben-phone', ['bad']),
    change('descendant', 'chi-phone', ['dependent'])] });

test('all-minus-one uses the existing roster, including one-of-two admission', () => {
  for (const [roster, threshold] of [[['a'], 1], [['a', 'b'], 1], [['a', 'b', 'c'], 2], [['a', 'b', 'c', 'd'], 3]]) {
    const r = memberRequest(roster);
    assert.equal(admission(r).threshold, threshold);
    assert.equal(admission(r).result, 'Pending');
    r.approvals = roster.slice(0, threshold);
    assert.equal(admission(r).result, 'Allow');
  }
});

test('unanimity and fixed thresholds count distinct existing adults', () => {
  const r = memberRequest(['a', 'b', 'c']);
  r.parentPolicy = { kind: 'unanimous' }; r.approvals = ['a', 'b', 'b'];
  assert.equal(admission(r).result, 'Pending');
  r.parentPolicy = { kind: 'fixed', threshold: 2 };
  assert.equal(admission(r).result, 'Allow');
  r.approvals = ['a', 'a'];
  assert.equal(admission(r).result, 'Pending');
  r.approvals.push('newcomer');
  assert.equal(admission(r).result, 'Deny');
});

test('parent mismatch, duplicate roster and impossible thresholds cannot authorize a proposal', () => {
  const r = memberRequest(['a', 'b']); r.approvals = ['a']; r.proposalParent = 'other-head';
  assert.equal(admission(r).result, 'Pending');
  r.proposalParent = r.parent; r.parentPolicy = { kind: 'fixed', threshold: 0 };
  assert.equal(admission(r).result, 'Deny');
  r.parentPolicy.threshold = 3;
  assert.equal(admission(r).result, 'Deny');
  r.parentPolicy = { kind: 'allMinusOne' }; r.roster = ['a', 'a'];
  assert.equal(admission(r).result, 'Deny');
});

test('a preference override requires review of this exact payload and records disagreement', () => {
  const r = payload();
  assert.equal(disclosure(r).result, 'RequireReview');
  r.override = overrideFor(r);
  assert.deepEqual(disclosure(r), { result: 'AllowWithOverride', reason: 'DISCLOSED_AGAINST_PREFERENCE',
    disagreement: true, householdConsent: false });
  for (const key of ['actor', 'contentHash', 'provider', 'purpose', 'policyHash', 'destination']) {
    const changed = { ...r, [key]: key === 'destination' ? 'networkLocal' : 'different' };
    assert.equal(disclosure(changed).result, 'RequireReview', key);
  }
});

test('blocking rules, private chats and key releases cannot use the cooking override', () => {
  const r = payload(); r.override = overrideFor(r); r.mode = 'block';
  assert.equal(disclosure(r).result, 'Deny');
  r.mode = 'preference';
  for (const scope of ['secret', 'sharedKey']) assert.equal(disclosure({ ...r, scope }).result, 'Deny');
  assert.equal(disclosure({ ...r, scope: 'private', owner: 'ben', permitted: true }).result, 'Deny');
  assert.equal(disclosure({ ...r, scope: 'private' }).result, 'Deny');
  const otherAction = { ...r, action: 'otherDisclosure' }; otherAction.override = overrideFor(otherAction);
  assert.equal(disclosure(otherAction).result, 'Deny');
  assert.equal(disclosure({ ...r, readable: false, permitted: true }).result, 'Deny');
});

test('only genuinely on-device processing avoids external disclosure rules', () => {
  const r = payload(); r.mode = 'block'; r.policyState = 'unresolved'; r.destination = 'onDevice';
  assert.equal(disclosure(r).reason, 'ON_DEVICE_PROCESSING');
  r.destination = 'networkLocal';
  assert.equal(disclosure(r).result, 'Pending');
  r.policyState = 'accepted';
  assert.equal(disclosure(r).result, 'Deny');
  r.permitted = true;
  assert.equal(disclosure(r).result, 'Allow');
});

test('an exact override cannot bypass unresolved policy', () => {
  const r = payload(); r.override = overrideFor(r); r.policyState = 'unresolved';
  assert.equal(disclosure(r).result, 'Pending');
  assert.equal(disclosure({ ...r, override: [] }).result, 'Deny');
  assert.equal(disclosure({ ...r, readable: 'yes' }).result, 'Deny');
});

test('newcomer current-state delegation grants only fresh cooking documents and keys', () => {
  const r = grant(); assert.equal(newcomerGrant(r).result, 'Allow');
  assert.equal(newcomerGrant({ ...r, membership: 'pending' }).result, 'Pending');
  assert.equal(newcomerGrant({ ...r, delegation: 'none' }).result, 'Pending');
  for (const material of ['historicalSnapshot', 'historicalKey', 'archive']) {
    assert.equal(newcomerGrant({ ...r, material }).result, 'Deny');
  }
  for (const field of ['freshKey', 'newDocument']) assert.equal(newcomerGrant({ ...r, [field]: false }).result, 'Deny');
  for (const kind of ['chat', 'proposal', 'deletedRecipe', 'credentials']) {
    assert.equal(newcomerGrant({ ...r, classes: ['recipe', kind] }).result, 'Deny');
  }
});

test('a frozen review cannot be extended by later submissions or caller mutation', () => {
  const r = review(); const batch = freezeReviewBatch(r);
  assert.equal(batch.result, 'Frozen'); assert.equal(batch.completeness, 'unverified');
  r.changes.push(change('later', 'ana-phone'));
  r.changes[0].dependencies.push('later');
  assert.equal(batch.changes.length, 4); assert.deepEqual(batch.changes[0].dependencies, ['checkpoint-item']);
  assert.equal(reviewDisposition(batch, 'later').reason, 'EXPLICIT_FETCH_REQUIRED');
  assert.throws(() => batch.changes.push(change('another', 'ana-phone')), TypeError);
});

test('review distinguishes suspect authors from honest dependent authors, across reordered delivery', () => {
  const r = review();
  const assertOutcomes = batch => {
    assert.equal(reviewDisposition(batch, 'bad').reason, 'SUSPECT_AUTHOR');
    assert.equal(reviewDisposition(batch, 'dependent').reason, 'DISPUTED_DEPENDENCY');
    assert.equal(reviewDisposition(batch, 'descendant').reason, 'DISPUTED_DEPENDENCY');
    assert.equal(reviewDisposition(batch, 'honest').reason, 'EXPLICIT_SELECTION_STILL_REQUIRED');
    assert.equal(batch.changes.find(c => c.id === 'dependent').authorDevice, 'ben-phone');
  };
  assertOutcomes(freezeReviewBatch(r)); r.changes.reverse(); assertOutcomes(freezeReviewBatch(r));
});

test('unknown and cyclic dependencies stay pending instead of being treated as clean', () => {
  const r = review(); r.changes.push(change('missing', 'ben-phone', ['unknown']),
    change('cycle-a', 'ben-phone', ['cycle-b']), change('cycle-b', 'chi-phone', ['cycle-a']));
  const batch = freezeReviewBatch(r);
  for (const value of ['missing', 'cycle-a', 'cycle-b']) assert.equal(reviewDisposition(batch, value).result, 'Pending');
});

test('review limits bound object count, dependency count, per-object size and total bytes', () => {
  const r = review();
  r.changes = Array.from({ length: REVIEW_LIMITS.objects + 1 }, (_, n) => change(`id-${n}`, 'a'));
  assert.equal(freezeReviewBatch(r).reason, 'BATCH_LIMIT');
  r.changes = [{ ...change('large', 'a'), measuredBytes: REVIEW_LIMITS.objectBytes + 1 }];
  assert.equal(freezeReviewBatch(r).reason, 'BATCH_LIMIT');
  r.changes = [{ ...change('wide', 'a'), dependencies: Array.from({ length: REVIEW_LIMITS.dependencies + 1 }, (_, n) => `dep-${n}`) }];
  assert.equal(freezeReviewBatch(r).reason, 'BATCH_LIMIT');
  r.changes = Array.from({ length: 9 }, (_, n) => ({ ...change(`id-${n}`, 'a'), measuredBytes: REVIEW_LIMITS.objectBytes }));
  assert.equal(freezeReviewBatch(r).reason, 'BATCH_LIMIT');
  r.changes.pop(); assert.equal(freezeReviewBatch(r).result, 'Frozen');
});

test('malformed review sizes, repeated identities and checkpoint identity reuse are rejected', () => {
  const r = review(); r.changes[0].measuredBytes = -1;
  assert.equal(freezeReviewBatch(r).result, 'Deny');
  r.changes[0].measuredBytes = 1; r.changes.push(r.changes[0]);
  assert.equal(freezeReviewBatch(r).result, 'Deny');
  r.changes.pop(); r.changes[0].id = 'checkpoint-item';
  assert.equal(freezeReviewBatch(r).result, 'Deny');
});
