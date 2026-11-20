# Bounded policy contracts

The [confirmed 2026-11-17 decisions](LORO-IMPLEMENTATION-DECISIONS.md) govern this revision. [Sync protocol contracts](LORO-SYNC-PROTOCOL.md) specify trust events, direct exchange, newcomer projections, recovery packages and frozen compromise review. The original Boolean model and explorer retain their strict-policy examples; the new `agreed-contracts.mjs` examples exercise a bounded subset of the revised behavior.

Status: design and executable illustration, not production authorization. Profiles are named, versioned assemblies of these records, not a security slider, configuration matrix, or policy language. Privacy and retention are separate dimensions: short retention can undermine offline recovery. Equal adults have equal roles after admission; devices are not adults.

## Wire shapes

All records use canonical encoding with a specified algorithm and schema version before implementation. `Hash`, `Id` and `Signature` below are opaque strings; sets are sorted unique IDs. Reject unknown fields, enum values, versions and algorithms. Hash covers the complete canonical record, including scope, predecessor, checkpoint and activation; signatures cover that exact hash. The implementation must specify encoding, algorithms and size bounds before use.

```
Policy = {version: 2, id: Id, hash: Hash, predecessor: Hash|null,
 checkpoint: Hash, scope: Scope, controller: Controller,
 activation: {kind: 'prospective', after: Hash}, rules: Rules}
Scope = {kind: 'private'|'shared'|'authority'|'infrastructure', id: Id}
Controller = {kind: 'person'|'household'|'participants', ids: Id[]}
Rules = {access: AccessGrant[], requirements: Requirement[],
 disclosure: DisclosureRule[], admission: AdmissionRule|null,
 retention: Retention|null}
AccessGrant = {actions: Action[], recipients: Id[], destinations: Id[],
 contentClasses: Id[], purposes: Id[]}
DisclosureRule = {id: Id, recipient: Id, purposes: Id[], contentClasses: Id[],
 destinations: Id[], enforcement: 'preference'|'block'}
AdmissionRule = {quorum: 'allMinusOne'|'unanimous'|'fixed', fixedCount: integer|null,
 delegation: 'currentCooking'|'none', delegationAcceptanceRefs: Hash[]}
Requirement = {kind: 'namedConsent', people: Id[]} |
 {kind: 'quorum', electorate: Id[], threshold: number}
Retention = {minDays: number, maxDays: number, hostClasses: Id[]}
Acceptance = {policyHash: Hash, scope: Scope, checkpoint: Hash, signer: Id, signature: Signature}
Consent = {version: 2, id: Id, hash: Hash, action: Action, policyHashes: Hash[], scope: Scope,
 sourceRefs: Hash[], payloadHash: Hash, recipient: Id, destination: Destination,
 purpose: Id, person: Id, checkpoint: Hash, signature: Signature}
Evidence = {kind: 'possession'|'endorsement', person: Id, device: Id,
 checkpoint: Hash, policyHash: Hash, signature: Signature}
Request = {version: 2, action: Action, processingKind: 'ai'|'other'|null,
 actor: Id, device: Id, scope: Scope,
 sourceRefs: Hash[], payloadHash: Hash, contentClasses: Id[], recipient: Id,
 destination: Destination, purpose: Id, policyHashes: Hash[], checkpoint: Hash,
 acceptances: Acceptance[], consents: Consent[], evidence: Evidence[],
 override: DisclosureOverride|null, localAlternative: boolean}
Destination = {kind: 'onDevice'|'networkLocal'|'external'|'backup',
 endpointIdentity: Id, executionEvidenceRef: Hash|null}
DisclosureOverride = {version: 2, action: 'disclose', processingKind: 'ai',
 actor: Id, device: Id, payloadHash: Hash,
 recipient: Id, destination: Destination, purpose: Id, sourceRefs: Hash[],
 policyHashes: Hash[], checkpoint: Hash, violatedPreferenceIds: Id[],
 requestNonce: Id, signature: Signature}
Decision = {result: 'Allow'|'AllowWithOverride'|'LocalOnly'|'RequireReview'|
 'RequireConsent'|'Pending'|'Deny', reasons: ReasonCode[],
 requirements: Requirement[], recipients: Id[], disagreementRecordRef: Hash|null}
```

`Action` is one of `restorePrivate`, `releasePrivatePackage`, `releaseSharedKey`, `disclose`, `approve`, `publish`, `enrollHost`, `editLocal`. `processingKind` is non-null only for content processing and is checked against the actual client operation, not accepted as an arbitrary label from an untrusted sender. Source references bind known content and its recorded affected interests; `payloadHash` binds the exact minimized bytes being sent, including the generated prompt and selected context. Neither consent nor override transfers to changed bytes or another action. Consent IDs and hashes cover every consent field except signature and hash. A changed recipient, destination, scope, content, purpose, checkpoint or policy needs new consent; signatures are verified against canonical bytes. Acceptance never transfers to a successor or sibling hash. Record affected audience interests when the shared agreement is made, not by assuming every past editor is affected. Free text can contain inferences that software cannot reliably identify. Removing names is minimization, not a guarantee of anonymity.

| Scope and controller | Actions and evidence | Boundary and failure |
|---|---|---|
| Private, person | Restore catalog with possession proof; guardian package requires owner's exact consent and its fixed distinct-person threshold | Independent restore needs no household confirmation. Provider keys stay device-only, excluded from every backup and recovery package. No shared floor can force private-key escrow. |
| Shared, affected participants | Access/key grants are blocking. AI processing of readable cooking content has separate accepted preferences or blocking disclosure rules. A preference can have an exact reviewed override. | An override records disagreement, not other adults' consent. It cannot release keys, disclose another person's private history, or bypass a blocking rule. Personal settings do not rewrite accepted rules. |
| Authority, household adults | Admit device using fresh-device possession, checkpoint-bound continuity and prescribed distinct current-adult endorsements; approve under frozen parent electorate | Recovery alone grants neither current keys nor a vote. Proofs establish possession and endorsements, not an honest human, independent custody or freedom from coercion. |
| Infrastructure, participants | Enroll host only when supported host class and retention intervals intersect accepted terms | Unsupported claims are incompatible; retention is an operator promise, not proof deletion. Narrow participation instead of forcing private changes. |

Guardians receiving a personal package can read its specified contents. A private guardian cannot receive household keys without a separate accepted shared grant. A group change quorum cannot override historical restrictions or protected named consents. The exception for ordinary current-state newcomer sharing is not an override: affected adults explicitly delegate that disclosure in the accepted admission agreement. Without that delegation, admission alone grants no content access. Deleted/history/private material remains outside it. A successor branch can use new content, or content independently permitted for that branch, not launder restricted history.

`AccessGrant` is an actual capability boundary, including reader audience and shared-key release. `DisclosureRule` governs subsequent processing by an already authorized reader; permitted profiles are compared by recipient, destination, content class and purpose. Failure to match an applicable blocking profile is denied; failure to match a preference profile can be explicitly reviewed only for readable shared cooking content sent for AI processing. Other actions, protected sources and absent access grants cannot use this exception. If several applicable profiles differ, all blocking constraints must pass; retain every preference disagreement separately. Broadening a blocking grant needs its accepted change/consent procedure, not the override button.

The default shared AI profile uses an overridable preference. Advanced configuration may choose a blocking standard-client rule. Truly on-device processing causes no external disclosure; a LAN model endpoint is a recipient and is not automatically on-device. Do not classify endpoints by a label, hostname or provider marketing. Redact identity metadata, minimize context, then review exact bytes. Revalidate before sending; changed payload, endpoint, source, trust checkpoint or policy requires fresh review. Never attach hidden extra context after approval. Persist the review/disagreement locally before dispatch; record sent/failed/unknown separately because network transmission cannot be made atomic with a local database commit. Retrying must preserve the exact reviewed payload.

## Decision precedence

1. Validate exact schema, supported types and cryptographic evidence. Invalid or unsupported input is `Deny(INVALID_INPUT)`; unverifiable required evidence is `Pending(MISSING_EVIDENCE)`. Local edits can be saved locally without quorum, but never release fresh shared keys on unknown authority.
2. Resolve all policy hashes, predecessors and checkpoint; verify exact acceptance. Unknown, stale for a new action, or conflicting heads are `Pending(POLICY_UNRESOLVED)`, never last-write-wins. Historical envelopes retain their original policy and require explicit grandfathering; preserve otherwise. An offline peer cannot know unseen changes or claim global freshness.
3. Check actor's authority for this action at the accepted checkpoint. Missing admission is `Pending(ADMISSION_REQUIRED)`; invalid proof is denied. Private recovery is independent of household admission.
4. Apply blocking access/source rules first: intersect allowed recipients and destinations, and check action, content class and purpose. Never release another person's private content or protected keys through the AI exception. Known prohibition is `Deny(PROHIBITED)` before asking for consent or review. Empty blocking intersection is `Deny(INCOMPATIBLE)`. An explicitly requested, independently eligible local alternative yields `LocalOnly(LOCAL_ALTERNATIVE)`; never silently substitute it.
5. Conjoin structured named-person requirements and separate frozen-electorate quorum requirements; never sum thresholds or flatten them into one count. Count distinct eligible adults, not devices. Missing protected exact consent yields `RequireConsent(CONSENT_REQUIRED)`; missing quorum evidence yields `Pending(QUORUM_REQUIRED)`. An admission grant satisfies only the disclosure previously delegated to it, not unrestricted historical disclosure. Infrastructure host classes and retention intervals must also intersect; unsupported claims or empty intersections are denied before requesting an override.
6. For external AI processing of already-readable shared cooking content, evaluate the separate disclosure profiles. A blocking profile mismatch is denied. A preference mismatch with otherwise valid authority yields `RequireReview(EXACT_PAYLOAD_REVIEW_REQUIRED)` until an actor-signed override matches the exact payload, endpoint, purpose, source, policies, checkpoint and every applicable preference disagreement. Persist the disagreement and return `AllowWithOverride`, explicitly not group consent. An override never cures missing evidence, protected consent, authority or incompatible infrastructure. Genuinely on-device processing needs no external-disclosure approval, but cannot conjure read access to protected content.
7. Otherwise return `Allow(OK)` with the exact recipients and requirements. No result grants a broader action than the request. `AllowWithOverride` is a visible exception to a cooperative preference, never a new decryption or governance capability.

Schema validation and signed bindings can enforce acceptance, key release and envelope checks in a correctly implemented system. Cooperative clients can display consequences and request meaningful consent; social promises cannot prevent an authorized recipient from copying plaintext, screenshots or later disclosure. Neither encryption nor revocation is DRM. Relay acknowledgement does not establish peer receipt or deletion of copies. This specification and its Boolean model establish no cryptographic, network or security proof.

## Model versions and checks

The original `contracts.mjs` and explorer implement the earlier strict-rule subset. They remain unchanged so their verified parity is not silently broken; do not treat their lack of an override as the new default. `agreed-contracts.mjs` is a separate finite illustration of admission, disclosure, projection labels and frozen review. Its hash strings, policy states, roster mappings and measured lengths are assumed verified inputs. It does not verify signatures, model multi-source grants, enforce real byte redaction, persist disagreement records or perform network calls. Production implementation must cover every additional schema binding and precedence step above.
