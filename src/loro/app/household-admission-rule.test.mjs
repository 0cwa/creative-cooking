import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import sodium from 'libsodium-wrappers';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {initializeAuthority, policyId, readAuthority, rootPin, selectHead, resolveRuntimeAuthority} from '../authority/chain.mjs';
import {domain, validateSuccessor} from '../authority/validator.mjs';
import {prepareHouseholdInvite} from './household-invite.mjs';
import {approveHouseholdAdmissionRule, householdAdmissionRule, proposeHouseholdAdmissionRule, retainHouseholdAdmissionRule, reviewHouseholdAdmissionRule} from './household-admission-rule.mjs';

await sodium.ready;

test('policy approval uses the selected frozen electorate and retains independently signed siblings', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    const storage = openSQLiteStorage({executeSync(sql, params = []) {
      const query = database.prepare(sql);
      return {rows: sql.startsWith('SELECT') ? query.all(...params) : (query.run(...params), [])};
    }});
    const keys = Object.fromEntries(['a1', 'a2', 'b1'].map(device => [device, sodium.crypto_sign_keypair()]));
    const sign = (device, message) => sodium.crypto_sign_detached(message, keys[device].privateKey);
    const provider = {
      hash: async message => sodium.crypto_generichash(32, message),
      verify: async (device, message, signature) => !!keys[device] && sodium.crypto_sign_verify_detached(signature, message, keys[device].publicKey)
    };
    const policy = {kind:'unanimous', fixedCount:null};
    const scope = {kind:'household', id:'household'};
    const root = {
      householdId: scope.id, head:'', policyHash: await policyId(provider, policy), generation:1, epochId:'epoch',
      roster:['a', 'b'], devices: Object.keys(keys).map(deviceId => ({deviceId, adultId:deviceId[0], active:true, signingKeyRef:deviceId})),
      policy, runtime:{documentId:'doc', authorPeers:{a1:'1', a2:'2', b1:'3'}, acceptedRecipients:Object.keys(keys)}
    };
    root.head = await rootPin(provider, root);
    await initializeAuthority(storage, root, root.head, provider);
    const drafts = new Map();
    const member = deviceId => ({storage, scope, pin:root.head, deviceId, adultId:deviceId[0], randomUUID,
      store:{transaction: fn => fn({get:key => drafts.get(key), put:(key, value) => drafts.set(key, value)})},
      provider:{...provider, sign: async (key, message) => {
        assert.equal(key, deviceId);
        return sign(deviceId, message);
      }}});
    // Use each device's local store facade over retained draft IDs.
    for (const device of Object.keys(keys)) assert.equal((await householdAdmissionRule(member(device))).required, 2);
    const a = member('a1'), a2 = member('a2'), b = member('b1');
    const applicant = {version:1, adultId:'c', deviceId:'c1',
      signingKey:sodium.to_hex(sodium.crypto_sign_keypair().publicKey),
      wrappingKey:sodium.to_hex(sodium.crypto_box_keypair().publicKey)};
    const invitation = () => prepareHouseholdInvite({...a, sodium, recipient:applicant, explicit:true});
    const propose = (policy, expectedHead = root.head) => proposeHouseholdAdmissionRule({...a, policy, expectedHead, explicit:true});
    const approve = (member, item, confirmedEventHash) => approveHouseholdAdmissionRule({...member, item, confirmedEventHash, explicit:true});
    const retain = (member, reviewed) => retainHouseholdAdmissionRule({...member, item:reviewed.item, confirmedEventHash:reviewed.eventHash, explicit:true});
    const next = {kind:'allMinusOne', fixedCount:null};
    const before = await invitation();
    assert.equal(before.requiredApprovals, 2);
    assert.equal((await validateSuccessor(root, before.item.event, before.item.authorSignature, before.item.approvals, provider)).reason, 'QUORUM_REQUIRED');
    await assert.rejects(propose({kind:'fixed', fixedCount:3}), /between 1 and 2/);
    await assert.rejects(propose(next, 'stale'), /CONFLICT/);
    const initial = await propose(next);
    assert.deepEqual(await propose(next), initial);
    const review = await reviewHouseholdAdmissionRule({...b, item:initial});
    assert.equal(review.approvals, 0);
    assert.equal(review.required, 2);
    const first = await approve(a, initial, review.eventHash);
    assert.deepEqual(await approve(a, initial, review.eventHash), first);
    await assert.rejects(approve(b, first.item, 'stale'), /REVIEW_CHANGED/);
    await assert.rejects(retain(a, first), /QUORUM_REQUIRED/);
    await assert.rejects(approve(a2, first.item, first.eventHash), /already approved/);
    const secondDevice = await approve(a2, initial, first.eventHash);
    const duplicateAdult = {...first.item, approvals:[...first.item.approvals, ...secondDevice.item.approvals]};
    assert.equal((await reviewHouseholdAdmissionRule({...b, item:duplicateAdult})).approvals, 1);
    const complete = await approve(b, first.item, first.eventHash);
    assert.equal(complete.approvals, 2);
    const saves = await Promise.all([retain(a, complete), retain(a, complete)]);
    assert.deepEqual(saves.map(save => save.replayed).sort(), [false, true]);
    assert.equal((await readAuthority(storage, scope, root.head, provider)).revision, 1);

    const competing = await propose({kind:'fixed', fixedCount:2});
    const other = await reviewHouseholdAdmissionRule({...a, item:competing});
    const otherFirst = await approve(a, competing, other.eventHash);
    const otherComplete = await approve(b, otherFirst.item, otherFirst.eventHash);
    assert.equal((await retain(b, otherComplete)).replayed, false);
    const status = await householdAdmissionRule(b);
    assert.equal(status.head, root.head);
    assert.deepEqual(status.policy, policy);
    assert.deepEqual(status.successors.map(({parentHead}) => parentHead), [root.head, root.head]);

    const selection = {from:root.head, to:complete.eventHash, deviceId:a.deviceId, index:0};
    const signature = sodium.to_hex(sign(a.deviceId, domain('select-head', {root:root.head, householdId:scope.id, ...selection})));
    await selectHead(storage, scope, root.head, provider, {...selection, signature});
    const selected = await householdAdmissionRule(b);
    assert.equal(selected.required, 1);
    assert.deepEqual(selected.policy, next);
    const after = await invitation();
    assert.equal(after.requiredApprovals, 1);
    assert.equal(after.item.approvals.length, 1);
    assert.equal(selected.head, after.item.event.parentHead);
    assert.equal((await resolveRuntimeAuthority(storage, scope, root.head, provider, b.deviceId)).scope.documentId, root.runtime.documentId);
    await assert.rejects(approve(b, first.item, first.eventHash), /different household head/);
    const successor = await proposeHouseholdAdmissionRule({...a, policy, expectedHead:selected.head, explicit:true});
    const successorReview = await reviewHouseholdAdmissionRule({...a, item:successor});
    assert.equal((await validateSuccessor(successorReview.parent, after.item.event, after.item.authorSignature, after.item.approvals, provider)).reason, 'ADMISSION_AND_PROJECTION_REQUIRED');
    assert.equal((await approve(a, successor, successorReview.eventHash)).complete, true);

    const changed = structuredClone(complete.item);
    changed.event.nextPolicy = policy;
    assert.equal((await validateSuccessor(root, changed.event, changed.authorSignature, changed.approvals, provider)).reason,'INVALID_PROOF');
  } finally {database.close()}
});
