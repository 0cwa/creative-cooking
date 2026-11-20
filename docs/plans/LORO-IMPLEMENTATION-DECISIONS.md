# Loro implementation decisions

Status: confirmed by the user on 2026-11-17. The user accepted the recommendations recorded below, including the stated exceptions, and confirmed this consolidation with “Yes.” The present authorized follow-up is revising the detailed plan, schemas and executable illustrations; no production replacement or deployment has been performed. This records product requirements, not runtime feasibility, cryptographic security or a completed implementation.

Read this document before the [implementation plan](LORO-RELAY-IMPLEMENTATION.md), [policy specification](LORO-POLICY-CONTRACTS.md) and [sync protocol contracts](LORO-SYNC-PROTOCOL.md). These documents now incorporate the confirmed decisions. The original PoC and interactive explorer still illustrate their earlier models; a separate agreed-contract model covers a bounded subset of the new choices. None implements this complete contract in production.

## Product and release boundary

- Prioritize reliable household cooking and personal device sync. Broader community governance remains experimental evidence, rather than a requirement to ship a general governance platform.
- Keep the PowerSync implementation archived. Replace it with a fresh-data implementation; no migration, dual write, or silent reinterpretation or overwrite of existing stored data. Existing installations need a clear fresh-start choice at release.
- No mandatory email, password account, relay provider, or central identity service. Identity creation and local use work independently.
- Use one versioned protocol with tested configuration choices and explicit compatibility checks. Preserve advanced options without introducing arbitrary executable policies.
- Include configurable adult approval thresholds, independent and guardian-assisted recovery, disclosure preferences, retention settings, and compromise-boundary recovery in the first implementation. Do not quietly defer these after accepting them as scope.
- Defer automatic trust scoring, arbitrary policy scripts, automatic reconciliation between disputed branches, and any guarantee of background delivery.

## Transport and durable state

- A relay is optional. Support direct exchange when devices can connect, and an encrypted transfer alternative when they cannot. QR or verification codes assist pairing; they need not contain an entire dataset.
- An optional nonreading relay stores encrypted updates for asynchronous exchange. It does not interpret cooking data, select a legitimate trust branch, or establish another adult's receipt.
- Promise exchange while the app is open and a working path exists. Preserve pending work across closing and reopening. Do not promise delivery when no path or available intermediary exists.
- Distinguish saved on this device, relay acknowledgement, peer receipt, pending work, and quarantined work. Never use one ambiguous saved/synced indicator for all of them.
- Retain the proposed local transaction boundary: native op-sqlite and direct IndexedDB on web. Durable domain state, semantic effect identity, outbound bytes and outbox insertion commit atomically. A failed commit is not saved.
- Personal chats and Chef proposals remain personal. Deliberate sharing copies selected content into an explicitly shown audience. Provider credentials stay device-only and outside all backups and recovery packages.

## Adults, devices and admission

- Adults have equal standing once admitted. Count distinct eligible adults from the accepted parent roster, never device copies, reachable people, or claimed timestamps.
- Default adult admission threshold is `max(1, N - 1)`, where `N` is the existing adult count. Thus one of two adults may admit a newcomer. Explain this consequence at setup; offer unanimity and validated fixed-quorum alternatives.
- A proposed threshold resolves against its frozen parent electorate. A policy change follows the previously accepted policy; it cannot authorize itself. Incompatible valid successors remain visible branches.
- Accepting the admission agreement delegates permission to its quorum to share current household cooking data with admitted adults. It does not grant access to personal chats, excluded archives, or new external services. The delegation must be explicit in the accepted agreement.
- One currently accepted device may pair a fresh device belonging to the same adult using an explicit ceremony. Record visible device history. Additional devices create no extra votes. A compromised device's ability to enroll another device is an acknowledged consequence.
- Recovery without a surviving accepted device is a distinct admission path. Restoring a private catalog alone grants neither fresh household keys nor current approval authority; require current-adult confirmation and the accepted admission evidence.
- Distinguish local distrust, device revocation, adult removal and branch selection. Agreed removal rotates future household keys; a disputed removal produces a visible successor for those who accept it, rather than a forced universal state.
- Newcomers receive current household cooking state under the accepted delegation. Deleted content and older activity history are excluded unless separately shared. This is a confidentiality requirement: the implementation must not give newcomers historical keys or raw CRDT history that defeats it.

## Edits, intention and physical actions

- Accepted members make routine cooking edits immediately, including offline. Routine recipe and shopping actions require no household vote.
- Preserve independent edits. Concurrent edits to the same recipe text may display one result, but retain the competing intention for discovery and restoration without blocking every edit on a prompt.
- Give every independently recorded physical purchase its own event identity. Deduplicate retries of the same action, not two adults' separate purchases. Corrections preserve history and do not claim to undo the physical event.
- Keep Chef effects idempotent and durably linked to their proposal. External model completion is not evidence that a local effect committed.

## Trust judgments and compromise recovery

- Help people inspect and act on their own trust judgments. Neither device majority nor adult majority proves honesty.
- Immediately allow local quarantine and continued editing. A signed compromise report is evidence of a person's judgment, not an automatic command to erase another person's work everywhere.
- Record suspected compromise from a selected checkpoint or operation boundary, separately from revocation. A date can assist navigation but a suspect device's timestamp is not an authorization boundary.
- Reconstruct a clean copy from a selected checkpoint and explicitly retained semantic work. Preserve the original disputed history separately. Show excluded work, retained work, and work whose dependencies prevent safe replay; never promise arbitrary CRDT operations can be excised cleanly.
- Distinguish suspect-device authorship from honest work that depends on suspect content. Do not automatically label dependent authors or their devices compromised.
- Freeze a bounded review batch. Later submissions do not silently extend it, merge automatically, or generate repeated notifications. Fetching further evidence is explicit. A malicious source cannot prove that its batch is complete.
- Bound intake and processing before expensive verification/import. Keep oversized submissions unprocessed. Client quarantine limits local disruption; relay traffic abuse needs separate service limits.
- Late edits from revoked devices remain recoverable for explicit acceptance. They cannot restore authority or become trusted merely through a claimed earlier timestamp.

## Recovery and retention

- Personal recovery may rely only on surviving devices and a personal code. Accept permanent loss if all data copies or required recovery material disappear.
- Recovery setup is optional, with a persistent but dismissible reminder. Report recoverable keys separately from available data copies; a recovery code does not recreate missing ciphertext.
- Use independently random data and device keys. Recovery wraps an authorized catalog; it does not derive future household epochs or restore an old device identity.
- Offer configurable guardian reconstruction thresholds, with authenticated packages and distinct holders. Never silently lower a threshold for unavailable holders. Threshold holders can read their reconstructed package; this is not threshold signing.
- Personal guardian packages exclude household keys unless a separate shared agreement explicitly grants that audience access. Household assistance does not automatically expose private history.
- Revocation cannot recall already distributed plaintext, keys, packages or shares. New recovery material and affected key rotation are necessary after compromise; freshness still needs a trusted comparison.
- Bound ordinary undo retention, retain durable checkpoints, and offer explicit archives. Protect unresolved disputes and unsent work from automatic cleanup. Explain which recovery options destructive cleanup removes. Protected history does not imply unlimited storage: storage pressure must be visible and cannot silently discard it.
- Without surviving devices, an external backup or a retained relay copy, restoration is impossible even when keys survive. Explain this limitation and offer encrypted export.

## AI and communal privacy

- Omit names and identity metadata by default and minimize the content supplied for each request. Removing identifiers does not prove anonymity of distinctive content or inferred sensitive facts.
- Processing genuinely confined to the user's device requires no external-disclosure approval. A network endpoint called local is not automatically on-device processing.
- Household preferences govern shared cooking disclosures; private preferences do not silently rewrite accepted shared terms.
- Support an explicit reviewed-payload override for external processing of readable shared cooking content. Record and display disagreement with household preferences; do not label the override as consent from everyone.
- A household may choose stricter standard-client behavior. The exact configuration must distinguish an overridable preference from a blocking standard-client rule. Neither prevents an authorized reader from copying plaintext through a modified client.
- The override never authorizes disclosure of another person's private chats, recovery secrets or release of shared keys. Cryptographic access and protected personal scope remain separate from cooperative disclosure preferences.
- Earlier deny-only disclosure examples remain valid for blocking rules, not universal behavior for every shared cooking preference. The revised design schema distinguishes both; the new decision illustration tests that distinction. Production enforcement remains to be implemented.

## Engineering decisions and evidence still required

These are implementation work, not unanswered user preferences: pin supported runtime/library versions; select reviewed cryptographic bindings and canonical encoding; specify transport framing, pairing authentication and the direct-connect mechanism; define numeric input/storage limits and retention presets; define wire schemas, dependencies and checkpoint formats; and test native/web atomicity, interoperable encryption, replay resistance, disclosure boundaries and recovery.

In particular, current-state-only newcomer access may require fresh documents or projections and independent keys rather than raw historical CRDT transfer. Optional-relay operation requires a real alternate transport, not merely an offline editor. A frozen quarantine batch does not prove completeness, and no protocol can infer the socially correct compromise boundary. These remain explicit engineering obligations and security limits.

Confirmation is complete. The revised plan and schemas retain evidence grades and new executable cases rather than claiming the older model already covers these choices. Production implementation follows the revised acceptance gates; deployment remains a separately authorized action.
