import {writeFixtureSelection} from '../authority/chain-test-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import sodium from 'libsodium-wrappers';
import {LoroDoc, decodeImportBlobMeta} from 'loro-crdt';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {checkoutPolicyHead, initializeAuthority, policyId, readAuthority, rootPin, resolveRuntimeAuthority} from '../authority/chain.mjs';
import {domain, validateSuccessor} from '../authority/validator.mjs';
import {prepareHouseholdInvite} from './household-invite.mjs';
import {approveHouseholdAdmissionRule, householdAdmissionRule, proposeHouseholdAdmissionRule, retainHouseholdAdmissionRule, reviewHouseholdAdmissionRule} from './household-admission-rule.mjs';
import {policyBaseline, recoverPolicyBaseline} from '../authority/policy-baseline.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {testProvider} from '../crypto/test-provider.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {commitCookingWithPolicy} from '../disclosure/cooking.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {acceptInitialPolicy, prepareInitialPolicy} from '../disclosure/setup.mjs';
import {createSourceVerifier} from '../disclosure/source-proof.mjs';
import {cookingFiles} from './cooking-file.mjs';
import {evidenceSha256, manifestDigest, reportMessage} from '../compromise/report.mjs';
import {householdCompromise} from './household-compromise.mjs';

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
      runtime:{scope:{branchHead:root.head},document:async()=>({doc:new LoroDoc()})},
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

    await checkoutPolicyHead({...a, LoroDoc, expectedHead:status.head, expectedRevision:status.revision, targetHead:complete.eventHash, explicit:true});
    const afterSelection = await readAuthority(storage, scope, root.head, provider);
    assert.deepEqual(await retain(a, complete), {eventHash:complete.eventHash, replayed:true});
    assert.deepEqual(await readAuthority(storage, scope, root.head, provider), afterSelection);
    const variant = {...complete, item:{...complete.item,
      approvals:[secondDevice.item.approvals[0], complete.item.approvals.find(approval=>approval.adultId===b.adultId)]}};
    await assert.rejects(retain(a, variant), /CONFLICT/);
    await assert.rejects(reviewHouseholdAdmissionRule({...a, item:complete.item}), /different household head/);
    const selected = await householdAdmissionRule(b);
    assert.equal(selected.required, 1);
    assert.deepEqual(selected.policy, next);
    const after = await invitation();
    assert.equal(after.requiredApprovals, 1);
    assert.equal(after.item.approvals.length, 1);
    assert.equal(selected.head, after.item.event.parentHead);
    assert.equal((await resolveRuntimeAuthority(storage, scope, root.head, provider, b.deviceId)).scope.documentId, `policy-${complete.eventHash}`);
    await assert.rejects(approve(b, first.item, first.eventHash), /different household head/);
    const successor = await proposeHouseholdAdmissionRule({...a, runtime:{...a.runtime,scope:{branchHead:selected.head}}, policy, expectedHead:selected.head, explicit:true});
    const successorReview = await reviewHouseholdAdmissionRule({...a, item:successor});
    assert.equal((await validateSuccessor(successorReview.parent, after.item.event, after.item.authorSignature, after.item.approvals, provider)).reason, 'ADMISSION_AND_PROJECTION_REQUIRED');
    assert.equal((await approve(a, successor, successorReview.eventHash)).complete, true);

    const changed = structuredClone(complete.item);
    changed.event.nextPolicy = policy;
    assert.equal((await validateSuccessor(root, changed.event, changed.authorSignature, changed.approvals, provider)).reason,'INVALID_PROOF');
  } finally {database.close()}
});

test('the signed frontier commits to the same causal history across import order and later edits', async () => {
  const provider = {hash: async message => sodium.crypto_generichash(32, message)};
  const write = (peer, value) => {
    const doc = new LoroDoc();
    doc.setPeerId(peer);
    doc.getMap('pantry').set(peer, value);
    return doc.export({mode:'snapshot'});
  };
  const [mint, thyme, extra] = [write('1','mint'), write('2','thyme'), write('3','fennel')];
  const proposer = new LoroDoc();
  proposer.import(mint);
  proposer.import(thyme);
  const baseline = await policyBaseline(proposer, provider);

  const recipient = new LoroDoc();
  recipient.import(thyme);
  await assert.rejects(recoverPolicyBaseline(LoroDoc, {bytes:recipient.export({mode:'snapshot'})}, baseline, provider), /POLICY_BASELINE_UNAVAILABLE/);
  recipient.import(mint);
  assert.deepEqual(await policyBaseline(recipient, provider), baseline);
  recipient.import(extra);
  recipient.setPeerId('1');
  recipient.getMap('pantry').set('1','later change at the same peer');
  const restored = new LoroDoc();
  restored.import(await recoverPolicyBaseline(LoroDoc, {bytes:recipient.export({mode:'snapshot'})}, baseline, provider));
  assert.deepEqual(restored.getMap('pantry').toJSON(), {1:'mint',2:'thyme'});
  assert.deepEqual(await policyBaseline(restored, provider), baseline);
  const conflicting = new LoroDoc();
  conflicting.import(thyme);
  conflicting.import(write('1','different operation at the same counter'));
  await assert.rejects(recoverPolicyBaseline(LoroDoc, {bytes:conflicting.export({mode:'snapshot'})}, baseline, provider), /POLICY_BASELINE_UNAVAILABLE/);
});

test('checkout verifies inherited source envelopes only inside the signed causal boundary', async () => {
  const database = new DatabaseSync(':memory:');
  const signing = sodium.crypto_sign_keypair(), data = sodium.randombytes_buf(32);
  try {
    const provider = testProvider(sodium, {signing, publicSigning:signing.publicKey, initialKey:data});
    const codec = candidateCodec(provider);
    const storage = openSQLiteStorage({executeSync(sql, params = []) {
      const query = database.prepare(sql);
      return {rows: sql.startsWith('SELECT') ? query.all(...params) : (query.run(...params), [])};
    }});
    const deviceId = 'sender', adultId = 'adult', scope = {kind:'household', id:'household'};
    const policy = {kind:'unanimous', fixedCount:null};
    const root = {householdId:scope.id, head:'', policyHash:await policyId(provider,policy), generation:1, epochId:'epoch',
      policy, roster:[adultId], devices:[{adultId,deviceId,active:true,signingKeyRef:deviceId},
        {adultId,deviceId:'peer',active:true,signingKeyRef:'peer'}],
      runtime:{documentId:'doc',authorPeers:{[deviceId]:'1',peer:'2'},acceptedRecipients:['peer',deviceId].sort()}};
    const pin = root.head = await rootPin(provider, root);
    await initializeAuthority(storage, root, pin, provider);
    const member = {storage, scope, pin, provider, deviceId, adultId};
    const service = disclosureService({...member,rootPin:pin});
    const open = async () => {
      const {scope:resolved,selectionIndex} = await resolveRuntimeAuthority(storage,scope,pin,provider,deviceId);
      return new OfflineRuntime({storage,codec,LoroDoc,decodeImportBlobMeta,scope:resolved,keyRef:'data',authority:{rootPin:pin,provider,selectionIndex}});
    };
    const parent = await open();
    const disclosure = await prepareInitialPolicy({service});
    const accepted = await acceptInitialPolicy({service,provider,deviceId,policy:disclosure,explicit:true});
    const at = '2026-01-01T00:00:00Z';
    const create = (id, sequence) => ({operationId:id, deviceSequence:sequence,
      command:{version:1,kind:'pantry-create',commandId:id,effectId:id,dependencyEffectIds:[],data:{itemId:id,name:id,preference:3,author:deviceId,at}}});
    await parent.execute(create('legacy',1));
    await commitCookingWithPolicy({runtime:parent,service,input:create('inside',2)});
    const drafts = new Map();
    const proposalInputs = {...member,runtime:parent,expectedHead:pin,
      store:{transaction:fn=>fn({get:key=>drafts.get(key),put:(key,value)=>drafts.set(key,value)})},
      randomUUID,policy:{kind:'allMinusOne',fixedCount:null},explicit:true};
    const approveAndRetain = async item => {
      const reviewed = await reviewHouseholdAdmissionRule({...member,item});
      const approved = await approveHouseholdAdmissionRule({...member,item,confirmedEventHash:reviewed.eventHash,explicit:true});
      return retainHouseholdAdmissionRule({...member,item:approved.item,confirmedEventHash:approved.eventHash,explicit:true});
    };
    const proposed = await proposeHouseholdAdmissionRule(proposalInputs);
    const approved = await approveAndRetain(proposed);
    const sibling = await approveAndRetain(await proposeHouseholdAdmissionRule({...proposalInputs,policy:{kind:'fixed',fixedCount:1}}));
    const event = {...proposed.event,version:1,subject:null,proposalId:'legacy-proposal'};
    const historical = await approveAndRetain({event,authorSignature:sodium.to_hex(await provider.sign(deviceId,domain('event-signature',event))),approvals:[]});
    await commitCookingWithPolicy({runtime:parent,service,input:create('outside',3)});
    const duplicate = create('post-cutoff',6);
    duplicate.command.effectId = 'inside';
    const laterDuplicate = (await parent.prepare(duplicate)).commit.outbound[0].object;
    const laterHistory=await parent.document();
    const outsideEnvelope=(await storage.readDisclosureSource(scope.id,'outside')).value.envelope;
    const status = await householdAdmissionRule(member);
    assert.equal(status.successors.find(item=>item.eventHash===historical.eventHash).legacy,true);
    assert.equal(status.checkout.some(item=>item.head===historical.eventHash),false);
    await assert.rejects(checkoutPolicyHead({...member,LoroDoc,expectedHead:pin,expectedRevision:status.revision,targetHead:historical.eventHash,explicit:true}), /INVALID_POLICY_CHECKOUT/);
    const cursors=await storage.listCursors(scope.id),inbox=await storage.listStagedInbox(scope.id);
    const listCursors=storage.listCursors;
    storage.listCursors=async function(...args){
      await checkoutPolicyHead({...member,LoroDoc,expectedHead:pin,expectedRevision:status.revision,targetHead:approved.eventHash,explicit:true});
      return listCursors.call(this,...args);
    };
    try {
      await assert.rejects(cookingFiles({runtime:parent,service}).receive(outsideEnvelope),/CONFLICT/);
    } finally { storage.listCursors=listCursors; }
    assert.deepEqual(await storage.listCursors(scope.id),cursors);
    assert.deepEqual(await storage.listStagedInbox(scope.id),inbox);
    const branch = await open();
    const reviews = storage.compromise;
    const originals = (await storage.listOutboundObjects(scope.id)).value;
    const evidence = [...originals, {objectId:laterDuplicate.id,bytes:laterDuplicate.bytes}]
      .map(({objectId,bytes})=>({sourceId:'outbound',objectId,bytes}));
    const checkpoint = new Uint8Array(), checkpointHash = await evidenceSha256(checkpoint);
    const reportId = randomUUID();
    const manifest = await Promise.all(evidence.map(async ({sourceId,objectId,bytes})=>
      ({sourceId,objectId,bytes:bytes.length,hash:await evidenceSha256(bytes)})));
    const authority = await branch.authorize();
    const reportContext = {kind:scope.kind,scopeId:scope.id,authorityHead:authority.record.acceptedParent,
      authorityRevision:authority.record.revision,authoritySnapshot:authority.record.authorizationSnapshot,checkpointHash};
    const payload = {version:1,reportId,reviewId:reportId,scopeId:scope.id,scopeKind:scope.kind,head:branch.scope.branchHead,
      reporterDevice:deviceId,suspectDeviceIds:['peer'],checkpointHash,manifestHash:await manifestDigest(manifest),
      boundary:{kind:'operation',ref:originals.find(entry=>
        JSON.parse(new TextDecoder().decode(entry.bytes)).header.semanticEffectIds[0]==='inside').objectId}};
    const report = {payload,signature:sodium.to_hex(await provider.sign(deviceId,reportMessage(payload)))};
    await reviews.freeze({reviewId:reportId,context:reportContext,report,runtime:branch,objects:evidence,
      checkpointBytes:checkpoint,isolated:true,requireStored:false});
    const reports = householdCompromise({runtime:branch,withCurrent:use=>use(0)});
    const opened = await reports.open();
    const view = await reports.inspect(opened.confirmation,reportId);
    assert.equal(view.canSave,true);
    assert.equal(view.rows.find(row=>row.objectId===payload.boundary.ref).selectable,true);
    const outside = view.rows.find(row=>row.objectId===laterDuplicate.id);
    assert.equal(outside.category,'outside');
    assert.equal(outside.selectable,false);
    const {draft} = await reports.saveCleanDraft(view,['legacy','inside']);
    assert.deepEqual(draft.included.map(entry=>entry.effectId),['legacy','inside']);
    assert.deepEqual(draft.held.map(({objectId,reason})=>[objectId,reason]).sort(),
      [[originals.find(entry=>Buffer.from(entry.bytes).equals(outsideEnvelope)).objectId,'OUTSIDE_POLICY_FRONTIER'],
        [laterDuplicate.id,'OUTSIDE_POLICY_FRONTIER']].sort());
    // On this branch, the new change can claim the same Loro peer counters
    // as the later change retained on the parent.
    await commitCookingWithPolicy({runtime:branch,service,input:create('branch-own',4)});
    const context = await service.authority();
    const repeatedHistory=Object.create(branch);
    repeatedHistory.document=async()=>laterHistory;
    await assert.rejects(createSourceVerifier({runtime:repeatedHistory,service,context,allowIncomplete:true})('outside'), /INVALID_SOURCE_PROOF|SOURCE_PROVENANCE_REQUIRED/);
    const verify = createSourceVerifier({runtime:branch,service,context,allowIncomplete:true});
    assert.deepEqual((await verify('inside')).policies,[accepted.policyHash]);
    assert.equal((await verify('legacy')).incomplete,true);
    await assert.rejects(verify('outside'), /INVALID_SOURCE_PROOF|SOURCE_PROVENANCE_REQUIRED/);
    await assert.rejects(createSourceVerifier({runtime:branch,service,context})('legacy'), /SOURCE_PROVENANCE_REQUIRED/);
    await assert.rejects(createSourceVerifier({runtime:branch,service,context})('branch-own'), /INCOMPLETE_PROVENANCE/);
    const forged = create('bad-dependency',5);
    forged.command.dependencyEffectIds = ['outside'];
    await assert.rejects(commitCookingWithPolicy({runtime:branch,service,input:forged}), /INVALID_SOURCE_PROOF|SOURCE_PROVENANCE_REQUIRED/);
    assert.equal((await storage.getLocalOperation(scope.id,'bad-dependency')).value,null);

    const back = await householdAdmissionRule(member);
    await checkoutPolicyHead({...member,LoroDoc,expectedHead:back.head,expectedRevision:back.revision,targetHead:pin,explicit:true});
    assert.equal((await service.active()).record.policyHash,accepted.policyHash);
    await assert.rejects(parent.document(), /INVALID_AUTHORITY/);
    assert.ok((await (await open()).document()).doc.getMap('domain-effects').get('outside'));

    const selection = {from:pin,to:sibling.eventHash,deviceId,index:2};
    const signature = sodium.to_hex(await provider.sign(deviceId,domain('select-head',{root:pin,householdId:scope.id,...selection})));
    assert.equal((await import('../authority/chain.mjs')).selectHead,undefined);
    await writeFixtureSelection(storage,scope,pin,provider,{...selection,signature});
    const unprepared = await open();
    await assert.rejects(unprepared.document(), /CHECKOUT_REQUIRED/);
    await assert.rejects(unprepared.execute(create('unprepared',6)), /CHECKOUT_REQUIRED/);
    assert.equal((await storage.getLocalOperation(scope.id,'unprepared')).value,null);
  } finally {
    signing.privateKey.fill(0);
    data.fill(0);
    database.close();
  }
});
