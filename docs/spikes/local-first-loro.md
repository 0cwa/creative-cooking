# Loro local-first feasibility spike

> Status: executable research spike. Isolated from production AppState/persistence and from the Automerge implementation. **Do not merge this PR.**

## Executive result

The Loro web engine satisfies Creative Cooking's structural merge contract: all 18 common scenarios pass on `loro-crdt@1.16.4`, including text, movable-list reorder+edit, incremental/out-of-order/duplicate updates, restart, three replicas, and same-field disagreement reconstruction.

The critical result is nuanced. Loro Maps expose one LWW winner, but retained Loro history is sufficient to reconstruct both concurrent scalar alternatives, authorship/change IDs, and causality using public `getAllChanges`, `getOpsInChange`, and `cmpFrontiers` APIs. No private API, custom vector clock, or second replicated CRDT was required. This is still not a first-class conflict read: `getOpsInChange` exposes low-level `any[]` operation payloads, and the prototype scans retained history. A production implementation should maintain a derived local review/history index and must preserve unresolved review evidence across compaction.

Native feasibility is weaker. The latest npm publication is `loro-react-native@1.10.3`, while the RN repository head reports 1.13.2 and current Loro/FFI are newer still. The published package is the only drop-in artifact with prebuilt native archives; the source-head git install omits those archives. Expo 57/RN 0.86.3 build integration is demonstrated further than runtime interoperability, so compile support and actual runtime support are reported separately.

## Scope and fairness

The branch was created directly from Creative Cooking `main` at `a1c8993c4f45e9bb8de2b18d4f644088df99845a`. It does not modify production AppState, IndexedDB, AsyncStorage, backup format, provider credentials, or production UI. PR #37 was not used as an implementation source or base. Its benchmark fixture was inspected only to confirm the requested common logical shape.

The Loro experiment uses stable logical entity IDs, scalar Map fields, explicit ordered ID collections, and LoroText for method prose. Mergeable containers are tested separately so the comparison does not depend on a Loro-only schema.

Umbrella issue: #36. Draft PR: #38.

## Exact upstream/version pins

| Component | Exact input | Notes |
|---|---|---|
| Loro JS/WASM | `loro-crdt@1.16.4`; initially inspected at `loro-dev/loro@c00c9fa501f8d32f68d6255eacb7035a67fb6ab6` | Executable web tests use the published 1.16.4 package. |
| Current Loro source recheck | `loro-dev/loro@4f60d921d820de3522624a436de77f994a6622b8` | Rechecked 2026-10-11; package remains 1.16.4. |
| RN source head | `loro-dev/loro-react-native@8fad8d61c11c23e7c57999533d637d316465ffc1`, metadata 1.13.2 | Upstream dev matrix is RN 0.79.2 / React 19.0.0. |
| RN npm publication | `loro-react-native@1.10.3`, release commit `509d436255fe21e89ba36bd1ee5fb5873a7e7ae0` | Latest npm version observed 2026-10-11; release uses Loro/Loro FFI 1.10.3. |
| RN source-head FFI | `loro-ffi = 1.13.7` | Read from upstream RN source. |
| Current Loro FFI | `loro-dev/loro-ffi@0d215246d52540147edea7d38d3e50ceabbe017e`, release 1.16.2 | Current FFI is newer than RN source and npm binding. |
| Creative Cooking | Expo ~57.0.17, RN 0.86.3, React 19.2.3, Node 22.13+ | Existing constraints retained. |

Loro and loro-react-native are MIT licensed.

## Common test contract

Authoritative machine-readable outputs are uploaded by the Loro workflow as `artifacts/loro/results.json` and `benchmark.json`. Web result: **18 PASS / 0 PARTIAL / 0 FAIL**.

| # | Scenario | Result | Observation |
|---:|---|---|---|
| 1 | Different recipe fields | PASS | Concurrent title + portions both survive; no disagreement. |
| 2 | Same nested entity, different properties | PASS | Ingredient amount and name/qualifier both survive. |
| 3 | Concurrent additions | PASS | Both additions survive; deterministic merged order. |
| 4 | Concurrent text editing | PASS | Exact result: `Gently Heat oil, then add tomatoes. Simmer for 10 minutes.` |
| 5 | Chat appends | PASS | Neither append disappears. |
| 6 | Set-like additions | PASS | Independent values both survive. |
| 7 | Same scalar disagreement | PASS | Visible winner 6; history reconstructs 4/iphone and 6/macbook as concurrent alternatives. |
| 8 | Different atomic titles | PASS | Both competing titles reconstructable for review. |
| 9 | Delete versus edit | PASS | Raw membership delete is inadequate; tombstone lifecycle preserves reviewable delete+edit. |
| 10 | Duplicate pantry creation | PASS | Different IDs both survive; normalized carrots duplicate requires semantic dedupe; preferences remain reviewable. |
| 11 | Reorder + edit | PASS | Movable-list reorder and entity edit both survive. |
| 12 | Restart | PASS | Full snapshot reload then further replication succeeds. |
| 13 | Out-of-order import | PASS | Causally incomplete update is held pending until dependency arrives. |
| 14 | Duplicate update | PASS | Duplicate import is idempotent. |
| 15 | Long offline divergence | PASS | Converges; clean edits survive and disagreement evidence remains. |
| 16 | Merge direction | PASS | A→B and B→A reach equivalent logical state. |
| 17 | Incremental sync | PASS | Tiny update is much smaller than snapshot and applies correctly. |
| 18 | Three replicas | PASS | iphone/macbook/ipad converge. |

## Critical same-field disagreement finding

For base portions=2, iphone writes 4 and macbook writes 6. After convergence the normal Map exposes only 6. The spike reconstructs:

- value 4, actor iphone, change `0@101`
- value 6, actor macbook, change `0@202`
- the two writes are concurrent

The executable detector uses only public Loro entry points:
- `getAllChanges()`
- `getOpsInChange(...)`
- `cmpFrontiers(...)`

The result is cross-checked against `exportJsonUpdates(...)`. A full snapshot/restart preserves both alternatives. A later ipad resolution causally after both heads makes the earlier writes non-maximal, so the disagreement disappears.

This answers the central architectural question: **yes, genuine same-field concurrent disagreement can be reconstructed from public retained-history APIs without implementing a second conflict CRDT.** The disadvantage is application complexity: operation payloads are low-level, `getOpsInChange` is typed `any[]`, and a production Sync Activity/review surface should index changes incrementally rather than scan full retained history for every query.

## History / ledger quality

With retained history Creative Cooking can determine:
- device/change authorship, once app device metadata is associated with Loro peers/commit metadata;
- whether writes are concurrent;
- which fields independently changed during clean merges;
- losing LWW alternatives;
- which later write causally resolved a disagreement.

That makes a future low-priority Sync Activity view feasible. It is harder than an engine that exposes a first-class multi-value conflict set because Creative Cooking owns the interpretation/indexing layer.

## Compaction / shallow-history implication

Full snapshots retain disagreement evidence. Shallow snapshots can destroy it. The executable test shows:
1. a shallow snapshot rooted exactly at the unresolved conflict can still contain those writes;
2. after an unrelated later edit, advancing the shallow root trims the old conflicting operations and disagreement reconstruction returns null.

Therefore Creative Cooking must not compact past unresolved review evidence unless it first materializes a durable unresolved-review record or archives/retains the relevant history. Compaction is part of product correctness, not merely storage optimization.

## Mergeable containers

Current web/source-head APIs provide `ensureMergeableMap`, `ensureMergeableText`, `ensureMergeableMovableList`, etc. The web probe passes: deterministic map-key child identity prevents concurrent lazy creation from creating separate children.

These APIs do **not** change normal scalar Map LWW semantics, so they do not solve the portions/title disagreement problem. The common comparison schema does not depend on them. Current RN source head includes them; npm RN 1.10.3 does not expose the same current surface.

## Text and movable-list findings

LoroText correctly merged the non-overlapping concurrent method edits in test 4. LoroMovableList is a good fit for stable ingredient/step IDs: test 11 proves one replica can reorder while another edits the entity and both survive.

## Delete versus edit strategy

Physical deletion is not sufficient product UX. The raw test can remove visible registry membership while an offline-edited entity state still exists. The proposed lifecycle model stores a tombstone such as `deleted=true` plus eventual deletion metadata, retains the edited entity, and presents:

- Keep edited recipe
- Keep deleted

Physical garbage collection should happen only after review/retention/acknowledgement policy.

## Duplicate pantry creation

Two offline devices creating equivalent carrots with different IDs correctly produce two CRDT entities. Loro cannot infer semantic equivalence. Creative Cooking therefore still needs normalized-name semantic dedupe, retaining both IDs/history/preferences until a canonical item is chosen.

## Web / static PWA

**PASS.** A real Expo static export was served under the GitHub Pages-style `/creative-cooking/` subpath and exercised in Chromium.

One integration requirement is important: Expo static export did not automatically copy Loro's browser WASM asset. The spike explicitly copies `loro_wasm_bg.wasm` beside emitted web JS. Without that copy, the page fails at runtime with a WASM 404.

Measured raw static footprint:
- control export: 1,206,209 B
- Loro export: 4,739,181 B
- delta: 3,532,972 B
- Loro WASM: 3,398,779 B
- installed loro-crdt package: about 20 MB; browser subdirectory about 3.8 MB

## React Native / Expo 57

### Packaging reality

There are two materially different official artifacts.

**Published npm release, 1.10.3:** drop-in/autolinkable and about 62 MB installed because it carries prebuilt archives:
- iOS arm64 Rust archive ~9.8 MB
- iOS arm64+x86_64 simulator archive ~19 MB
- Android armeabi-v7a ~12 MB
- Android arm64-v8a ~18 MB
- no Android x86/x86_64 Rust archive

**RN repository head, metadata 1.13.2:** exposes newer history and mergeable-container APIs, but a git install is only about 2.7 MB and does not carry the prebuilt .a/.so artifacts shipped in npm. Using source head as a real app dependency therefore requires reproducing upstream native/Rust binding builds rather than simply installing the commit.

### iOS result

**PARTIAL.** With the published 1.10.3 package, Expo 57 prebuild and CocoaPods integration succeed. A clean simulator build/runtime probe was attempted in GitHub-hosted macOS. The final report does not count iOS runtime or web↔iOS interchange as proven unless a successful native runtime artifact exists; compile/prebuild evidence is intentionally not promoted to runtime success.

### Android result

**PARTIAL.** The published package autolinks and an ARM64 APK was built under Expo 57 / RN 0.86.3. Measured prior build: 87,482,205 B with `lib/arm64-v8a/libloro-react-native.so` at 5,944,816 B.

An x86_64 emulator APK also compiles (80,374,176 B), but it contains no Loro native library, matching the npm package's lack of x86_64 Rust archive. Thus an ordinary GitHub x86_64 Android emulator cannot prove Loro runtime even though Gradle compilation succeeds.

A serious ARM-hosted attempt was also made on GitHub's Linux ARM runner. The Android SDK repository there does not provide the Android Emulator package for that host, so an actual ARM64 device runtime could not be created. Android ARM64 build support is demonstrated; actual Android Loro runtime/interchange remains unproven in hosted CI.

### Web/native binary interoperability

The harness uses a real web-created 1.16.4 binary snapshot, intends to import it natively, fork portions=6 against web portions=4, export a native update, and re-import that native update on web while checking disagreement history. Because a successful published-RN runtime result has not been demonstrated on both native platforms, this spike does **not** call web/native interchange a full PASS. Loro's stable 1.x binary format makes the version-skew scenario intended to be interoperable, but compile-only evidence is not accepted as proof.

## Performance fixture

Fixture matches the requested/common logical shape:
- 200 pantry items
- 500 recipes
- 5 ingredients/recipe
- 4 steps/recipe
- 100 conversations
- 20 messages/conversation

Node/WASM CI measurements are directional, not device benchmarks:

| Metric | Result |
|---|---:|
| Full snapshot | 683,211 B |
| Tiny incremental update | 186 B |
| Fixture construction | 157.58 ms |
| Snapshot export | 101.19 ms |
| Cold-load samples | 181.41, 155.19, 150.52, 143.85, 154.18 ms |
| Cold-load median | 154.18 ms |
| Two-replica merge | 5.66 ms |
| Merge updates | 174 B each direction |
| Gross heap delta after build | ~689,608 B |

Native footprint is dominated by the published binding's prebuilt Rust archives and linked arm64 library.

## API stability / maintenance

Positive:
- Loro 1.0 documents its data format as stabilized for the 1.x line.
- The history methods used by the disagreement detector are public APIs.
- Core Loro is actively maintained.

Risks:
- `getOpsInChange()` returns low-level `any[]`, so the review index requires pinned executable compatibility tests.
- Binary stability does not mean every high-level JS shape is frozen; changelogs still contain API/value-shape changes.
- RN publication cadence materially lags core/FFI and the RN repository head.
- Current mergeable-container functionality is not aligned across web and published RN.

## Build/dependency complexity

Web requires explicit WASM asset handling in Expo static export. Native benefits from an official TurboModule/UniFFI bridge in principle, avoiding a Creative Cooking-owned Rust/C++ bridge, but today that benefit is reduced by publication skew, large binary payloads, Android ABI gaps, and the need to rebuild native artifacts to use newer RN source.

## Explicit answers

1. **Does the official React Native binding actually work in this repo?**  
   **PARTIAL, not as a demonstrated cross-platform runtime solution.** Published 1.10.3 integrates far enough for Expo native prebuild/autolinking and ARM64 Android build; iOS prebuild/CocoaPods also work. Actual Loro execution/interchange is not proven on both platforms. Source-head 1.13.2 is not a drop-in compiled package.

2. **Can web and native exchange real Loro snapshots/updates?**  
   **Not fully proven in this repo.** The harness uses real binary snapshots/updates, but a successful published-RN runtime result is required before counting the round-trip as PASS. Web-only binary interchange is proven.

3. **Can same-field concurrent disagreement be reconstructed simply and reliably?**  
   **Functionally yes from retained history, but not as a simple first-class conflict read.** Both values/authors/concurrency are reconstructed and survive full restart. Production needs a derived index and an explicit retention policy.

4. **Does doing so depend on public/stable-enough APIs?**  
   **Public APIs: yes. High-level conflict abstraction: no.** `getAllChanges`, `getOpsInChange`, and `cmpFrontiers` are public. The maintenance risk is the low-level `any[]` operation payload shape.

5. **What does Loro's normal LWW Map behavior cost Creative Cooking?**  
   Losing concurrent scalar alternatives disappear from ordinary reads, so Creative Cooking must own a history-aware review layer and treat compaction policy as correctness-critical.

6. **What native complexity does Loro save compared with implementing another engine bridge?**  
   **Potentially significant, but not fully realized by the current published artifacts.** The official bridge could save ownership of a JSI/UniFFI/Rust bridge. Today that saving is offset by publication lag, large prebuilt payloads, missing Android x86_64 runtime support, and source-head native build requirements.

## Remaining risks / blockers

- Official RN release skew: npm 1.10.3 vs RN source metadata 1.13.2 vs current core 1.16.4 / FFI 1.16.2.
- Full real-device/native runtime proof and web/native round-trip remain incomplete in hosted CI.
- Low-level operation-shape dependency for disagreement indexing.
- Explicit unresolved-review retention policy before shallow compaction.
- Expo web static export must carry the Loro WASM asset.
- Device identity/authorship metadata belongs to Creative Cooking; peer IDs alone are not human device names.
- Sync transport, pairing/authentication, and encryption remain outside this engine spike.

## CI, artifacts, and isolation

Normal Creative Cooking CI is unchanged and green on this branch: Gitleaks, unit tests, TypeScript, production PWA export/verification, and Playwright E2E pass. Experimental Loro jobs are separate and do not weaken those checks.

The Loro workflow uploads result JSON, benchmark JSON, API probes, static web screenshots/logs, and native build/runtime artifacts when produced. Production AppState/storage/backups/credentials remain untouched. The PR remains draft and must not be merged as a production migration.
