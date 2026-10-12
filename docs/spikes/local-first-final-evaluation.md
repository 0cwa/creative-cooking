# Creative Cooking stack feasibility decision

Decision date: 12 October 2026. Research only; linked to [issue #36](https://github.com/0cwa/creative-cooking/issues/36). Keep all spike PRs draft and unmerged. Production main remains `a1c8993c4f45e9bb8de2b18d4f644088df99845a`.

## Decision

**Retain Expo, React Native and the static PWA. Prefer Automerge provisionally for the first local replicated-data adapter; keep Loro as the credible alternative until the Android smoke test settles. Defer adopting either evaluated household-sync security stack.** The present evidence supports this staged architecture decision, but does not qualify an unconditional web/iOS/Android secure-sync rollout.

Automerge has useful native conflict evidence, interoperable Swift support and favorable full-view/edit behavior in the shared Node fixture. Loro has actual Expo iOS execution, a small reproducible JavaScript compatibility fix and fast snapshot decode. Neither is an established Android app-runtime winner. The independent evaluator supports the Automerge preference for a web-first stage and withholds a cross-platform winner pending required-native integration. This is an engineering judgment from functionality and ownership, not a weighted performance score or measured mobile victory.

If secure household sharing across all three platforms must ship immediately, **WITHHOLD selection of every complete candidate**. Current ARK/Keyhive has executed authorization/revocation failures; Spaces lacks end-to-end qualification; Subduction has an observed durability counterexample. These findings are sufficient to stop those shipping paths without writing a complete replacement service.

The attachment concerns local-first synchronization. The separate local-model bake-off [#35](https://github.com/0cwa/creative-cooking/pull/35) remains a harness rather than measured model/device selection; this evaluation does not choose a local LLM or justify changing the LLM adapter architecture.

## What changed since the earlier handoff

| Research lane | Current substantive evidence | Closeout |
| --- | --- | --- |
| [#37 Automerge](https://github.com/0cwa/creative-cooking/pull/37) | Previous JNI seed contamination regression now passes 17 host scenarios with real JS/current-Rust SyncState. Swift/iOS engine evidence remains valid. Native contract still has missing text/reorder cases. Expo APK Gradle build succeeded; registration guard inspected the wrong generated directory. | Guard corrected in `505b91e`; one new Android attempt running. Host PASS is not Android PASS. |
| [#38 Loro](https://github.com/0cwa/creative-cooking/pull/38) | Actual iOS Simulator native run and web verifier pass 16 checks including false/0/empty/nested values with exact published `1.10.3+falsy-compat` adapter. Original convenience-wrapper defects remain documented. | Emulator installation ordering corrected in `0aa857c`; next attempt stops on missing host `libpulse.so.0` before Android execution. User has no ARM64 runner: park Android qualification and stop TCG retries. Published package lacks x86_64 native archive. |
| [#39 p2panda/Iroh](https://github.com/0cwa/creative-cooking/pull/39) | Real signed CRDT transport, persistent Spaces ciphertext/keyless replica evidence and Android x86_64 JNI execution. JNI result explicitly excludes Expo and physical ARM64. | Feasibility closed; browser/mobile/ACL ownership remains too large for immediate adoption. Iroh relay alone is not durable storage. |
| [#40 Subduction/Keyhive](https://github.com/0cwa/creative-cooking/pull/40) | Real `--auth keyhive` signed-wire legacy-ID bypass; requester policy bypass; genuine unauthorized signed revocation accepted by pinned old core and denied by newer official core. Independent core crypto 5/5 passes. | Reject pinned production security path. Positive component tests do not fix the integrated graph. |
| [#41 merge evidence](https://github.com/0cwa/creative-cooking/pull/41) | 13/13 per engine, original disagreements, causal resolution and durable review concept. | Enough for selection; do not build full review UI during feasibility. |
| [#42 parity](https://github.com/0cwa/creative-cooking/pull/42) | Shared fixture, real static Chromium exports, logical checks and separate protocol-session measurements. | Close web/Node performance lane. Native speed comparison waits for working runtimes and only if it could change the choice. |
| [#43 readiness](https://github.com/0cwa/creative-cooking/pull/43) | Both engines' genuine incremental bytes pass opaque Subduction transport/restart. | Reuse; its old native/security inventory is superseded by this audit. |
| [#44 relay operations](https://github.com/0cwa/creative-cooking/pull/44) | Backup/restore, pinned upgrades, TLS/long-poll, fault tests. Real disk-full case returns sync success but loses update after crash; original-client replay restores it. | Ownership feasibility closed. Durable remote receipt is unqualified. |
| [#45 native transport](https://github.com/0cwa/creative-cooking/pull/45) | Successful retry artifact proves actual Expo iOS transport with two PIDs, both-engine browser reimport, 4/6 then 5, relay/client restart and late reader. Android APK and both ABI libraries build; emulator boot times out. | iOS transport PASS supersedes stale PR prose. Native engine execution/security/device-local persistence are separate gates. |
| [#46 migration/recovery](https://github.com/0cwa/creative-cooking/pull/46) | Existing 40/40 suite rerun locally with typecheck PASS. Added real-binary Automerge→Loro→Automerge and reverse baseline handoffs: 2/2 local and exact-head CI PASS. | Published `b6436f7`; normal CI and isolated run `38288196578` PASS. Exit artifact `11763334290` independently inspected. |

Raw artifacts and logs were inspected through the authorized GitHub connector when CLI redirects failed. Exact source heads, PR merge commits where relevant, run IDs, artifact IDs, archive hashes and qualifications are in [the evidence inventory](../../spikes/final-evaluation/evidence-inventory.json). Older frozen benchmark numbers are explicitly distinct from latest-head artifact verification.

## Candidate scorecard

No numeric ranking can compensate for a failed hard gate.

| Candidate | Engine and transport feasibility | Security and operations | Decision and confidence |
| --- | --- | --- | --- |
| Automerge + Subduction/Keyhive | Web engine, Swift interoperability, current-core JNI; browser and Expo iOS opaque transport demonstrated. Custom Android engine/native adapter still required. | Pinned authorization/revocation failures, integrated pairing failure, version skew, upstream production warnings, undurable sync success. | Strongest conditional browser-first research combination; **not production qualified**. High confidence in current exclusion. |
| Loro + Subduction/Keyhive | Web plus patched Expo iOS engine; opaque dual-engine transport. History indexing and native version skew require ownership. | Same transport failures; Automerge-oriented ARK helpers do not prove protected Loro document/key integration. | Credible engine alternative; **not production qualified**. High confidence in current exclusion. |
| Automerge + p2panda/Iroh | Genuine opaque engine bytes, signed native persistence and encrypted group evidence; web/iOS route remains integration work. | Spaces ACL/pairing/recovery not end-to-end qualified; unaudited crypto; durable peer operations; native platform workarounds. | Park for native P2P needs; **not production qualified**. Medium confidence in eventual integration cost. |
| Loro + p2panda/Iroh | Same substrate feasibility plus viable Loro web/iOS engine; more boundary integration remains. | Same independent substrate/security gaps. | Park; **not production qualified**. No demonstrated advantage sufficient to fund four full mobile stacks. |

A simpler authenticated HTTPS/WS service behind the same byte contract is an untested future option. It is not a fifth proven winner; auth, encryption, durable receipts and maintenance still need a separate small spike if hosted sharing becomes necessary.

## Hard gates and their scope

| Gate | Status at evidence freeze | What it means for adoption |
| --- | --- | --- |
| Accountless indefinite offline cooking | PASS in existing app; proposed engine app integration PARTIAL | Retain existing local-first behavior; network failure cannot block cooking. |
| Genuine web/iOS/Android engine interoperability | PARTIAL for both engines | Android proof remains a local-engine selection gate when Android is required. Automerge Swift proof is not an Expo iOS module qualification. |
| Domain convergence and recoverable disagreements | PASS web; native coverage PARTIAL | Stable entity IDs and durable source evidence are required; rendered scalar winner is not consent. |
| Secrets excluded from replicated state/backups | PARTIAL | Existing vault separation plus synthetic allowlists pass; arbitrary free text and full app paths are not comprehensively qualified. |
| Personal/household isolation, verified pairing and authorized read/edit/relay | FAIL for pinned Keyhive policy; NOT QUALIFIED Spaces | Blocks optional secure sharing, not continued standalone local app use. |
| Future-only revocation/key rotation | FAIL pinned signed revocation; PARTIAL newer core/Spaces | Corrected isolated core is not a qualified integrated release. |
| Persistent ciphertext catch-up | PASS bounded paths; durable receipt FAIL observed | Never discard sole local history after transport success. Remote-backup promises require real persisted receipts. |
| Legacy import, history backup, recovery | PASS Node reference; platform atomicity/key recovery PARTIAL | POSIX WAL is not IndexedDB/AsyncStorage power-loss proof; group-key availability flags are not cryptographic recovery. |
| Server version skew, backup and restore | PASS limited pinned cases; full native/security matrix NOT TESTED | Enough to understand ownership; no blanket upgrade guarantee. |
| Security maturity and maintainable shipping service | FAIL/NOT QUALIFIED | Preserve unaudited/pre-alpha/production-warning status even if crypto tests pass. |

All four complete candidates therefore remain withheld for secure production sharing. Engine feasibility, transport feasibility and release approval are independent decisions.

## Performance and maintenance that affect the choice

The common 200-pantry/500-recipe/100-conversation Node fixture shows tradeoffs: frozen snapshot decode medians are Automerge 597.634 ms versus Loro 2.305 ms; full projection 8.869 versus 290.511 ms; field edit 2.510 versus 76.705 ms. These are candidate-adapter measurements, not mobile engine rankings. Do not add marginal medians and call the result measured startup. Lazy visible-screen projection could change app fit.

Web Brotli export deltas differ by only 808 bytes in that probe. Automerge's initial post-bootstrap SyncState exchange retransmits about 370 KB per direction, while the established follow-up is 498/423 bytes. Compare session conditions honestly; neither npm archive size nor one APK is an installed app delta. Browser parity blocked service workers: engine snapshot reload/offline edits passed, but installed-PWA service-worker caching/upgrading of new WASM assets remains an adoption check. No unqualified engine receives a native benchmark score.

Automerge needs a small Expo iOS wrapper over Swift and an owned current-core Android bridge; old Java 0.0.9 direct SyncState is unsuitable against web 3.5. Loro's published RN 1.10.3 needs the verified falsy adapter correction and safe list API usage; official newer source lacks bundled native archives. Both require version pins, history retention and a reproducible upgrade matrix.

Subduction requires signer/redb/external blobs/authorization state, whole-store backups, TLS/DNS, upgrades, monitoring and abuse limits. p2panda requires a persistent third replica for separated uptime and the same basic operational responsibilities. Short same-host runs do not justify monthly pricing, production capacity or battery claims. Maintained dependency/notice review remains an adoption task, not a reason to broaden this feasibility study into an exhaustive audit.

## Reversible adoption contract

Keep the following boundaries small and outside the cooking UI:

1. **Cooking data repository:** stable typed entity IDs, selected personal/household namespace, schema version, reads, domain operations and explicit deletion tombstones. Ordered ingredient/step/message identities must not depend on array position.
2. **Engine backend:** initialize/import, mutate, read projection, export full binary history, incremental update/apply, causal frontier and genuine original alternatives. Keep engine-specific objects, version vectors and SyncState internal.
3. **Transport:** opaque bytes with engine/version, space/doc identity, schema/replication epoch, content digest, dependency hints and idempotency identity. Separate delivery progress from authenticated durable receipts; keep pending local history until the retention policy permits deletion.
4. **Identity/security:** client-held keys, verified grants, pairing, authenticated scope and future-key policy in a separate vault/service. A byte digest does not authenticate a sender or membership.
5. **Recovery/review:** portable logical state plus tombstones/order and immutable source evidence, original engine binary/history/frontier, schema/epoch manifest and nonsecret key references. The existing v1 JSON backup remains supported but cannot alone preserve full CRDT evidence.

The exit drill proves a **baseline cutover**, not cross-engine operation conversion: export validated logical state and review ledger, retain original binaries, seed the other engine with a fresh epoch, persist/reload, and reject old-epoch deltas even after switching back. New target edits work; old source disagreements remain unresolved evidence. Original causal history stays archived and cannot automatically become target-engine causality.

A production cutover must authenticate and atomically persist the new baseline/ledger/epoch, fence old peers, require explicit rebootstrap and offer manual export/review of offline old-epoch edits. Keeping stable IDs preserves domain references, not native operation identity. The synthetic in-process drill does not qualify multi-device cutover security or app-storage atomicity. Never promise a seamless live engine swap.

## Bounded worklanes and finish criteria

Five subagents handled engine qualification, security/transport, data/recovery/exit, operations/performance and independent evaluation. The first four worked in parallel; the evaluator reviewed their substantive findings independently. Existing reports/harnesses were reused. Only two native harness fixes and the small exit drill were added; no production code or deployment changed.

| Worklane | Remaining decision work | Stop rule |
| --- | --- | --- |
| Engine runtime | Consume the one fixed #37/#38 CI attempt. Require actual Expo module/ABI, edit, binary web reimport and process-relaunch evidence. Recipe steps are ordered: require one Automerge step move+edit case unless the first adapter explicitly excludes concurrent recipe ordering. Before iOS adoption, qualify its small Expo Swift wrapper; Swift-only interop is insufficient. | No repeated unsupported ARM emulators. If unavailable, record exact blocker and defer native adoption; do not invent PASS. |
| Performance | Only after both required-target runtimes work and if app fit can reverse the choice: same-device visible-screen readiness/control comparison. | Existing web/Node parity is complete; no broad native benchmark project. |
| Security/transport | None to reject the pinned production paths. Reopen after coherent maintained upstream fixes/audit and one positive protected invitation with keyless late relay plus decisive negative permissions/revocation. | Do not repair or build a full security service inside this feasibility study. |
| Data/recovery | Closed: new #46 normal/isolated CI and baseline-switch artifact verified; retain adoption contract. | Production IndexedDB/native atomicity and authenticated multi-device epoch cutover belong to implementation qualification. |
| Evaluation | Freeze source inventory and conditional recommendation; keep all drafts unmerged. | A precise WITHHOLD for a failed requirement is a completed feasibility finding. |

The final local-engine decision is: prefer Automerge for a web-first stage; before cross-platform adoption require its Android smoke, actual process restart, ordered-step move+edit and small Expo iOS Swift-wrapper execution/restart/web interchange, or choose Loro if its required runtime passes and its adapter/history burden is preferable. If required-target runtime qualification remains unavailable, retain current persistence and the neutral design until supported hardware/upstream bindings resolve the blocker. This avoids a framework rewrite and keeps optional secure sharing independently deferrable.

Future implementation should start with one local repository adapter and legacy import/export behind a feature flag, preserving existing backup/credential/offline behavior. Add opt-in replication only after its separate authenticated security and durability gates pass. Do not merge exploratory spike branches as a production shortcut.
