import {observeSuccessorWithOutcome, policyCheckoutCandidates, readAuthority, verifyAuthority} from '../authority/chain.mjs';
import {admissionThreshold, domain, validPolicyBaseline, validateSuccessor} from '../authority/validator.mjs';
import {policyBaseline} from '../authority/policy-baseline.mjs';
import {requireAdmissionPolicy} from './admission-rule.mjs';

const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const ordered = approvals => [...approvals].sort((a,b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);

async function context({storage, scope, pin, provider, adultId, deviceId}) {
  const {state, activeHead, revision} = await readAuthority(storage, scope, pin, provider);
  const verified = await verifyAuthority(state, pin, provider);
  const {nodes} = verified;
  const parent = nodes.get(activeHead);
  const device = parent.devices.find(d => d.active && d.adultId === adultId && d.deviceId === deviceId);
  if (!device) throw Error('INVALID_AUTHORITY');
  return {...verified, revision, parent, device};
}

export async function householdAdmissionRule(args) {
  const current = await context(args);
  const {state, parent, revision, legacyPolicyHeads} = current;
  const checkout = policyCheckoutCandidates(current).map(node => ({head:node.head, policy:node.policy}));
  const successors = [];
  for (const item of state.events) {
    if (item.event.kind !== 'changePolicy') continue;
    const eventHash = hex(await args.provider.hash(domain('event', item.event)));
    successors.push({eventHash, parentHead: item.event.parentHead, policy: item.event.nextPolicy, legacy:legacyPolicyHeads.has(eventHash),
      adultCount: item.event.frozenAdultRoster.length});
  }
  return {head: parent.head, revision, policy: parent.policy, required: admissionThreshold(parent.policy, parent.roster.length),
    electorate: parent.roster, successors, checkout};
}

export async function proposeHouseholdAdmissionRule(args) {
  const {provider, store, runtime, expectedHead, explicit, randomUUID} = args;
  const requested = structuredClone(args.policy);
  if (explicit !== true) throw Error('CONFIRMATION_REQUIRED');
  const {parent, device, legacyPolicyHeads} = await context(args);
  if (expectedHead !== parent.head || runtime.scope.branchHead !== expectedHead) throw Error('CONFLICT');
  if (legacyPolicyHeads.has(parent.head)) throw Error('CHECKOUT_REQUIRED');
  const policy = requireAdmissionPolicy(requested, parent.roster.length);
  if (policy.kind === parent.policy.kind && policy.fixedCount === parent.policy.fixedCount) throw Error('Choose a different admission rule.');
  const {doc} = await runtime.document();
  const subject = await policyBaseline(doc, provider);
  if (!validPolicyBaseline(subject)) throw Error('This cooking starting point exceeds the supported frontier size.');
  const slot = JSON.stringify(['household-admission-rule', parent.head, device.deviceId, policy.kind, policy.fixedCount, subject.historyHash]);
  const proposalId = await store.transaction(tx => {
    const retained = tx.get(slot);
    if (retained !== undefined) return retained;
    const id = randomUUID();
    tx.put(slot, id);
    return id;
  });
  const event = {version: 3, suiteId: 'candidate-ed25519-xchacha20-sealedbox-v1',
    householdId: parent.householdId, parentHead: parent.head, policyHash: parent.policyHash,
    generation: parent.generation, epochId: parent.epochId, proposalId, kind: 'changePolicy',
    authorDeviceId: device.deviceId, frozenAdultRoster: parent.roster, subject, nextPolicy: policy};
  const authorSignature = hex(await provider.sign(device.signingKeyRef, domain('event-signature', event)));
  return {event, authorSignature, approvals: []};
}

async function verifyRuleProposal(args, allowHistoricalParent) {
  const item = structuredClone(args.item);
  const {parent: activeParent, nodes} = await context(args);
  if (item?.event?.kind !== 'changePolicy' || Object.keys(item).sort().join(',') !== 'approvals,authorSignature,event') throw Error('INVALID_INPUT');
  const parent = allowHistoricalParent ? nodes.get(item.event.parentHead) : activeParent;
  if (!parent || item.event.parentHead !== parent.head) throw Error('The proposal uses a different household head.');
  const check = await validateSuccessor(parent, item.event, item.authorSignature, item.approvals, args.provider);
  if (check.status !== 'validated' && check.reason !== 'QUORUM_REQUIRED') throw Error(check.reason);
  return {item, parent, eventHash: check.eventHash, approvals: check.approvals, required: check.required,
    canApprove: !item.approvals.some(approval => approval.adultId === args.adultId),
    complete: check.status === 'validated'};
}

export function reviewHouseholdAdmissionRule(args) {
  return verifyRuleProposal(args, false);
}

export async function approveHouseholdAdmissionRule(args) {
  const {provider, adultId, deviceId, explicit, confirmedEventHash} = args;
  if (explicit !== true) throw Error('CONFIRMATION_REQUIRED');
  const {item, parent, eventHash, canApprove} = await reviewHouseholdAdmissionRule(args);
  if (eventHash !== confirmedEventHash) throw Error('REVIEW_CHANGED');
  if (!canApprove) throw Error('This adult already approved the proposal.');
  const device = parent.devices.find(d => d.deviceId === deviceId);
  const approval = {version: 1, householdId: parent.householdId, eventHash, parentHead: parent.head,
    policyHash: parent.policyHash, generation: parent.generation, epochId: parent.epochId, adultId, deviceId};
  const signature = hex(await provider.sign(device.signingKeyRef, domain('approval-signature', approval)));
  return reviewHouseholdAdmissionRule({...args, item: {...item, approvals: ordered([...item.approvals, {...approval, signature}])}});
}

export async function retainHouseholdAdmissionRule(args) {
  const {storage, scope, pin, provider, explicit, confirmedEventHash} = args;
  if (explicit !== true) throw Error('CONFIRMATION_REQUIRED');
  const {item, eventHash, complete} = await verifyRuleProposal(args, true);
  if (eventHash !== confirmedEventHash) throw Error('REVIEW_CHANGED');
  if (!complete) throw Error('QUORUM_REQUIRED');
  return observeSuccessorWithOutcome(storage, scope, pin, provider, {...item, approvals: ordered(item.approvals)}, item.event.parentHead);
}
