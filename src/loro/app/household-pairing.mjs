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

/** Both apps use the current workspace identity and the same signed admission flow. */
export function householdPairing({
  name, sodium, storage, master, provider, store, scope, pin, deviceId, adultId,
  runtime, service, pins, keys, signing, wrapping, signingKey, wrappingPublicKey,
  selection, selectedHousehold, LoroDoc, prepareJoinedSequences, finalizeJoinedSequences, randomUUID = () => crypto.randomUUID()
}) {
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
  const installed = new Set();
  return {
    identity, selection, selectedHousehold,
    transfer:{...transfer, install:async input => {
      const result = await transfer.install(input);
      for (const listener of [...installed]) {
        try { void Promise.resolve(listener()).catch(() => {}); }
        catch { /* A failed notification cannot undo an installed household. */ }
      }
      return result;
    }},
    onInstalled(listener) {
      installed.add(listener);
      return () => installed.delete(listener);
    },
    prepareExistingCeremony: input => prepareExistingCeremony({...input, ...preparation, wrappingPublicKey}),
    verifyExistingCeremony: input => verifyExistingCeremony({...input, ...member, sodium, wrappingPublicKey}),
    reviewGrant: input => reviewHouseholdGrant({...input, ...cooking}),
    approveGrant: input => approveHouseholdGrant({...input, ...cooking}),
    collectGrant: input => collectHouseholdGrantApproval({...input, ...cooking}),
    collectInvite: input => collectHouseholdInviteApproval({...input, ...member}),
    reviewInvite: item => reviewHouseholdInvite({...member, item}),
    approveInvite: input => approveHouseholdInvite({...input, ...member}),
    exportParent: () => exportHouseholdParent(authority),
    async acceptParent(input) {
      const args = structuredClone(input);
      const result = await acceptHouseholdParent({...args, storage, provider});
      await pins.save({version:1, scope:args.bundle.scope, pin:args.confirmedRootPin, head:args.confirmedSelectedHead});
      return result;
    },
    acceptedParents: () => pins.list(),
    prepareDelegation: input => prepareHouseholdDelegation({...input, ...member}),
    acceptDelegation: input => acceptHouseholdDelegation({...input, ...authority}),
    prepareInvite: input => prepareHouseholdInvite({...input, ...preparation}),
    prepareGrant: input => prepareHouseholdGrant({...input, ...cooking, store, sodium, randomUUID}),
    prepareCeremony: input => prepareHouseholdCeremony({...input, ...preparation, wrappingPublicKey}),
    verifyOffer: input => verifyHouseholdOffer({...input, storage, pins, provider, sodium, identity}),
    session: input => householdSession({...input, sodium, store, keys, signing, wrapping})
  };
}
