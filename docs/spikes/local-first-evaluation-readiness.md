# Local-first sync — pre-evaluation readiness

**Research snapshot: 12 October 2026. WITHHOLD final production stack selection. DO NOT MERGE this or other research PRs.**

Umbrella: [issue #36](https://github.com/0cwa/creative-cooking/issues/36). Isolated readiness branch: spike/local-first-evaluation-readiness, created directly from unmodified main at a1c8993c4f45e9bb8de2b18d4f644088df99845a. The machine-readable source inventory, candidate matrix, twelve hard gates, risks and remaining tests are in [evidence-inventory.json](../../spikes/evaluation-readiness/evidence-inventory.json). These are *frozen observations*, not live status polling. Refresh all PR heads and CI before a final evaluation.

## 1. Executive readiness assessment

The project has enough executable results to build a credible *conditional research roadmap*, but **not enough to select a secure, maintainable, production-ready web + iOS + Android device-sync stack**. Application CRDT, transport/persistence, identity/E2EE/ACL, app integration, and operations are independent decisions.

- **Both application-engine JS candidates pass** 18/18 common merge scenarios. The independent Merge Analyzer passes 13/13 per engine including real 4-versus-6 scalar disagreements, later causal 5 resolution, duplicate/out-of-order edits, silent compatible merges, stable-ID pantry duplicates and retained review evidence. Web/static-browser viability also passed. These are concrete *web/Node* results, not full platform proof.
- **Native evidence remains incomplete.** Automerge Swift/iOS Simulator has real JS↔Swift binary and SyncState interoperability plus 18/18 native scenarios. The newest Automerge C/JNI follow-up **FAILS** after eight passed host scenarios: the ninth expected “cherry tomatoes” but found “red tomatoes” (latest experimental job 114612571545). Java 0.0.9 ↔ JS 3.5 direct SyncState already failed and Android *Expo device execution* remains unproved. Loro published RN binding launched and performed part of an iOS run, and an ARM64 Android APK compiled; complete web↔native convergence and true native process restart depend on its latest runtime JSON plus web-verification JSON, which were still pending at inventory capture.
- **One actual engine-plus-transport byte path is proven independently:** PR #40 moved genuine *incremental Automerge* binaries encrypted with disposable fixture AES-GCM through two real Chromium Subduction WASM peers, WebSocket, persistent Rust redb relay restart and late HTTP long-poll catch-up. This is **not Keyhive/ARK E2EE, authorization or household ACL**: the server explicitly runs with open test auth.
- **p2panda/Iroh does not yet integrate either application engine.** A real three-process same-host persistent third Rust replica delivered byte-identical random data after late return, and a distinct browser WebCrypto/HTTP ciphertext mailbox did too; these are disjoint tests. Online Iroh relays themselves **do not** provide durable store-and-forward. The p2panda iOS Rust target is blocked by netdev/libc; Android cargo check is not a working app.
- **Shipping security hard gates fail.** Subduction upstream says not for production, Keyhive is pre-alpha and unaudited, and ARK is alpha. Known inspected policy concerns include legacy unprotected-ID bypass and a missing forwarding requester Relay check. No real end-to-end no-key relay, verified pairing, read/edit/admin delegation, adversarial denied writer, revocation or future-key-rotation proof exists. Never infer absence of problems from a successful unprotected ciphertext fixture.

The ultimate product is a *cooking assistant*, not inventory administration: no account or sync service required for indefinite local offline use, no mandatory inventory fields and no blocking review for compatible edits. Sharing personal and household spaces must be optional. The current experiment changes no app state, persistence, backup, credential, screen or normal CI/Pages files.

## 2. Versioned evidence inventory (exact source heads and runs)

| Draft PR and latest report | Pinned head SHA | Last normal CI / experimental Actions | Executable strength and caveat |
| --- | --- | --- | --- |
| [#37 Automerge](https://github.com/0cwa/creative-cooking/pull/37), [report](https://github.com/0cwa/creative-cooking/blob/spike/local-first-automerge/docs/spikes/local-first-automerge.md) | f494db6e74087afff54ace956cf287d60bb3252c | [CI PASS 38187390329](https://github.com/0cwa/creative-cooking/actions/runs/38187390329); [spike FAIL 38187390144](https://github.com/0cwa/creative-cooking/actions/runs/38187390144) | Web/iOS real runtime PASS; new JNI test FAIL, Android Expo runtime NOT TESTED |
| [#38 Loro](https://github.com/0cwa/creative-cooking/pull/38), [report](https://github.com/0cwa/creative-cooking/blob/spike/local-first-loro/docs/spikes/local-first-loro.md) | 0bdf202505e68080803e63bd4e50a9c81c813772 | [CI PASS 38187581329](https://github.com/0cwa/creative-cooking/actions/runs/38187581329); [native PENDING 38187581383](https://github.com/0cwa/creative-cooking/actions/runs/38187581383) | Web PASS, Android ARM64 compile PASS, full native binary roundtrip pending |
| [#39 p2panda/Iroh](https://github.com/0cwa/creative-cooking/pull/39), [report](https://github.com/0cwa/creative-cooking/blob/spike/local-first-p2panda/docs/spikes/local-first-p2panda.md) | 3567a1f297a1826deec5f52ed9c39a439a36e393 | [CI PASS 38183965328](https://github.com/0cwa/creative-cooking/actions/runs/38183965328); [spike PASS 38183965313](https://github.com/0cwa/creative-cooking/actions/runs/38183965313) | Native third replica persists **random** frames; browser mailbox a separate non-p2panda proof |
| [#40 Subduction/Keyhive](https://github.com/0cwa/creative-cooking/pull/40), [report](https://github.com/0cwa/creative-cooking/blob/spike/local-first-subduction-keyhive/docs/spikes/local-first-subduction-keyhive.md) | 519a6c4a7766c67dde4896cba7537d9d1df15b1e | [CI PASS 38184052069](https://github.com/0cwa/creative-cooking/actions/runs/38184052069); [spike PASS 38184052071](https://github.com/0cwa/creative-cooking/actions/runs/38184052071) | Actual Automerge change transport/relay recovery PASS; **fixture-only AES and open auth, NOT ARK** |
| [#41 Merge Analyzer](https://github.com/0cwa/creative-cooking/pull/41), [report](https://github.com/0cwa/creative-cooking/blob/spike/local-first-merge-evidence/docs/spikes/local-first-merge-evidence.md) | b013b64e51a4f5bfe382ba2acd67e7f5f571ac54 | [CI PASS 38186593573](https://github.com/0cwa/creative-cooking/actions/runs/38186593573); [13/13 each PASS 38186593589](https://github.com/0cwa/creative-cooking/actions/runs/38186593589) | Stable event evidence, retention policy; native review index NOT TESTED |
| [#42 matched benchmark](https://github.com/0cwa/creative-cooking/pull/42), [report](https://github.com/0cwa/creative-cooking/blob/spike/local-first-benchmark-parity/docs/spikes/local-first-comparison-benchmarks.md) | 4add471c51eda06ff6c03d20cd5104c292be05b4 | [CI PASS 38187827555](https://github.com/0cwa/creative-cooking/actions/runs/38187827555); [benchmark PASS 38187827563](https://github.com/0cwa/creative-cooking/actions/runs/38187827563) | Five matched Node samples and real Expo Chromium PWA assets; native timings unqualified |

All six PRs are **draft and unmerged**. Main SHA above retained [CI PASS 35992984449](https://github.com/0cwa/creative-cooking/actions/runs/35992984449) and [Pages PASS 35992984724](https://github.com/0cwa/creative-cooking/actions/runs/35992984724). The inventory was frozen while #37's latest experimental run failed and #38's was pending. Never reinterpret these conclusions if another agent pushes a new SHA: capture fresh head, run ID, status, platform and artifact together.

**Exactly which artifacts to inspect:**

- Automerge: [older PASS iOS Swift artifact 11708535039 / run 38153998808](https://github.com/0cwa/creative-cooking/actions/runs/38153998808/artifacts/11708535039), [new Swift artifact 11720507510](https://github.com/0cwa/creative-cooking/actions/runs/38187390144/artifacts/11720507510), [failing C/JNI artifact 11720108131](https://github.com/0cwa/creative-cooking/actions/runs/38187390144/artifacts/11720108131), [Android compile artifact 11720167527](https://github.com/0cwa/creative-cooking/actions/runs/38187390144/artifacts/11720167527), [failing job log](https://github.com/0cwa/creative-cooking/actions/runs/38187390144/job/114612571545). This log documents eight host JNI cases PASS followed by a real cooking-value mismatch, not an infrastructure-only failure.
- Loro: [current head web artifact 11719444311](https://github.com/0cwa/creative-cooking/actions/runs/38187581383/artifacts/11719444311), [prior failing iOS runtime artifact 11708655956](https://github.com/0cwa/creative-cooking/actions/runs/38154451810/artifacts/11708655956), and the actual pending iOS / ARM64 Android result plus web-verification pair if later uploaded. Compile logs do not satisfy that pair.
- p2panda: [three-process persistent third peer PASS run 38183369333](https://github.com/0cwa/creative-cooking/actions/runs/38183369333); [Chromium ciphertext mailbox PASS run 38183837293](https://github.com/0cwa/creative-cooking/actions/runs/38183837293). Current head experimental run uploaded no separate artifact in the frozen view.
- Subduction: [real Automerge browser WebSocket/redb-restart/HTTP test PASS run 38183684382](https://github.com/0cwa/creative-cooking/actions/runs/38183684382); [current head 38184052071](https://github.com/0cwa/creative-cooking/actions/runs/38184052071). Evidence is in the actual scenario/Playwright logs; no downloadable current-head artifact was returned.
- Merge Analyzer: [Node scenario event ledger, checkpoint and benchmark artifact 11719467915](https://github.com/0cwa/creative-cooking/actions/runs/38186593589/artifacts/11719467915).
- Neutral benchmark: [matched Node JSON/CSV artifact 11719724009](https://github.com/0cwa/creative-cooking/actions/runs/38187827563/artifacts/11719724009) and [real Expo static Chromium artifact 11719939129](https://github.com/0cwa/creative-cooking/actions/runs/38187827563/artifacts/11719939129). Previous detailed passing benchmark [run 38187392524](https://github.com/0cwa/creative-cooking/actions/runs/38187392524) documents warm SyncState retransmission.
 
**Versions/pins:** Automerge JS 3.5.0, Swift 0.7.2, Java/Android 0.0.9, Rust 0.12.0 and automerge-c 0.2.2. Loro JS 1.16.4, published RN 1.10.3, newer RN source head 8fad8d61c11c23e7c57999533d637d316465ffc1. p2panda =0.7.1 / Iroh 1.0.3 (the p2panda spike **does not have a transitive Cargo.lock**). Subduction exact upstream f0af1aab5f2fd44e5b224c22fc8b62660d50bc01; Keyhive b7968be799705492428c94226ca28042c733a9e0; ARK 5d09e8c8cfdebd5656b1426b66aea6b1395f83da. ARK references an Automerge/Subduction bridge 0.16.1 versus inspected head bridge 0.19.0. Do not assume package/wire compatibility. Native source commit pin and npm publication version are distinct kinds of evidence.

## 3. Cross-stack compatibility/dependency matrix

| Pair | Real engine binary through stated substrate | Separate components / platform | Exact missing proof / production |
| --- | --- | --- | --- |
| **Automerge + p2panda/Iroh** | **NOT TESTED** | Automerge engine JS/iOS PASS; p2panda opaque **random** frames PASS | Actual Automerge change PWA↔native p2panda API; authorized durable encrypted catch-up, iOS netdev fix, Android app; shipping **NOT READY** |
| **Loro + p2panda/Iroh** | **NOT TESTED** | Loro JS engine PASS; p2panda native random bytes PASS | Actual Loro updates across p2panda browser-native link, Loro RN binary qualification, encrypted store; shipping **NOT READY** |
| **Automerge + Subduction/Keyhive** | **PASS for unprotected Subduction fixture ONLY** | Actual JS Automerge incremental changes ↔ Chromium Subduction WASM ↔ Rust CLI redb, offline late catch-up PASS in #40 | Live **Keyhive/ARK E2EE, ACL, delegation and mobile Expo** NOT TESTED; upstream production warnings; shipping **NOT READY** |
| **Loro + Subduction/Keyhive** | **NOT TESTED at source freeze** | Loro and Subduction separately PASS; new Loro→Subduction smoke is created on this branch | If smoke passes, only **plain opaque-byte Subduction** upgraded. ARK helper integration is Automerge-specific, so Loro protected doc/key adapter needs new design; shipping **NOT READY** |

**Classification discipline:** all four opaque-byte interfaces are architecturally plausible, not proved interoperable merely because upstream sends bytes. No fundamental opaque-array *engine incompatibility* is demonstrated. Conversely the bundled ARK convenience model is Automerge-centric: this is a non-drop-in **integration/security** requirement for Loro, not proof that Loro binary changes cannot traverse Subduction. A Rust compile is not an Expo iOS/Android runtime. A toy plaintext mailbox is not authorized durable E2EE.

## 4. Engine-neutral opaque-update boundary

Executable [boundary.mjs](../../spikes/evaluation-readiness/boundary.mjs), [boundary.test.mjs](../../spikes/evaluation-readiness/boundary.test.mjs) and [fixtures.mjs](../../spikes/evaluation-readiness/fixtures.mjs) define a bounded *research* envelope:

| Field | Semantics |
| --- | --- |
| schemaVersion | Explicit envelope evolution (currently 1) |
| engine | automerge or loro; fail closed on wrong-engine import |
| spaceId | Stable logical personal/household namespace; security scope must later bind to authenticated grants |
| documentId | Stable recipe/pantry/chat record; prevents cross-document replay |
| id | SHA-256 identity over header, dependencies and payload digest, not an authorization signature |
| payloadSha256 | Digest of exact bytes for integrity and idempotency, not cryptographic identity/authentication |
| dependencies | Opaque **envelope** parent IDs for causal scheduling and missing-parent requests; not invented engine-internal actor/history IDs |
| bytes, byteLength | Bounded Uint8Array opaque engine update or encrypted ciphertext envelope; max 4 MiB in this prototype |

Receiver validates engine, space, document, size, digest, envelope ID and dependencies **before** import; buffers missing-envelope predecessors; duplicate update replay is idempotent. Actual Automerge change hashes/actors and Loro peers/version vectors remain engine-internal, distinct from transport user/device identities, signing keys and encryption material. Use real native import to resolve internal engine causal dependencies; never invent universal CRDT operation identities.

**Session versus persistent state:** document changes and persistent replay frontier/checkpoint survive app and relay restarts; peer-specific SyncState messages, reconnect tokens, WebSocket sessions, ack round trips and retry/backoff are separate ephemeral session state. Rebuild a fresh sync session using durable authenticated heads/version vectors after crash/restart. A transport receipt is **not** an atomic persisted CRDT engine commit: before production, test a transactional WAL, crash after byte write before engine import, crash after import before ack, and crash after review index change. Never compact away unresolved review evidence or pending parents.

**Credentials:** existing PersistedState includes settings such as model/provider, allergies and meal context; provider credentials live in a separate vault. Do *not* replicate entire JSON PersistedState and hope encryption makes leakage okay. The contract's explicit field allowlist uses synthetic secret sentinels, includes selected stable-ID pantry/recipe data, excludes unknown fields/settings/device credentials, and excludes personal chat from shared-household scope. This is a **test illustration only**, not a final product policy, app adapter or security proof. Decide deliberately whether pantry preference, chats, allergies and context stay private. Make read/write scopes separate, deny unknown fields, and audit backup/restore migration similarly.

The research envelope SHA-256 identifies content, not a sender. Authenticate sender, object/space keys, version, dependency commitments and encryption associated data with a real audited protocol **before** accepting untrusted updates; static digests and local fixture AES-GCM cannot accomplish that.

## 5. New bounded composability proof

The isolated [Subduction browser spec](../../spikes/evaluation-readiness/subduction-composability.spec.ts.template), pinned [workflow](../../.github/workflows/local-first-evaluation-readiness.yml), [genuine binary fixture generator/verifier](../../spikes/evaluation-readiness/fixtures.mjs) and local [evidence audit](../../spikes/evaluation-readiness/audit-evidence.mjs) are confined to this PR.

Fixture for **each engine**: actual binary seed update makes a tomato-toast recipe with portions=2 and chickpeas pantry item; two disconnected replicas write portions=4 and portions=6 (separate true CRDT incremental updates); a later replica merges both and writes portions=5 causally after seeing both. Each update is separately encrypted with disposable test AES-256-GCM, and its plaintext and ciphertext SHA/length recorded. No real provider keys or persisted app state are read. **Never commit generated fixtureKeyHex** or claim this is deployed E2EE.

The test uses actual pinned upstream Chromium **Subduction** WASM clients, WebCryptoSigner, MemoryStorage, connectDiscover/connectDiscoverLongPoll, SedimentreeId, CommitId, addCommit/syncWithPeer/getBlobs; a real pinned Rust subduction_cli server with open test auth and on-disk redb, separate Sedimentree IDs for the two engine fixtures, WebSocket publisher and consumer, plus a third independent HTTP long-poll browser. Required scenario:
1. Publish base, observe B's exact ciphertext.
2. Disconnect B. A publishes BOTH concurrent edits, then A disconnects. Stop the actual CLI and restart it with **unchanged signer and redb data**. B alone reconnects late, retrieves exact original ciphertext bytes, reimports real engine binaries and recovers both alternatives (4/6) after full save/load.
3. Reconnect A, publish causal 5 update, and prove real engine state converges to 5 with prior operation/history evidence still available. Duplicate upload and idle sync cannot increase stored objects.
4. Third fresh HTTP client catches up, decrypts and reimports all changes. Scan relay storage for known cooking plaintext sentinels.

**First attempt #38188967921 (2026-10-12):** contract, Rust/WASM builds and binary fixture generation **PASS**; Playwright did **not execute** because upstream webServer could not find the http-server command (exit 127). This is a harness setup failure, **not an engine pass/fail**. Workflow is amended to install pinned http-server@14.1.1 as the upstream #40 passing workflow does.

**Evidence status until a real green Actions job and result artifact:** **NOT TESTED on this new branch.** A passing local contract test does not upgrade the Subduction integration, and existing #40 Automerge PASS does not stand in for this independent Loro run. If successful, its result is a bounded **plain Subduction opaque-byte composability PASS for both JS engines**, not a complete Keyhive/ARK or actual mobile app PASS. A failed job will remain FAIL with exact failed assertion.

Workflow is independent from main CI and Pages and must upload a real **local-first-evaluation-composability** artifact containing artifacts/evaluation-readiness/subduction-composability.json when successful. If absent, the final evaluator must leave its status unproven.

## 6. Factual CRDT performance and review scorecard

| Criterion | Automerge | Loro | Non-equivalent or open qualification |
| --- | --- | --- | --- |
| Web logical semantics | **PASS 18/18** | **PASS 18/18** | Tests exercise stable IDs, text, ordered edits, duplicates, scalar concurrency |
| Web derived review/history | **PASS 13/13**; first-class getConflicts on scalar paths | **PASS 13/13**; public history + indexed reconstruction | Both require app-level semantic event/review activity index |
| Ordinary full snapshot after unresolved disagreement | **PASS** preserves 4/6 | **PASS** preserves 4/6 | Loro destructive shallow trim loses losing-write evidence unless checkpointed |
| iOS simulator web/native binary interoperability | **PASS** Swift binding | **PARTIAL** older native binding executes then assertion fails; new V2 complete result pending | Neither result alone is a deployed production Expo app adapter |
| Android native app roundtrip | **PARTIAL** compile/current Rust JNI bridge; newest JNI host failure; Java live protocol mismatch | **PARTIAL** ARM64 APK compiled with native .so, real emulator/device result pending | Actual Android device, process relaunch, history API parity needed |
| Static Expo Chromium | **PASS** with engine WASM bundle | **PASS** with explicit WASM copying | Benchmark controls do not prove installed service-worker offline shell |
| Matched Node performance | **PARTIAL** five-sample benchmark | **PARTIAL** same logical trace | Distinguish initial bootstrap, first warm SyncState, established session, raw changes, cold load, full view |
| Transport/pairing/security maturity | **NOT TESTED** from engine suite | **NOT TESTED** from engine suite | Independent decisions and production hard gates |

Benchmark #42 exercises a matching logical 200 pantry / 500 recipes (2,500 ingredients and 2,000 steps) / 100 conversations (2,000 messages) trace, checks projections and records raw byte counts and Node times. **Do not compare** the first Automerge SyncState warm exchange's history-sized retransmission with Loro's much smaller version-vector delta as if both were the same boundary. #42 separately measures established session and raw incremental changes. Native release startup, memory, app-size deltas, battery and long-running background cost are **not equivalent measurements** and must remain unranked.

UX: merge disjoint edits silently. Preserve real portions 4/6 and permit causal 5 later without a blocking prompt. Deletes vs concurrent edits and two independent carrot IDs/preferences need *application* semantic review, not scalar conflicts. A user-local dismissal is not a replicated resolution; stable fingerprints and a trusted review checkpoint must survive reconnect/crashes. Avoid showing administrative sync/CRDT machinery in normal cooking flows.

## 7. Security, privacy, offline and recovery hard gates

The machine [hard-gate matrix](../../spikes/evaluation-readiness/evidence-inventory.json) assigns owner and PASS/PARTIAL/FAIL/NOT TESTED for twelve requirements. Below is the actionable verification plan, deliberately separating component results and security proof.

| Threat/recovery scenario | Current readiness | Acceptance experiment / owner |
| --- | --- | --- |
| Provider and device-only credentials never travel | **PARTIAL**; main credential vault and research synthetic whitelist | Check real app packet/snapshot/backup/relay after mutation on all platforms, malicious unknown-field injection; **app/security** |
| Personal vs household document/key namespace isolation | **NOT TESTED** | Two households, private personal space, unauthenticated cross-space replay, read/forward denied; **security/app** |
| Identity/accountless new-device pairing | **NOT TESTED** | Verified signed identity, QR challenge expiry/replay, fingerprint confirmation, no cloud account needed locally; **security** |
| Unauthorized read/write/forwarding denied | **FAIL** as shipping gate | Replace open auth; protected-ID ingress only; detect legacy document bypass and forwarding requester permission gap; no-key fetch and forged writes denied; **security/upstream** |
| Household relay/read/edit/admin grant and delegation | **NOT TESTED** | Version-matched Keyhive/ARK or independently qualified Spaces end-to-end negative role matrix; **security** |
| Revoked device, future-key rotation and offline stale writes | **NOT TESTED** | Correctly remove access to future ciphertext, refuse queued/rejoined unauthorized writes, explicit old-key/past-data limits; **security** |
| Indefinite offline state and delayed catch-up | **PARTIAL** | Current main offline app and Node engine tests PASS; actual web/iOS/Android crash/reconnect with both peers disappearing still needed; **native/replication** |
| Device loss, keys, backup/restore, schema migrations | **NOT TESTED** | Legacy versioned JSON restore → replicated state, encrypted key recovery, atomic review ledger checkpoint and rollback; **app/security** |
| Relay operator metadata and plaintext visibility | **PARTIAL** | Test-only Subduction ciphertext known sentinels absent; prove real relay has no E2EE document key, inspect identities/sizes/timing/space IDs exposed; **security/ops** |
| Durable persistent relay ciphertext (not cooking plaintext) | **PARTIAL** | Subduction AES test fixture PASS; p2panda Rust third peer saw plaintext test payload; prove production authorized ciphertext store/recovery; **replication/security** |
| Version skew and reconnect after upgrades | **NOT TESTED** | Old PWA service worker/WASM, iOS/Android native changes, ARK bridge protocol, migrations and staged redb rollback; **ops/platform** |
| Maintainable audited production service | **FAIL** | Upstream maturity, crypto audit, TLS, persistent signer, full backup, quotas/abuse control/monitoring, restored relay behavior; **security/ops** |

**Frozen gate status:** G01/G02/G03/G08/G09 PARTIAL; G04/G05/G07/G10/G11 NOT TESTED; G06 (denied unauthorized access) and G12 (maturity/operability) FAIL. This describes acceptability **now**, not irreversible incompatibility with every library.

A relay that sees ciphertext may still see peer identities, namespaces, sizes, timings and access patterns. Scanning for three strings is not a cryptographic security proof. For revocation, no system can take back already obtained plaintext or old keys; qualify future-write/future-key safety explicitly and explain it to users.

## 8. Cost of ownership and operations

Relative complexity below is an **architectural estimate**, not measured engineer-days, cloud quotes or engine scoring.

| Candidate | Web/native bridges and upgrades Creative Cooking owns | Persistence/server and security ownership |
| --- | --- | --- |
| Automerge + p2panda | Web Automerge; Swift integration and compatible/current-core Android bridge (Java 0.0.9 live sync unsuitable); p2panda native FFI with iOS blocker plus browser-native gateway; maintain dual versions | Native always-available third replica or NEW durable service; Iroh relay not durable; Spaces audits, membership/recovery, persistent encryption and quotas |
| Loro + p2panda | Loro WASM/static assets and history checkpoints; RN 1.10.3 old native artifacts or rebuilt source, ABI/lifecycle; p2panda native+iOS/browser bridge | Same independent persistent service, unaudited Spaces security, version/key policy, extensive dual-stack upgrades |
| Automerge + Subduction | Web Subduction WASM plus real Expo iOS/Android binding/current Automerge core; ARK version matching and protected document IDs | Operate stateful Subduction CLI: stable signer, redb, content-addressed blobs, Keyhive state, TLS/WSS/HTTPS, backups, quotas, monitoring, ACL hardening, audit |
| Loro + Subduction | Loro web/RN plus Subduction WASM/native FFI, native history and compaction checkpoint; ARK Automerge-oriented helper cannot just be plugged into Loro | Same Subduction server and new secure Loro document/key envelope/ACL integration; key recovery, roles, upgrades and audit still owned |

**Licensing and compliance (primary source repositories, not a full software bill of materials):** inspected Automerge engine/bindings and Loro bindings are MIT-licensed; p2panda, Iroh and Subduction are Apache-2.0/MIT dual-licensed, while Keyhive is Apache-2.0. The inspected ARK release and transitive dependencies have **not** received a complete license/SBOM audit; generated native binary distributions may pull other licenses. Before production selection, enumerate exact resolved transitive versions (especially p2panda without a lockfile), native build tools, generated assets, notice requirements and compatibility with Creative Cooking's distribution. Licensing alone does not qualify upstream security maturity.

Every stack also requires stable per-entity replicated schema (not replacing array-shaped PersistedState blindly), offline-first dispatch, local binary persistence on IndexedDB and native stores, schema/backups migration, crash-safe review ledger, key vault separation, invitation UI, backoff respecting background mobile lifecycle, and painless unlink/recovery. The static GitHub Pages frontend may remain static; durable optional sync needs extra infrastructure. Subduction's full data directory, redb, external blobs, Keyhive events and signing key must be backed up and restored as a consistent unit, and TLS/host monitoring/abuse control is not optional for a public service.

The Loro #38 report contains an approximate 1–3 engineer-days for a limited published-native-binding app boundary, plus 2–4 days for history/review indexing, and more if rebuilding native binaries. These **are author rough estimates**, not equivalent all-in cost measurements for any stack. No actual release app-size differential, native device power/CPU, server capacity or production cryptographic audit cost has been measured. Keep these NOT TESTED, do not fabricate prices.

## 9. Prioritized decision-reversing experiments

1. **Very high information value / medium execution cost:** Finish #37/#38 real iOS+Android qualified native runs. Fix #37 latest reproducible JNI assertion first; require true Android ARM64 Expo module execution, process kill/relaunch, bytes via web and retained original review metadata. Re-evaluate engine viability only from pinned actual artifacts.
2. **Very high value / high cost:** Independent, adversarial authenticated household pairing/role/key rotation E2E. Protected IDs only; Relay/read/edit/admin negative cases, forged sender, legacy bypass, stale relay, unauthorized forwarding, revoke offline device, later rejoin with old keys. Check upstream production warnings and external security review before adoption.
3. **High value / high cost:** Real browser↔native substrate path with actual CRDT updates, encrypted persisted third peer/server and disconnected senders, physical LAN or cross-network fallback. p2panda iOS blocker and browser gateway; Subduction native bridge plus coherent protected namespace. No plaintext demonstration substituted.
4. **High value / medium cost:** Device-loss restored replicated snapshot plus old v1 JSON backup migration and review checkpoint retention, atomic commit crash cut points, provider-secret leak sentinels.
5. **Medium value / medium cost:** Multi-version protocol/skew plus deployed TLS relay backup/restore/quotas/abuse and latency/battery on representative mobile, with service-worker cache/upgrade behavior.

Do not repeat the web semantic suite from scratch or force four whole mobile stacks solely to fill the grid; only tests capable of reversing the evaluator's decision justify priority.

## 10. Reproduction and final evaluator handoff

The new isolated harness requires Node 22.13+ and pins both published web engines in its own npm lockfile; it never adds a production dependency. From the branch checkout:

~~~sh
cd spikes/evaluation-readiness
npm ci --no-audit --no-fund
node --test boundary.test.mjs
node audit-evidence.mjs
node fixtures.mjs generate artifacts/fixtures.json
# Disposable test-only AES key in generated fixtures: never commit it.
~~~

The [dedicated experimental workflow](../../.github/workflows/local-first-evaluation-readiness.yml) runs boundary tests and the evidence linter, checks out exactly upstream Subduction f0af1aab5f2fd44e5b224c22fc8b62660d50bc01, uses Rust 1.91.0 + wasm-pack 0.14.0, Node 22.13.0, pnpm 9, builds a live Rust subduction_cli and its WASM browser client, generates both real-engine change streams, then executes evaluation-readiness.spec.ts in the pinned upstream Playwright Chromium harness. On success it uploads **local-first-evaluation-composability** with artifacts/evaluation-readiness/subduction-composability.json and actual wire byte SHA/lengths, replay and conflict conclusions. A queued, failed or artifact-less job **cannot** be labeled PASS.

Reproduce other experiments **on their own draft branch**, never cherry-pick into this one:
- #37 Automerge: follow report's web 18-case and Swift iOS tests, and newest C/JNI Android qualification; distinguish Java protocol failure and failed host assertion.
- #38 Loro: execute report's V2 native log parser and web-verification check against **real** iOS/Android result files; Android x86_64 runtime not supported by shipped binary.
- #39 p2panda/Iroh: native 3-process SQLite catchup and separate encrypted HTTP mailbox, not a single browser↔native p2panda test.
- #40 Subduction: pinned WS/redb/HTTP browser experiment using real Automerge bytes, keep fixture AES/--auth open labels; read auth policy source and upstream warnings.
- #41 Merge Analyzer: on its own branch run npm ci, npm test, npm run benchmark under spikes/merge-evidence; inspect original event ledger artifact.
- #42 benchmark: on its own branch use its exact workload/trace JSON, five-trial medians, parity checker and Chromium static assets; do not compare unmatched older PR timings.

**The final evaluator must read the exact six source reports, SHAs, logs/artifacts above and this PR's experiment artifact if actually produced.** Grade separately engine semantics, real engine/substrate API, web/iOS/Android runtime, security/ACL, reliability/offline, review UX, ownership and maturity, with explicit PASS / PARTIAL / FAIL / NOT TESTED and confidence. **Do not select the final production stack until native and security hard gates close.** A conditional research shortlist and explicit next experiments are fine. Main must stay green; all research PRs stay draft and unmerged.
