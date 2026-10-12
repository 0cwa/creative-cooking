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

**PARTIAL; executable 1.10.3 binding confirmed, but end-to-end acceptance not yet established.** A real Expo 57 / RN 0.86.3 Release app built, installed and launched on the iOS Simulator. In [experimental run 38154451810, job 114514779408](https://github.com/0cwa/creative-cooking/actions/runs/38154451810/job/114514779408), JavaScript imported the actual published TurboModule, loaded the Loro 1.16.4 web snapshot, made the native portions=6 edit, exported the native update, imported the concurrent web portions=4 update, and reached the restart/duplicate-import assertion. The assertion compared raw `JSON.stringify` output, so its failure alone does **not** establish either a changed logical value or genuine Loro operation duplication.

That original diagnostic ended with `duplicate update import was not idempotent after restart`; its collector then threw `SyntaxError: Bad escaped character in JSON`, because Apple unified logs represented escaped stack newlines as `\\134n`. Neither failure is hidden or counted as a complete interoperability PASS. Subsequent builds exercise canonical semantic equality **and** `VersionVector.eq()`/peer-counter maps while retaining the before/after history, and perform a true `simctl terminate` / launch using an AsyncStorage-persisted binary snapshot. The first launch is explicitly `PARTIAL` until a separate process reads that persisted snapshot.

### Android result

**PARTIAL — ARM64 native-library/APK compilation proved, real ARM64 Loro execution pending.** The published package autolinks into Expo 57 / RN 0.86.3. A measured Android arm64-v8a debug APK is 87,482,205 B and contains `lib/arm64-v8a/libloro-react-native.so` (5,944,816 B).

An x86_64 emulator APK also compiles (80,374,176 B) but contains **no** Loro x86_64 native library. In [run 38185197429](https://github.com/0cwa/creative-cooking/actions/runs/38185197429), the Google x86_64 emulator booted, accepted installation, and launched the APK, but no Loro result marker was emitted. That is not valid Loro native-runtime evidence regardless of Gradle success. Do not run/declare x86_64 Loro tests with this npm release without rebuilding its Rust archive for that ABI.

On `ubuntu-24.04-arm`, the Android SDK has no host ARM64 `emulator` package (`Failed to find package 'emulator'`), so that attempted runner cannot satisfy the runtime requirement. A replacement isolated experiment runs on **Apple Silicon macOS**, installs Google's **arm64-v8a** system image, checks `adb shell getprop ro.product.cpu.abi` and `ro.build.version.sdk`, and only counts result frames from a real ARM64 process; it terminates/relaunches the app and verifies native-produced bytes on web. The experimental workflow remains red if those conditions cannot be met.

### Web/native binary interoperability

The harness uses a real web-created 1.16.4 binary snapshot, intends to import it natively, fork portions=6 against web portions=4, export a native update, and re-import that native update on web while checking disagreement history. Because a successful published-RN runtime result has not been demonstrated on both native platforms, this spike does **not** call web/native interchange a full PASS. Loro's stable 1.x binary format makes the version-skew scenario intended to be interoperable, but compile-only evidence is not accepted as proof.

## Phase-two native qualification (2026-10-12)

This continuation does not restart or weaken the 18 web scenarios. It adds fail-closed, machine-readable **native** results and uses the actual npm `loro-react-native@1.10.3` TurboModule in an isolated Expo Router harness. All data are disposable test fixtures; no provider credentials, production AppState/storage or user backups are accessed. Normal app CI stays separate.

### Reproducer and status rules

- `node --test scripts/spikes/loro/parse-native-log.test.mjs`: **8/8 PASS** in [experiment 38186124459](https://github.com/0cwa/creative-cooking/actions/runs/38186124459) and later web jobs. Regression includes the exact Apple octal backslash format, Unicode, out-of-order/duplicate frames, missing/malformed/incomplete result, and contradictory status.
- Simulator logs now emit `LORO_NATIVE_RESULT_V2:<run-id>:<1-based-index>/<frame-count>:<URI-encoded-JSON-fragment>`. Each result contains `status: PASS | PARTIAL | FAIL`, per-feature checks and version/operation diagnostics; large byte arrays/history are split into individually single-line-safe frames. The parser emits `result.json` with `FAIL` and exits nonzero for any missing/corrupt result. A previous PASS cannot mask the newest truncated attempt. Raw `live.log`, `system.log` / `runtime.log` and native device/build logs remain separate uploaded artifacts.
- The harness compares recursively sorted semantic JSON **and** Rust `VersionVector.eq()`; maps are captured using `VersionVector.toHashmap()` (which exists in published RN 1.10.3; `toJSON()` does not). It records web binary update hash+size, before/after peer counters, top-level state and low-level public history. Distinct JSON object iteration order is diagnostic only, never an assertion by itself. Any changed content or vector is **FAIL**.
- A native `AsyncStorage` fixture stores the binary snapshot and expected semantic/vector identity. Only a second real simulator/Android process that loads it and reimports the same web update with no semantic/vector change can mark **process restart PASS**. A single in-memory `new LoroDoc(); import(snapshot)` is a separate test, not proof of app restart.
- The native harness creates 48 additional actual UniFFI-backed documents in 24 create/import/export/reimport/load cycles, edits native LoroText and movable lists, and creates a causal resolution `portions=8` after the concurrent native 6 and web 4 writes. The web verifier imports both native binary updates into Loro 1.16.4 and checks normalized convergence, retained old alternatives and duplicate update handling. Binding-generated native ownership relies on finalization; without a native heap profiler, this is **not** proof of zero leaks.
- Native conflict provenance uses the public native FFI route `exportJsonUpdatesWithoutPeerCompression` + `frontiersToVv` + `Frontiers.fromId` + `VersionVector.partialCmp`, which is different from the three JavaScript WASM history helpers. If native provenance is absent or cannot attribute real writes, report `PARTIAL` rather than inventing authors or assuming the LWW value contains them.

### Evidence matrix: distinguish compilation, live execution, and cross-platform convergence

| Evidence | Status on 2026-10-12 | Grounding / required upgrade to PASS |
|---|---|---|
| Web + common merge semantics | **PASS** | 18/18 `loro-crdt@1.16.4`; pre-existing independent contract |
| Parser and no-false-PASS regression | **PASS** | 8/8 in [run 38186124459](https://github.com/0cwa/creative-cooking/actions/runs/38186124459) |
| iOS actual RN module launches and performs snapshot/fork/merge operations | **PASS through duplicate assertion** | [Earlier native iOS logs and screenshot, run 38154451810](https://github.com/0cwa/creative-cooking/actions/runs/38154451810), then assertion FAIL; does **not** claim complete roundtrip |
| iOS canonical duplicate import, version and operation identity, separate OS restart | **PARTIAL until successful new artifacts** | [new full qualification workflow](https://github.com/0cwa/creative-cooking/actions/workflows/loro-spike.yml); requires `ios/first-result.json` and `ios/result.json` |
| Web 1.16.4 → native 1.10.3 → web 1.16.4, convergence and causal review resolution | **PARTIAL until successful new artifacts** | Native `nativeUpdateBytes`, `nativeResolutionUpdateBytes` and `ios/web-verification.json` must agree; no mocked native module |
| Native provenance of 4-versus-6 alternatives with real peer IDs | **PARTIAL until evidence** | Native public FFI history result checked separately from web reconstruction |
| Native movable list, LoroText, 24-cycle lifecycle / ownership | **PARTIAL until native result** | Recorded test cycles and feature checks; memory leak not measured |
| Android ARM64 binary compiled and packaged | **PASS (compile only)** | 87,482,205 B APK, 5,944,816 B Loro arm64-v8a .so |
| Android x86_64 runtime with published Loro Rust native library | **FAIL / unsupported ABI** | No x86_64 `libloro-react-native.so`; even a booted x86_64 emulator cannot qualify it |
| Android true ARM64 device execution/restart/interop | **PARTIAL pending native runtime** | [Apple Silicon ARM64 emulator experiment](https://github.com/0cwa/creative-cooking/actions/workflows/loro-spike.yml); absent compatible device, preserve compile evidence only |

Native CI artifacts are attached to individual workflow runs under `loro-ios-runtime` and `loro-android-arm64-runtime`. For a successful native result, both `result.json` and `web-verification.json` must exist; compile logs and screenshots alone do not satisfy the acceptance criteria. Experiment failures remain visible (they are not production branch protection checks).

### Native API/version delta and operational maintenance

| API/build axis | Published RN 1.10.3 | Official RN source `8fad8d6` / metadata 1.13.2 | Web core 1.16.4 |
|---|---|---|---|
| `getAllChanges`, `getOpsInChange`, `cmpFrontiers` | **0/3 exact web APIs** | **0/3 exact web APIs** | **3/3** |
| `exportJsonUpdatesWithoutPeerCompression`, `frontiersToVv`, `Frontiers.fromId`, `VersionVector.partialCmp` | **4/4 alternate native history APIs** | **4/4** | Different public history interface |
| `ensureMergeableMap` and other mergeable-container methods | **Absent** | **Present** | Present |
| Rust FFI core | 1.10.3 | 1.13.7 | JS WASM CRDT 1.16.4 |
| Prebuilt official iOS/Android bindings | **Yes**, iOS arm64 + x86_64 simulator and Android arm64/armv7; Android x86_64 **missing** | **No** for Git-install source checkout; must regenerate/link | N/A |
| React Native upstream tested against | npm artifact published from older RN series | 0.79.2 / React 19.0.0 | Browser JavaScript; Creative Cooking uses RN 0.86.3 |

**Smallest maintainable route under investigation:** use the published 1.10.3 binding without modifying Rust if the binary interoperability + history checks actually PASS; the missing web-style `getAllChanges` methods alone do not force a native fork because the RN FFI exposes an alternate public history route. If version/ABI/native behavior blocks acceptance, reproduce the official **1.13.2** source native build **without changing its Rust CRDT**: pin SHA `8fad8d61c11c23e7c57999533d637d316465ffc1`, Node/Yarn 3.6.1, `uniffi-bindgen-react-native@0.31.0-2`, Rust `loro-ffi=1.13.7`, and run upstream `yarn ubrn:ios:release` / `yarn ubrn:android:release`. The source `ubrn.config.yaml` requires three iOS Rust targets and two Android targets, with x86_64 Android commented out; Android builds need Rust NDK targets and `cargo-ndk`. Publish/cache regenerated native archives and retest actual Expo autolinking. Merely `npm install github:loro-dev/loro-react-native#8fad8d6` is insufficient (no prebuilt archives).

**Engineering estimate, NOT measured duration:** if published binaries qualify, expect roughly **1–3 engineer-days** for isolated-to-product boundary/integration and platform CI, plus **2–4 days** for retained-history review indexing and compaction policy work (the latter is not part of this spike). Keeping npm pinned avoids owning a Rust fork. If rebuilding current RN source is necessary, budget an additional **3–7 engineer-days** one-time for reproducible multi-target native builds, CocoaPods/Gradle autolinking, ABI packaging/caching and device CI, plus **0.5–2 days per upstream binding/FFI upgrade** for rebuilding and binary/history compatibility qualification. These are estimates under a working upstream build; observed native Android/iOS build sizes and failure logs are evidence, not proof of sustainable release engineering. A target-specific Android emulator or physical ARM64 device is still required for release qualification.

**Measured footprint (debug/release configurations are *not* like-for-like app-size delta comparisons):** Android arm64 debug APK 87,482,205 B; x86_64 debug APK 80,374,176 B but missing Loro .so; ARM64 Loro library 5,944,816 B; earlier iOS Release Simulator .app directory 103,896 KiB. Upstream npm RN package installed size approximately 62 MB with prebuilt native archives; Git-install source checkout approximately 2.7 MB without them. These are native development artifact observations, not incremental production bundle size.

### Repeatability / local qualification commands

Web/parser probes and an independent binary verifier:

```sh
npm install --no-audit --no-fund
npm install --no-save --no-audit --no-fund loro-crdt@1.16.4
node --test scripts/spikes/loro/parse-native-log.test.mjs
node scripts/spikes/loro/run.mjs
node scripts/spikes/loro/materialize-native-fixture.mjs
# Once a real platform's result.json is downloaded, NOT a synthetic result:
node scripts/spikes/loro/verify-native-update.mjs \
  artifacts/loro/web-native-input.json artifacts/loro/ios/result.json
```

Native iOS/Android workflow steps generate a disposable Expo Router app from `scripts/spikes/loro/native-harness.tsx.template`, and `ios/result.json` / `android-arm64/result.json` only count as platform proofs when the real app returned complete V2 frames. To qualify on an external physical Android ARM64 device if hosted emulators fail: build the `arm64-v8a` debug APK with `./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a` after isolated Expo prebuild, then:

```sh
adb devices -l
adb shell getprop ro.product.cpu.abi   # must be arm64-v8a
adb shell getprop ro.build.version.sdk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -c
adb shell monkey -p com.creativecooking.lorospike -c android.intent.category.LAUNCHER 1
adb logcat -d > artifacts/loro/android-arm64/first-runtime.log
node scripts/spikes/loro/parse-native-log.mjs \
  artifacts/loro/android-arm64/first-runtime.log artifacts/loro/android-arm64/first-result.json --allow-partial
adb shell am force-stop com.creativecooking.lorospike
adb logcat -c
adb shell monkey -p com.creativecooking.lorospike -c android.intent.category.LAUNCHER 1
adb logcat -d > artifacts/loro/android-arm64/runtime.log
node scripts/spikes/loro/parse-native-log.mjs \
  artifacts/loro/android-arm64/runtime.log artifacts/loro/android-arm64/result.json
```

The physical-device path additionally needs Metro available/forwarded on port 8081 and the native web fixture materialized into the isolated app. Otherwise the APK may launch without running the JS harness; the parser correctly returns FAIL.

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
