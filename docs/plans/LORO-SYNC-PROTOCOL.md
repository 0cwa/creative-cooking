# Household sync protocol contracts

Status: implementation design, 2026-11-17; no production protocol is implemented here. Product choices are confirmed in [the decision record](LORO-IMPLEMENTATION-DECISIONS.md). This document specifies application contracts and gates; it does not claim a new cryptographic protocol has been audited. Names below are logical record types, not installed application APIs.

## Encoding and common bindings

`Id` is an opaque random identifier, never a display name; `Hash` is a collision-resistant content digest; `Bytes` is binary; `Signature` and `WrappedKey` use a pinned, runtime-tested suite. All records carry a schema version. Canonical serialization, suite IDs, key encodings, signature domains and hash algorithms must be pinned in phase 1 before interoperable code. Signatures cover a domain-separated record digest excluding only the signature list. Preserve list order where semantically significant; normalize mathematical sets and reject duplicates. Reject unknown versions, invalid fields, wrong domains and unsupported algorithms without importing their content. Do not invent a custom pairing cipher or substitute a short code for a high-entropy secret.

Before expensive parsing, verification or decompression, enforce measured byte and count limits. Unauthenticated headers are not evidence of their claimed author. Invalid input must not fill an unlimited forensic store. Keep a bounded rejection summary; save full rejected bytes only within an explicit quarantine budget. Never silently discard previously acknowledged durable work to admit hostile input.

## Identity and authority

```text
Adult = {personId, genesisRef}
Device = {deviceId, personId, signingPublicKey, wrappingPublicKey, suiteId}
QuorumPolicy = {kind: 'allMinusOne'|'unanimous'|'fixed', fixedCount: integer|null}
TrustEvent = {version, householdId, parentHead, policyHash, kind,
  proposalId, authorDeviceId, frozenAdultRoster, subject, nextRoster,
  nextPolicyHash, epochId, keyEnvelopeRefs, possessionProofRef,
  continuityProofRef, signatures}
TrustKind = 'inviteAdult'|'pairOwnDevice'|'recoverDevice'|'revokeDevice'|
  'removeAdult'|'leave'|'changePolicy'
Approval = {version, eventHash, parentHead, policyHash, adultId, deviceId, signature}
LocalBranchChoice = {householdId, selectedHead, observedHeads, selectedAtLocal}
```

Resolve the *parent* roster, policy and accepted device-to-adult mapping before counting approvals. Default `allMinusOne` means `max(1, N - 1)` for adult admission; offer unanimity and valid fixed counts. Store resolved thresholds with the frozen parent state, not a count of currently reachable devices. Policy transitions are approved under the parent rule; next-policy fields do not authorize themselves. Invitation and removal policies use the same distinct-adult counting semantics; any advanced per-action differences must pass compatibility validation and show that invitation can expand future electorates. No vote count establishes human honesty. The two-adult default permits unilateral adult admission; explicitly disclose this during setup.

Own-device pairing requires possession of the fresh private keys and sponsorship by an accepted device of that same adult. It does not add an adult or a vote. Recovery creates new device keys and separately requires continuity evidence, fresh possession and confirmation by a current adult under the accepted admission requirements. Restoring a private catalog or signing an unconfirmed claim is insufficient. Device revocation and adult removal are different records; rotate affected future keys and exclude retired device/recovery authorizations. Local quarantine and branch selection require no shared quorum. Never interpret `selectedAtLocal` or event timestamps as authority.

Valid sibling successors remain competing heads even when delivered in a convenient order. Approvals bind one exact event hash; they cannot transfer between siblings. An observer lacking a parent or encountering incompatible authority keeps the action pending. Local branch selection is not an assertion that every participant selected it. Rejoin is fresh admission on the chosen successor, not automatic merge of authority histories.

## Pairing and direct exchange

First implementation target: browser `RTCDataChannel` and an Expo development/release-build adapter through `react-native-webrtc`. This is an engineering choice requiring a cross-platform spike, not a proven integration. The [W3C WebRTC specification](https://www.w3.org/TR/webrtc/) defines data channels; [the upstream native module](https://github.com/react-native-webrtc/react-native-webrtc) documents data-channel support and native code requiring a development build rather than ordinary Expo Go. Pin the exact compatible versions only after the spike. Do not request camera or microphone access merely to open a data channel; QR scanning is a separate optional permission.

Out-of-band QR, verification-code comparison and import/export assist an authenticated key-exchange ceremony implemented with a reviewed construction. Bind both device keys, intended action (own device versus adult invitation), household, parent, session nonce and the entire signaling transcript. Short verification codes authenticate a transcript or a reviewed PAKE; they never become a low-entropy backup-encryption key. Unverified signaling exchanges release no dataset key. Invitations are not accepted merely because a URL was opened.

Manual offer/answer exchange through bounded files or segmented QR must work without an account, signaling server or relay. Reconnection can exchange fresh offers; the first version does not promise automatic LAN discovery. Default direct mode uses no external STUN/TURN servers; opt-in connectivity helpers disclose their operator and metadata exposure. A same-network connection can still fail due to network/browser restrictions; report the failure and offer encrypted bundle transfer. Direct exchange remains a release gate, not a feature silently replaced by offline-only editing. Do not promise connectivity through every NAT or firewall.

```text
PairingTranscript = {version, sessionId, action, householdId, parentHead,
  initiatorDevice, responderDevice, offerHash, answerHash, proofRefs}
ExchangeFrame = {version, sessionId, streamId, kind, transferId, chunkIndex,
  chunkCount, payloadHash, bytes}
FrameKind = 'hello'|'inventory'|'request'|'objectChunk'|'receipt'|'close'
ExchangeBundle = {version, transferId, sourceDevice, intendedRecipients,
  inventoryHash, encryptedObjectRefs, manifestSignature}
PeerReceipt = {version, recipientDevice, transferId, objectIds, trustHead,
  state: 'stored'|'applied', signature}
```

Frame size is at most the lower of the negotiated transport maximum and a conservative initial 16 KiB application limit; apply backpressure. Bound transfer count, aggregate bytes, manifest entries, chunk count and idle sessions. Reassemble to bounded durable staging; verify whole-object hash and application envelope before inbox import. Resume by immutable object ID. The same encrypted objects travel by direct channel, file or relay; no transport bypasses policy checks. Import a bundle in bounded atomic batches, never one unbounded transaction. Physical file transfer can disclose timing and filenames: use opaque names and do not claim metadata anonymity. Receipt inventories contain no decryption keys and travel only to their authorized audience. `stored` means durable ciphertext; `applied` means a particular device imported it, not household consensus.

## Content, envelopes and recovery packages

```text
ContentEnvelope = {version, suiteId, scopeId, documentId, documentGeneration,
  branchHead, policyHashes, epochId, authorDevice, deviceSequence,
  predecessorRefs, semanticEffectIds, payloadKind, nonce, ciphertext, signature}
KeyEnvelope = {version, suiteId, scopeId, branchHead, policyHashes, epochId,
  recipientDevice, keyPurpose, wrappedKey, senderDevice, signature}
RecoveryCatalog = {version, owner, generation, previousCatalogHash,
  keyRefs, encryptedObjectRefs, trustedCheckpoints, custodyLocations}
GuardianPackage = {version, owner, scope, packageGeneration, guardianRoster,
  threshold, encryptedCatalogRef, sharedGrantRef, approvalRefs}
```

Bind envelope headers as authenticated associated data and sign the complete encrypted record. An immutable object ID hashes its canonical bytes; retry identical bytes after ambiguous responses. Secure RNG, AEAD nonce uniqueness, signatures, key wrapping and KDF must pass web/Hermes interoperability and negative tests. Validate semantic-effect IDs against domain commands; IDs are not a license to trust opaque CRDT edits. Do not expose personal keys in household key envelopes, or put provider credentials in any backup. Only rotate affected contexts; stable adult identifiers are household-scoped and are not promised unlinkable across all exchanges.

Guardian packages have independent random wrapping keys and fixed distinct holders, with validated `1 <= t <= n`. Explain that `t = 1` permits unilateral reconstruction, and that one person with several copies is still one holder. Personal and shared packages are distinct: personal default excludes household keys; a shared package requires an accepted shared audience grant. Reconstruction, access to historical material, and current admission are separate outcomes. Recovery kit UI reports both key-material readiness and available data custody; no code can restore absent objects. Share removal requires new wrapping material and affected rotations, not a promise of recalling old copies.

## Newcomer state and protected history

```text
CurrentStateGrant = {version, householdId, parentHead, admissionEventHash,
  sourcePolicyHashes, delegationHash, recipientAdult, recipientDevices,
  contentClasses: ['recipe'|'pantry'|'shopping'], projectionManifestHash,
  newDocumentGeneration, newEpochId, keyEnvelopeRefs, signatures}
ProjectionEntry = {sourceDocument, sourceCheckpointHash, projectedStateHash,
  newDocumentId, newGeneration, schemaVersion}
Checkpoint = {version, scopeId, documentId, generation, branchHead, policyHashes,
  schemaVersion, coveredVersionVector, snapshotHash, authorizations}
```

Admission agreement acceptance explicitly delegates current-cooking-state disclosure to its configured quorum. It does not delegate deleted/history/private/guardian/provider disclosure. Validate both admission and this source grant. A separately restricted source cannot be laundered through an ordinary admission event.

Normal Loro snapshots contain operation history as well as current state, as described in [Loro's encoding documentation](https://loro.dev/docs/tutorial/encoding). **Never issue old household epoch keys or original document histories as a current-state-only invitation.** Project validated live domain fields into fresh Loro documents with new IDs/generations and independent keys. All accepting existing clients join that generation for future work; retain old encrypted documents only for the old audience. A newcomer cannot decrypt the private source archive. Opaque provenance hashes do not grant archive access; even provenance metadata needs an audience check.

The opt-in current-cooking admission path uses projection manifest v5 and
encrypted file version 3. The existing quorum grant commits the selected
source set and maps each live recipe to a document scoped to the successor.
Publisher storage checks the recorded authority and every source and catalog
revision at commit. Recipients verify the signed grant, projection bytes,
policy sidecars and their own per-document key packages before installing
the exact set. Older single-document releases and transitions fail closed
when the local selected workspace has recipe children. Normal app routing
still requires a catalog-aware runtime, checkout, same-adult release,
rotation and recovery.

Queue offline edits from the old generation for semantic rebase or explicit review. Do not directly import the old operation history into the fresh generation. Preserve original intent when rebasing cannot be safe. This applies to pending Chef effects and purchase identities too: retain domain idempotency without leaking excluded historical payloads. The exact projection must be tested with canary secrets in deleted text, undo records, pending imports and serialized containers. Manifest labels alone prove nothing about bytes.

## Suspected compromise and frozen review

```text
CompromiseReport = {version, reportId, reporterDevice, householdId,
  selectedHead, suspectDeviceIds, boundaryCheckpoint,
  boundaryDeviceSequences, reasonText, evidenceRefs, signature}
ReviewManifest = {version, reviewId, reportHash, acceptedCheckpointHash,
  evidenceObjectIds, evidenceBytes, omittedSummary, signature}
Reconstruction = {version, reviewId, checkpointHash, selectedSemanticEffectIds,
  rejectedEffectRefs, unresolvedDependencyRefs, newGeneration,
  newBranchHead, projectionManifestHash, authorizations}
```

The reporter chooses the boundary; never infer it from an adversary's timestamp. Preserve receipt time only as a local observation. Membership removal has a separate prospective effect. Other adults can accept or reject the report without it silently changing their state.

Freeze the manifest and persist it before review. Late material stays outside it; another explicit fetch creates a new manifest with its own identity and budget. Initial review budgets: 256 objects, 8 MiB aggregate, 1 MiB per object, 64 dependencies per semantic item. These are engineering starting points to measure, not an availability guarantee. Persist only bounded rejection summaries for excess input; no repeated notification for the same source/reason. Model sizes must come from measured bytes, not claimed lengths. Bound peer queues, total quarantine storage, per-source verification work and relay quotas independently; a per-batch limit alone does not prevent DoS.

Classify suspect-device authorship, honest dependency on suspect content, missing dependency and independently eligible work separately. An eligible change still needs explicit selection. Cycles and missing predecessors do not count as clean. Reconstruct from the selected checkpoint or an explicitly reviewed live projection; do not erase original disputed history or claim raw causal operations can always be surgically removed. A frozen batch is not proof that the adversary supplied everything.

## Retention, relay and atomic receipts

Proposed engineering starting points, not additional user commitments: a 90-day ordinary local undo window configurable at setup, and a 256 MiB single-household relay quota, advertised as capacity rather than guaranteed retention. Validate these provisional budgets against measured histories before release; differing hosts must publish their own compatible terms. Never silently evict unsent work, unresolved disputes or the last required checkpoint. At capacity, pause new remote intake/uploads as appropriate, keep recovery/export available, and show the pressure. A blocked shared commit must not masquerade as a saved shared edit; offer an explicitly local draft if storage permits.

Relay `PUT` acknowledges only after the object and log entry are durably committed; repeated exact bytes produce the same receipt. No ordinary member gets seal, delete or compact authority over the common mailbox. Retention belongs to explicit host terms, not a hidden membership power. Physical cleanup requires a valid retained checkpoint and consideration of stale clients; retention expiry never authorizes silently dropping their pending edits. `RelayReceipt`, local commit, `PeerReceipt(stored)` and `PeerReceipt(applied)` remain different facts.

Local transaction contracts persist working-document output, semantic effects, immutable envelope and outbound row together. Inbound ciphertext and fetch cursor commit before verification; document import and applied status commit together after validation. Failed commits reopen durable state. Recovery actions and reconstruction manifests must survive restart independently of a currently open screen. An application decision record is not proof of fsync or transactionality: fault injection is a release gate.

## Executable coverage and limits

Run `node --test spikes/relay-household-poc/agreed-contracts.test.mjs` for the new pure cases. They cover roster thresholds, exact reviewed overrides, protected scopes, fresh-state grant labels and bounded frozen-review classification. They assume verified identity/crypto, correct byte measurements and honest projection labels; they do not test encryption, transport, actual history redaction or crash safety. The earlier Loro fixture and strict-policy explorer remain useful independent evidence, not complete implementations of these contracts.
