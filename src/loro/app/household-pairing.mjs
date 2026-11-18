import {householdRevocation} from './household-revocation.mjs';
import {prepareExistingCeremony,verifyExistingCeremony} from './household-existing-ceremony.mjs';
import {reviewHouseholdGrant,approveHouseholdGrant,collectHouseholdGrantApproval} from './household-grant-review.mjs';
import {verifyHouseholdOffer} from './household-offer.mjs';
import {prepareHouseholdCeremony} from './household-ceremony.mjs';
import {householdTransfer} from './household-transfer.mjs';
import {prepareHouseholdDelegation,acceptHouseholdDelegation} from './household-delegation.mjs';
import {prepareHouseholdGrant} from './household-grant.mjs';
import {prepareHouseholdInvite} from './household-invite.mjs';
import {exportHouseholdParent,acceptHouseholdParent} from './household-parent.mjs';
import {householdSession} from './household-session.ts';
import {reviewHouseholdInvite,approveHouseholdInvite,collectHouseholdInviteApproval} from './household-approval.mjs';
import {householdAdmissionRule,proposeHouseholdAdmissionRule,reviewHouseholdAdmissionRule,approveHouseholdAdmissionRule,retainHouseholdAdmissionRule} from './household-admission-rule.mjs';
import {checkoutPolicyHead} from '../authority/chain.mjs';

/** Both apps use the current workspace identity and the same signed admission flow. */
export function householdPairing({
  name, sodium, storage, master, provider, store, scope, pin, deviceId, adultId,
  runtime, service, pins, keys, signing, wrapping, signingKey, wrappingPublicKey,
  selection, selectedHousehold, LoroDoc, prepareJoinedSequences, finalizeJoinedSequences, randomUUID = () => crypto.randomUUID(), withCurrent = use => use(), sha256 = undefined
}) {
  const active = method => (...args) => {
    // Selection can queue behind a concurrent operation. Capture messages
    // before waiting so callers cannot mutate what is verified or signed.
    const input = structuredClone(args);
    return withCurrent(() => method(...input));
  };
  const authority = {storage, scope, pin, provider};
  const member = {...authority, adultId, deviceId};
  const cooking = {...member, runtime, service};
  const preparation = {...member, store, sodium, randomUUID};
  const identity = {version:1, adultId, deviceId, signingKey, wrappingKey:wrappingPublicKey};
  const withSecrets = fn => keys.use(signing.operationId, signing.identity, signingSecret =>
    keys.use(wrapping.operationId, wrapping.identity, wrappingSecret => fn({signingSecret, wrappingSecret})));
  const transfer = householdTransfer({
    ...authority, name, sodium, master, sessionStore:store, deviceId, runtime, service, keys:pins, LoroDoc,
    withSecrets, prepareJoinedSequences, finalizeJoinedSequences
  });
  const revocation=householdRevocation({...preparation,master,runtime,signingKey,wrappingPublicKey,withSecrets,LoroDoc,sha256});
  const installed = new Set();
  return {
    identity, selection, selectedHousehold,
    revocation:Object.fromEntries(Object.entries(revocation).map(([name,method])=>[name,active(method)])),
    admissionRule: {
      status: active(() => householdAdmissionRule(member)),
      propose: active(input => proposeHouseholdAdmissionRule({...input, ...preparation, runtime})),
      review: active(item => reviewHouseholdAdmissionRule({...member, item})),
      approve: active(input => approveHouseholdAdmissionRule({...input, ...member})),
      retain: active(input => retainHouseholdAdmissionRule({...input, ...member})),
      checkout: active(async input => {
        await runtime.authorize();
        return checkoutPolicyHead({...input, ...member, LoroDoc});
      }),
    },
    transfer:{
      publish:active(transfer.publish),
      seal:active(transfer.seal),
      publishedFiles:active(transfer.publishedFiles),
      installExisting:active(transfer.installExisting),
      completedProof:active(transfer.completedProof),
      async install(input) {
        const result = await active(transfer.install)(input);
        for (const listener of [...installed]) {
          try { void Promise.resolve(listener()).catch(() => {}); }
          catch { /* A failed notification cannot undo an installed household. */ }
        }
        return result;
      }
    },
    onInstalled(listener) {
      installed.add(listener);
      return () => installed.delete(listener);
    },
    prepareExistingCeremony: active(input => prepareExistingCeremony({...input, ...preparation, wrappingPublicKey})),
    verifyExistingCeremony: active(input => verifyExistingCeremony({...input, ...member, sodium, wrappingPublicKey})),
    reviewGrant: active(input => reviewHouseholdGrant({...input, ...cooking})),
    approveGrant: active(input => approveHouseholdGrant({...input, ...cooking})),
    collectGrant: active(input => collectHouseholdGrantApproval({...input, ...cooking})),
    collectInvite: active(input => collectHouseholdInviteApproval({...input, ...member})),
    reviewInvite: active(item => reviewHouseholdInvite({...member, item})),
    approveInvite: active(input => approveHouseholdInvite({...input, ...member})),
    exportParent: active(() => exportHouseholdParent(authority)),
    acceptParent: active(async input => {
      const args = structuredClone(input);
      const result = await acceptHouseholdParent({...args, storage, provider});
      await pins.save({version:1, scope:args.bundle.scope, pin:args.confirmedRootPin, head:args.confirmedSelectedHead});
      return result;
    }),
    acceptedParents: active(() => pins.list()),
    prepareDelegation: active(input => prepareHouseholdDelegation({...input, ...member})),
    acceptDelegation: active(input => acceptHouseholdDelegation({...input, ...authority})),
    prepareInvite: active(input => prepareHouseholdInvite({...input, ...preparation})),
    prepareGrant: active(input => prepareHouseholdGrant({...input, ...cooking, store, sodium, randomUUID})),
    prepareCeremony: active(input => prepareHouseholdCeremony({...input, ...preparation, wrappingPublicKey})),
    verifyOffer: active(input => verifyHouseholdOffer({...input, storage, pins, provider, sodium, identity})),
    session(input) {
      const session = householdSession({...input, sodium, store, keys, signing, wrapping});
      return Object.fromEntries(Object.entries(session).map(([key, method]) => [key, active(method)]));
    }

  };
}
