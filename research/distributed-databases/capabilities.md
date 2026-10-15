# Distributed capabilities, group keys and Automerge transport: primary-source review

Checked 2026-10-15. This lane inspects current source, prior executed evidence, and a new narrow 12-probe execution against the current frozen ARK graph. It does not claim full interoperability/security qualification. Exact commits below are reproducible source snapshots. Repository `pushed_at` alone is not proof of released functionality.

## Current graph probe actually executed

In an isolated clone at ARK `390a1488826d26bd0f183d66ed260d69ca8b36af`, installed the upstream lockfile using pinned pnpm10.15.0 (`--frozen-lockfile --ignore-scripts`). Dependencies resolved to AutomergeRepo2.6.0-subduction.49, KeyhiveWASM0.4.0-alpha.1 and AutomergeSubduction0.20.1. Node24.19.0. Copied the existing PR40 `ark-adversarial.test.ts` unchanged in logic; only metadata was corrected to the current graph/runtime. **8/12 probes pass;4 fail**, reproducing the earlier direct API findings on current published dependencies:

- Altered Ed25519 contact-card signature is admitted to live Keyhive graph. API admission evidence, not protected-document/network compromise.
- Authorized separate reader still cannot decrypt using the existing archive/key-event probe. This demonstrates that this integration path remains unqualified; a proper upstream onboarding flow could differ.
- Ungranted requester can forward an Edit-author update at direct policy boundary. Signed-author checks remain; threat-model/policy decision, not a forged-author wire exploit.
- Legacy unprotected document IDs allow fetch and put at direct ARK policy boundary.

Positive probes include protected32-byte factory, expected role-based fetch/write author checks, outsider denial for protected documents, owner encryption/decryption, genuine membership-archive ingestion and local role transitions. Future-key revocation negatives are not independent proof while positive reader decryption fails.

Artifacts: `/workspace/work/capability-sources/ark-current-security-matrix.json`, `/workspace/work/capability-sources/ark-current-security.log`, executed harness `/workspace/work/capability-repos/automerge-ark/test/creative-cooking-current-security.test.ts`. Exact command: `CC_ARK_SECURITY_EVIDENCE=/workspace/work/capability-sources/ark-current-security-matrix.json npx --yes pnpm@10.15.0 exec vitest run test/creative-cooking-current-security.test.ts --reporter=verbose`. First frozen install with hostpnpm11 failed config compatibility; using upstream-required10.15 resolved it without lock changes. No Rust relay/native run.

## Fresh execution status

The current frozen ARK dependency graph was independently executed twice: **12 tests, 8 pass, 4 fail**. [Evidence, scope and reproduction](README.md) record tampered-card admission, unqualified authorized-reader archive decryption, stricter requester-forwarding policy and legacy-ID admission. This prevents current adoption; research relevance is not a passing result. The remaining requalification steps below are conditional on resolving these gates, not a request to repeat completed probes.

## Decision contribution

**Reopen current Automerge Repo Keyhive (ARK) + Keyhive + Subduction as an actively progressing research candidate.** It is the closest conceptual match to retaining Automerge with offline, cryptographically enforced access control and keyless persistent peers. Do not permanently reject it because an older alpha failed, and do not mistake the new version for passing the old tests. Current source has substantive security/dependency/storage work. It still has concrete adoption gaps: service legacy-ID admission remains, no built-in identity backup/recovery, imminent integration refactor, browser-WASM versus native binding boundary, and an explicitly unaudited novel crypto construction.

**Willow/Meadowcap deserves an architectural shortlist place for fine-grained offline capabilities and selective durable replication**, but it is not a drop-in group-key/transport replacement today. The current implementation lives on Codeberg and has progressed farther than its website introduction suggests. It offers persistent storage and import/export drops, but the checked crate does not implement the online Confidential Sync protocol or managed E2EE key lifecycle.

**UCAN is a serious maintained authority/delegation standard, not a household collaboration SDK.** Composing UCAN with Automerge and a database does not itself supply group encryption, invitation verification, key rotation, offline revocation convergence or recovery. Do not present that composition as avoiding custom group protocol work.

User's preference for progressing alpha/beta is sensible. Rank progress, architectural fit and bounded missing pieces separately from production security assurance. A no-production warning blocks a claim of shipping readiness, not research priority.

## Exact current graph and changes since earlier spikes

| Component | Current source inspected | Actual evidence |
|---|---|---|
| Keyhive | [`585e6fc55974de55c9a808e81d70688ba0fd56e2`](https://github.com/inkandswitch/keyhive/tree/585e6fc55974de55c9a808e81d70688ba0fd56e2), Oct14; `keyhive_core`0.7.0, BeeKEM0.5.0 | Real maintained Rust/WASM signing, delegation, concurrent group-key agreement, encrypted content, archive/prekey state. README still pre-alpha/unaudited and warns novel nonce/key commitment not independently reviewed. Apache-2.0. |
| ARK | [`390a1488826d26bd0f183d66ed260d69ca8b36af`](https://github.com/automerge/automerge-repo-keyhive/tree/390a1488826d26bd0f183d66ed260d69ca8b36af), Oct13;0.7.0-alpha.1 | Manifest pins Automerge Repo2.6.0-subduction.49, Automerge Subduction0.20.1, KeyhiveWASM0.4.0-alpha.1. Prior spike used ARK0.6.0-alpha.1/Subduction0.16.1/KeyhiveWASM0.3.0-alpha.1. This is a materially updated graph. |
| Subduction | [`0e7da6523191d528b3338d7e40d5c5a342cef7fe`](https://github.com/inkandswitch/subduction/tree/0e7da6523191d528b3338d7e40d5c5a342cef7fe), Oct14; AutomergeWASM package0.20.2 | WS, HTTP longpoll, Iroh transport; sedimentree partitioned opaque-data sync; filesystem and redb storage; Keyhive runtime/policy. Workspace Rust core pins Keyhive0.7.0. MIT OR Apache-2.0. |

### Security findings must be stated at the correct boundary

1. **Signed unauthorized revocation is fixed in current Keyhive source.** [`principal/group/state.rs::add_revocation`](https://github.com/inkandswitch/keyhive/blob/585e6fc55974de55c9a808e81d70688ba0fd56e2/keyhive_core/src/principal/group/state.rs) checks the revoker's authority rather than merely a cited legitimate proof. [`tests/access_control.rs`](https://github.com/inkandswitch/keyhive/blob/585e6fc55974de55c9a808e81d70688ba0fd56e2/keyhive_core/tests/access_control.rs) includes `a_revocation_citing_someone_elses_delegation_as_proof_is_refused`. The old exact spike graph was vulnerable and an official fixed core passed an earlier owned regression probe. The new current ARK policy/WASM probe does not include this independent Rust signed-revocation regression.
2. **Legacy service admission remains.** Current [`subduction_cli/src/policy.rs`](https://github.com/inkandswitch/subduction/blob/0e7da6523191d528b3338d7e40d5c5a342cef7fe/subduction_cli/src/policy.rs) says `Legacy (zero-padded) doc IDs are always allowed` and explicitly permits fetch/put/filter for those IDs. The lower-level [`subduction_keyhive/src/policy.rs`](https://github.com/inkandswitch/subduction/blob/0e7da6523191d528b3338d7e40d5c5a342cef7fe/subduction_keyhive/src/policy.rs) rejects unknown protected documents. Inspecting only that lower-level file would falsely declare the service bypass closed. Prior executed signed-wire unauthorized legacy upload/retrieval remains relevant to this code path; that was not a protected-recipe decryption exploit.
3. **Forwarder versus author is still an explicit open policy decision.** Current `authorize_put_with` accepts a `VerifiedAuthor`, checks author Edit permission and ignores `_requestor`, with TODO whether requester needs Relay. Relaying a legitimately signed authorized update need not itself be a flaw under every threat model. Do not call this forged-author acceptance. Creative Cooking must decide whether unknown peers may relay pre-signed bytes and test the actual service policy, replay handling and resource limits.
4. **Contact-card authenticity and positive reader onboarding still need current-graph qualification.** New current-graph execution reproduces tampered-card admission at an API boundary and the authorized-reader archive probe fails to decrypt. This is not a network exploit or a blanket statement about every onboarding API; positive onboarding is indispensable before interpreting negative revocation tests.
5. **Protecting document creation is still opt-in.** Current [ARK README](https://github.com/automerge/automerge-repo-keyhive/blob/390a1488826d26bd0f183d66ed260d69ca8b36af/README.md) says `repo.create2` uses protected ID factory while `repo.create` creates an unprotected document. App repository should expose only protected creation for shared data; server service must reject unprotected namespace rather than trusting every caller to remember.

### Identity, storage, transport and maintenance

Current [ARK API guide](https://github.com/automerge/automerge-repo-keyhive/blob/390a1488826d26bd0f183d66ed260d69ca8b36af/docs/automerge-repo-keyhive-api-guide.md) explicitly says **there is currently no key backup or recovery mechanism**. It stores identity JWK, archives, ops and exported prekey secrets in supplied adapter; clearing storage destroys identity. Recovering a domain export is different from restoring cryptographic membership. Securely exporting/importing the whole supported identity state may be bounded application work if upstream provides a stable archive contract, but we should not improvise a recovery cryptographic protocol.

Current README also announces imminent replacement of TypeScript membership sync with Rust-WASM API, removing much of `src/network-adapter`. That is real progress and real near-term churn, not abandonment. Avoid building a large adapter atop code explicitly about to be deleted. Pin one coherent published graph, or one coherent source graph with resolved lockfiles; latest Rust and latest npm numbers are not automatically wire-compatible.

Subduction storage now has explicit file fsync-before-rename and directory fsync-after-rename handling. [`sedimentree_fs_storage/src/lib.rs`](https://github.com/inkandswitch/subduction/blob/0e7da6523191d528b3338d7e40d5c5a342cef7fe/sedimentree_fs_storage/src/lib.rs) comments and implementation describe crash-durable compound writes, durable directory creation, batched staging and registry publication after write success. [`subduction_redb_storage/src/lib.rs`](https://github.com/inkandswitch/subduction/blob/0e7da6523191d528b3338d7e40d5c5a342cef7fe/subduction_redb_storage/src/lib.rs) similarly documents redb transaction fsync and durable external blobs. This is stronger than old version, but does **not** establish old ENOSPC + acknowledged-sync loss is fixed throughout in-memory/network acknowledgements; rerun that exact fault test before claiming durability.

Browser/Node WASM is explicitly supported. React Native/Hermes is not equivalent to browser WASM; no ready supported ARK Hermes binding identified in these sources. Existing Creative Cooking #45 native Subduction wrapper proves iOS Simulator transport interop, not complete native Keyhive/ARK and CRDT correctness. Iroh relay is online rendezvous/forwarding; durable offline replication needs a persistent peer, which Subduction can provide independently of Iroh.

### Smallest useful requalification (reuse existing harness)

- Completed: update the isolated #40 harness to the coherent current ARK lockfile; retain current and old failing outputs as evidence.
- First prove protected document A→authorized B decrypts and both converge through a persistent plaintext-blind peer, across restart. If this fails, stop and report exact missing API, not a replacement crypto implementation.
- Replay old signed revocation regression, tampered card admission, and exact legacy-ID wire probe. Require production-shaped service to close or explicitly isolate the legacy namespace.
- Add two household groups, reader/editor/admin; concurrent invite/revoke with offline writer and reconnect; prospective key denial after membership convergence; retained history semantics explicit.
- Rerun old ENOSPC/acknowledgement/restart case against current storage path. Preserve sender history until durable peer confirmation.
- Check supported exported identity/archive contract and restore on a second clean installation. Lack of upstream recovery API is an adoption gap, not a reason to invent group key backup crypto.
- Only after browser positive/security gates, scope one current native binding compile/foreground roundtrip using existing Expo fixture. No hardware runner exists; physical ARM64 and OS-kill persistence must remain open labels.

This is a bounded refresh of existing evidence. It should take priority over growing a Matrix-specific payload layer if Automerge is retained and user accepts active alpha development.

## Willow, Meadowcap and Earthstar

### Current location and progress

The current implementation is [worm-blossom/willow_rs on Codeberg](https://codeberg.org/worm-blossom/willow_rs), **not** the old GitHub paths still referenced in some website content. Inspected commit [`e6a6a9b8c57607c6109178dc3847f44d38183f93`](https://codeberg.org/worm-blossom/willow_rs/src/commit/e6a6a9b8c57607c6109178dc3847f44d38183f93), Sept23; crate `willow25`0.7.9, MIT OR Apache-2.0. The spec website is active through Oct14, pinned at [`c06a61bdf2297419b699b7f4f88bff7ea183cc03`](https://github.com/earthstar-project/willowprotocol.org/tree/c06a61bdf2297419b699b7f4f88bff7ea183cc03).

**Implemented in current crate:** Willow'25 entries/paths/groupings; read/write capability authorization; capability attenuation; in-memory and persistent store; signed entries; import/export drop format. `storage/persistent_store.rs` exists and validates write capabilities, so website introduction saying persistent storage coming soon is stale. Good evidence of forward development.

**Not identified in checked crate:** network Confidential Sync session implementation, browser-WASM or Expo/native SDK bindings, managed membership/invitations/recovery, group E2EE key rotation. There is no Confidential Sync module among current crate modules. This narrower source finding must not be generalized to every independent implementation.

### Access control semantics

[Meadowcap](https://willowprotocol.org/specs/meadowcap/) provides read/write capability grants restricted to namespaces, subspaces, path prefixes and time ranges; delegation can only reduce authority. Good fit for household A shopping subtree versus B recipe copies and for data-minimizing partial sync. It authorizes data entries, not arbitrary human identity claims.

[Official E2EE discussion](https://willowprotocol.org/specs/e2e/) explicitly says Willow has no built-in mechanism for encrypting data. Capabilities/privacy-preserving overlap/transport encryption are not the same as blind-server household content encryption and membership key rotation.

Meadowcap does not present immediate global revocation as a convergent membership facility. Official example issues weekly time-bounded capabilities and declines renewal; owner may overwrite unwanted entries at later timestamps. For append-only Automerge changes, mapping per-change hashes to immutable paths avoids LWW loss, but compaction/retention, historical audit and capability expiry for delayed offline edits become app/adapter policy. Do not claim expired-entry timestamp bounds imply secure wall-clock global revocation.

### Old TypeScript Earthstar is a separate code line

GitHub Earthstar default branch [`3694adbdfd0fcb5978be7b4b71ce865d2ace42ce`](https://github.com/earthstar-project/earthstar/tree/3694adbdfd0fcb5978be7b4b71ce865d2ace42ce), last default-branch code Apr2025, says v11 Willow beta development on `willow` branch. v10 README browser IndexedDB/Deno/SQLite and shared write secret is not evidence of current managed groups or forward-secret E2EE. `meadowcap-js` [`2c090d476d2f7c6fe1a34613ee4d636047b46538`](https://github.com/earthstar-project/meadowcap-js/tree/2c090d476d2f7c6fe1a34613ee4d636047b46538), July2024, should not be treated as current Willow'25 production SDK. LGPL3 for Earthstar v10; current Rust is permissive dual license.

**Disposition:** strong architecture/design and an actively progressing Rust substrate; likely broader than a small cooking spike if we require app to supply network protocol and group keys. Reconsider when a maintained implementation supplies Confidential Sync + required native/web storage, or if trusted-server content access is acceptable and another lane offers the whole framework. Small prototype of scoped capabilities/storage is meaningful only if it answers a decision, not to reimplement missing pieces.

## UCAN, object capabilities and composability limits

[UCAN 1.0 specification](https://github.com/ucan-wg/spec/blob/a73ee55ec82a90004227034873095e080d0df619/README.md), current Oct2 source, defines public-key-bound delegations, invocations, revocation and attenuation. It explicitly permits local CRDT updates with invocation logs. Serious fit for distributed authorizations; not just central OAuth bearer tokens. But enforcement must define authoritative subject/resource, command semantics, invocation uniqueness/replay store, proof/revocation dissemination and delayed-offline-write validity.

Active implementations include [Storacha ucanto](https://github.com/storacha/ucanto/tree/0255a11427114584d9cc26f4be6545540f8caeb7) (Mar2026 source, modular JS) and [Rust UCAN](https://github.com/ucan-wg/rs-ucan/tree/59ff9b9c8479b41072688d36709eb762ac9d8ecd) (default-branch commit Mar2026, repo pushed June). Older `ts-ucan` last pushed Mar2024; do not confuse spec1.0 with implemented wire versions. Verify each implementation's target spec before composition.

UCAN signatures protect authority; they do not distribute/rotate household content keys. AWAKE is a key-agreement/delegation protocol specification; existence is not a maintained drop-in identity-and-recovery SDK. Adding raw MLS still requires identity authentication, delivery ordering, durable state and recovery glue. That may be appropriate platform development, but exceeds this feasibility study's goal of avoiding bespoke group crypto orchestration.

[Cap'n Proto](https://github.com/capnproto/capnproto/tree/b5ee48b9f3586fc83af8c429623e2c0d2435ec59) is active Oct13. Its object-capability RPC and persistent capability concepts solve different boundaries: communicating authorized remote objects, not convergent offline group membership plus E2EE document history. C++/RPC adoption would add rather than remove mobile/web database integration work. Do not confuse capability transport authority with encryption-key lifecycle.

No relevant maintained distributed-access-control SDK named **Capybara** was verified. Searches yielded research type systems, edge storage papers and unrelated browser testing. Avoid inventing a capability library because of a similarly named paper.

## Existing packages that do not fill the gap

- [`@localfirst/auth`](https://github.com/local-first-web/auth/tree/ea46b2adbd1d97ea0205d58564e7f67cd7342e20) is explicitly no longer maintained and archived Oct8. Its attractive existing model includes team signature chain, roles, invitations, device keys and rotation. Its underlying [`crdx`](https://github.com/herbcaudill/crdx/tree/483965b0815c46abf2c8d5dbb74f73322322f879) is also archived, last source Apr2024. No maintained drop-in successor established here. Do not adopt abandoned crypto middleware simply to retain nicer integration.
- [`secsync`](https://github.com/nikgraf/secsync/tree/03202ba91b847a19a5d94f09a1d5cc12207a5c42), last source Sep2024, implements signed encrypted snapshots/updates and a central sequence for actual Automerge/Yjs examples. README explicitly excludes key exchange/rotation. It therefore leaves the exact group-key gap the user wants to avoid; beta label is not itself the reason to deprioritize it. Apache2.0.

## Recommended order for the overall comparison

1. Compare actively maintained **complete data+permissions stacks** from the other lanes against the retained-Automerge option. Don't force preserving Automerge if doing so requires assembling an unfinished security platform.
2. Keep **current ARK/Keyhive/Subduction** in the active research shortlist; reuse the existing harness for a short current-graph qualification before doing production adoption work. Architectural fit is high, completeness moderate, native/recovery integration nontrivial.
3. Keep **Willow'25/Meadowcap** as a promising lower-level substrate with source-verified progress; only a full implementation changes it into a small adoption effort.
4. Use **UCAN** to assess authority models or a framework already shipping it, rather than as proof that a naked database+capability certificate is a complete household sync system.
5. Keep Matrix as optional durable encrypted messaging transport evidence, not the presumptive database solution.

## Source inventory and evidence limitations

Primary files were inspected from exact shallow clones in `/workspace/work/capability-repos`, including current Codeberg implementation. Prior test evidence is `/workspace/work/security-transport.md` and its referenced current-head CI artifacts. The narrow current ARK Node/WASM12-probe run is described above. No new app/native/network-runtime test, audit, deployment or complete current-stack qualification is claimed. Repository dates, manifests and TODOs are source evidence, not operational assurances. Main app was not edited.
