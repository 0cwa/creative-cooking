# Bounded policy contracts

Status: design and executable illustration, not production authorization. Profiles are named, versioned assemblies of these records, not a security slider, configuration matrix, or policy language. Privacy and retention are separate dimensions: short retention can undermine offline recovery. Equal adults have equal roles after admission; devices are not adults.

## Wire shapes

All records use canonical encoding with a specified algorithm and schema version before implementation. `Hash`, `Id` and `Signature` below are opaque strings; sets are sorted unique IDs. Reject unknown fields, enum values, versions and algorithms. Hash covers the complete canonical record, including scope, predecessor, checkpoint and activation; signatures cover that exact hash. The implementation must specify encoding, algorithms and size bounds before use.

```
Policy = {version: 1, id: Id, hash: Hash, predecessor: Hash|null,
 checkpoint: Hash, scope: Scope, controller: Controller,
 activation: {kind: 'prospective', after: Hash}, rules: Rules}
Scope = {kind: 'private'|'shared'|'authority'|'infrastructure', id: Id}
Controller = {kind: 'person'|'household'|'participants', ids: Id[]}
Rules = {actions: Action[], recipients: Id[], destinations: Id[],
 requirements: Requirement[], disclosure: DisclosureProfile[], retention: Retention|null}
DisclosureProfile = {recipient: Id, purposes: Id[], contentClasses: Id[],
 destinations: Id[]} // includes backup guardians and external AI providers
Requirement = {kind: 'namedConsent', people: Id[]} |
 {kind: 'quorum', electorate: Id[], threshold: number}
Retention = {minDays: number, maxDays: number, hostClasses: Id[]}
Acceptance = {policyHash: Hash, scope: Scope, checkpoint: Hash, signer: Id, signature: Signature}
Consent = {id: Id, hash: Hash, policyHash: Hash, scope: Scope,
 contentHash: Hash, recipient: Id, purpose: Id, person: Id, signature: Signature}
Evidence = {kind: 'possession'|'endorsement', person: Id, device: Id,
 checkpoint: Hash, policyHash: Hash, signature: Signature}
Request = {action: Action, actor: Id, device: Id, scope: Scope, contentHash: Hash,
 recipient: Id, destination: Id, purpose: Id, policyHashes: Hash[], checkpoint: Hash,
 acceptances: Acceptance[], consents: Consent[], evidence: Evidence[], localAlternative: boolean}
Decision = {result: 'Allow'|'LocalOnly'|'RequireConsent'|'Pending'|'Deny',
 reasons: ReasonCode[], requirements: Requirement[], recipients: Id[]}
```

`Action` is one of `restorePrivate`, `releasePrivatePackage`, `releaseSharedKey`, `disclose`, `approve`, `publish`, `enrollHost`, `editLocal`. Content hashes bind selected content and its recorded affected interests, including known sensitive inferences. Consent IDs and hashes cover every consent field except signature and hash. A changed recipient, scope, content, purpose or policy needs new consent; signatures are verified against canonical bytes. Acceptance never transfers to a successor or sibling hash. Record affected audience interests when the shared agreement is made, not by assuming every past editor is affected. Free text can contain inferences that software cannot reliably identify.

| Scope and controller | Actions and evidence | Boundary and failure |
|---|---|---|
| Private, person | Restore catalog with possession proof; guardian package requires owner's exact consent and its fixed distinct-person threshold | Independent restore needs no household confirmation. Provider keys stay device-only, excluded from every backup and recovery package. No shared floor can force private-key escrow. |
| Shared, affected participants | Publish or disclose only within accepted source agreements and recipient disclosure profiles, with named consents and quorum where specified | Personal relaxation never broadens shared rules; personal tightening does not rewrite others' accepted agreements. Historical restrictions persist. |
| Authority, household adults | Admit device using fresh-device possession, checkpoint-bound continuity and prescribed distinct current-adult endorsements; approve under frozen parent electorate | Recovery alone grants neither current keys nor a vote. Proofs establish possession and endorsements, not an honest human, independent custody or freedom from coercion. |
| Infrastructure, participants | Enroll host only when supported host class and retention intervals intersect accepted terms | Unsupported claims are incompatible; retention is an operator promise, not proof deletion. Narrow participation instead of forcing private changes. |

Guardians receiving a personal package can read its specified contents. A private guardian cannot receive household keys without a separate accepted shared grant. A group change quorum cannot override historical restrictions or all affected disclosure consents. A successor branch can use new content, or content independently permitted for that branch, not launder restricted history.

## Decision precedence

1. Validate exact schema, supported types and cryptographic evidence. Invalid or unsupported input is `Deny(INVALID_INPUT)`; unverifiable required evidence is `Pending(MISSING_EVIDENCE)`. Local edits can be saved locally without quorum, but never release fresh shared keys on unknown authority.
2. Resolve all policy hashes, predecessors and checkpoint; verify exact acceptance. Unknown, stale for a new action, or conflicting heads are `Pending(POLICY_UNRESOLVED)`, never last-write-wins. Historical envelopes retain their original policy and require explicit grandfathering; preserve otherwise. An offline peer cannot know unseen changes or claim global freshness.
3. Check actor's authority for this action at the accepted checkpoint. Missing admission is `Pending(ADMISSION_REQUIRED)`; invalid proof is denied. Private recovery is independent of household admission.
4. Apply every applicable source and recipient disclosure rule: intersect allowed recipients and destinations, and check action, content class and purpose. Known prohibition is `Deny(PROHIBITED)` before asking for consent. Empty intersection is `Deny(INCOMPATIBLE)`. An explicitly requested, independently eligible local alternative yields `LocalOnly(LOCAL_ALTERNATIVE)`; never silently substitute it.
5. Conjoin structured named-person requirements and separate frozen-electorate quorum requirements; never sum thresholds or flatten them into one count. Count distinct eligible adults, not devices. Missing exact named consent yields `RequireConsent(CONSENT_REQUIRED)`; missing quorum evidence yields `Pending(QUORUM_REQUIRED)`. A historical disclosure requires all recorded affected consents even if an administrative majority approved a change.
6. Intersect infrastructure host classes and retention intervals; unsupported claims or empty intersection are `Deny(INCOMPATIBLE)`. Finally return `Allow(OK)` with the exact recipients and requirements. No result grants a broader action than the request.

Schema validation and signed bindings can enforce acceptance, key release and envelope checks in a correctly implemented system. Cooperative clients can display consequences and request meaningful consent; social promises cannot prevent an authorized recipient from copying plaintext, screenshots or later disclosure. Neither encryption nor revocation is DRM. Relay acknowledgement does not establish peer receipt or deletion of copies. This specification and its Boolean model establish no cryptographic, network or security proof.
