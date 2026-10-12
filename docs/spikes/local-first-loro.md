# Loro local-first feasibility spike

> Status: executable research spike. Isolated from production AppState/persistence and from the Automerge implementation. **Do not merge this PR.**

## Executive result

The Loro web engine satisfies Creative Cooking's structural merge contract: all 18 common scenarios pass on `loro-crdt@1.16.4`, including text, movable-list reorder+edit, incremental/out-of-order/duplicate updates, restart, three replicas, and same-field disagreement reconstruction.

The critical result is nuanced. Loro Maps expose one LWW winner, but retained Loro history is sufficient to reconstruct both concurrent scalar alternatives, authorship/change IDs, and causality using public `getAllChanges`, `getOpsInChange`, and `cmpFrontiers` APIs. No private API, custom vector clock, or second replicated CRDT was required. This is still not a first-class conflict read: `getOpsInChange` exposes low-level `any[]` operation payloads, and the prototype scans retained history. A production implementation should maintain a derived local review/history index and must preserve unresolved review evidence across compaction.

**iOS native/runtime/binary interoperability now PASS on real simulator hardware emulation.** [Experimental run 38240053849](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/job/114780893586) used the actual published `loro-react-native@1.10.3` TurboModule in an Expo 57 / RN 0.86.3 Release iPhone 17 Pro simulator (iOS 26.4), imported the web 1.16.4 snapshot, exported a concurrent native change back to web, converged after divergence, recovered prior-process persisted state and retained both 4/6 alternatives and their causal supersession. Its separate [web-side verifier also PASS](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11744245324). The earlier duplicate-import failure was a false alarm caused by nondeterministic *JSON key iteration order*, not logical or version drift. **Android remains PARTIAL:** ARM64 native packaging is proven, but GitHub-hosted ARM64 emulators cannot run because Hypervisor Framework virtualization is unavailable; native Android runtime has not been demonstrated. Published RN 1.10.3 still lags official RN source metadata 1.13.2/current core/FFI and has broken list-push convenience wrappers. This is a feasibility spike, not a production migration or full platform qualification.

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

**PASS — real iOS Simulator runtime and web↔native interop.** [Experimental run 38240053849 / successful iOS job 114780893586](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/job/114780893586) used the **published** `loro-react-native@1.10.3` TurboModule, not a mock or reconstructed JS engine, in Creative Cooking's isolated Expo 57 / RN 0.86.3 Release harness. [Artifact `loro-ios-runtime`](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11744245324) includes full raw/system logs, simulator information, `ios/first-result.json`, `ios/result.json`, binary updates, `ios/web-verification.json`, size records and screenshot.

Actual device environment: **Apple Silicon GitHub-hosted macOS arm64**, **Xcode 26.6**, **iPhone 17 Pro iOS 26.4 Simulator**, UUID `4E3A6BB3-F417-4829-8DF5-0EA652541F40`. A first app process returned `status=PARTIAL` **only** for process restart (`runId=ios-1791804168610`); a separate `simctl terminate` and launch returned `status=PASS` (`runId=ios-1791804191545`, referencing the first process). All other native checks were PASS on both processes: actual binary web snapshot import, native 6 update, concurrent web 4 merge, native full-snapshot reload, duplicate update import, causal resolution to 8, LoroText, movable-list native FFI, 24 repeated load/export cycles, and recoverable native conflict alternatives `4/iphone/0@101` and `6/ipad/0@303`.

The independently executed `loro-crdt@1.16.4` web verifier imported the **native-produced 154-byte update** and subsequent **172-byte resolution update**, recovered concurrent alternatives with their real change IDs/commit messages, confirmed `0@505` was causally after **both** losing and winning writes, converged at `portions=8`, and checked idempotent re-import. `ios/web-verification.json` reports `PASS`.

**iOS duplicate-import diagnosis now conclusive:** prior raw `JSON.stringify` checks failed even for *two consecutive reads without mutation*. On actual iOS, the canonical content comparison, `VersionVector.eq`, sorted vector maps (pre/post `{101:1,303:1,900:59}`), frontiers, and full retained operation history were **equal** before/after importing an already-present update. `rawJsonEqual=false` and `rawKeyOrderStableWithoutMutation=false` demonstrate unstable property enumeration, not CRDT non-idempotence. The Apple `\\134n` log-escaping parser bug is independently covered by failing-log regression cases.

**Published convenience API defect:** `LoroMovableList.push()` invokes `this.length()` but generated RN 1.10.3 exposes `len()`; `move()` on web corresponds to native `mov()`, and text length uses native `lenUnicode()`. The harness invokes actual generated `insert(len(), ...)`, `mov()`, and `text.insert(text.lenUnicode(), ...)`; it records `publishedPushCallsMissingLength=true`, `mergeableMap.supported=false`. `LoroList.push()` and `pushContainer()` use the same erroneous `length()` method. Official RN source metadata 1.13.2 still contains all three `this.length()` sites; the minimal fix is a **small upstream JS wrapper compatibility patch** or application adapter, not a new CRDT.

Measured artifact: **53,868 KiB** for the Release iOS Simulator `.app` (not a standalone incremental production size). The successful run exercised 48 additional real native-backed documents in 24 create/import/export cycles (39–41 ms reported), but did **not** measure native heap growth. A follow-up [explicit `uniffiDestroy()` lifecycle test](https://github.com/0cwa/creative-cooking/actions/workflows/loro-spike.yml) was added; its result must be read independently before upgrading explicit memory-release evidence.

### Android result

**PARTIAL — ARM64 native APK/linker evidence, but no real ARM64 Loro execution.** The official `loro-react-native@1.10.3` release autolinks in Expo 57 / RN 0.86.3; [macOS ARM64 CI build in run 38240053849](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/job/114780892778) produced an **87,498,593-byte** ARM64 debug APK with the actual Loro Rust native library (`lib/arm64-v8a/libloro-react-native.so`; prior measurement 5,944,816 bytes). This is **compilation/packaging only**: ARM64 app launch, crash freedom, restart and cross-platform updates remain unexecuted.

Three hosted attempts establish a **runner-environment blocker**, not an engine failure:
1. `ubuntu-24.04-arm`: Android SDK has no Linux ARM64 host `emulator` package (`Failed to find package 'emulator'`), before native runtime.
2. `macos-26` Apple Silicon GitHub-hosted VM: Android 35 Google APIs **arm64-v8a** system image and Emulator **37.1.11.0** installed; launching with `-accel auto` failed `HVF error: HV_UNSUPPORTED` / `qemu-system-aarch64-headless: failed to initialize HVF`.
3. [Run 38240053849, dedicated ARM64 emulator log](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11743346589): retrying explicitly with `-accel off` **still** failed `HV_UNSUPPORTED`. Nested Apple Hypervisor Framework acceleration is not exposed to this hosted VM and the emulator did not fall back to usable software execution.

On Linux x86_64, a debug APK compiled, emulator booted and the app shell launched, but the published package has **no x86_64 Rust archive**. Consequently this is not a native Loro runtime check. To qualify Android without a new Rust rebuild, run the existing identical isolated Android harness on an **actual ARM64 device or an ARM64 remote hosted emulator that permits hardware virtualization**, verify `adb shell getprop ro.product.cpu.abi == arm64-v8a`, record API level, capture complete V2 result frames across process restart and run the web verifier. If the environment is unavailable, preserve the accurate **PARTIAL** state, not a falsely green experiment.

### Web/native binary interoperability

**PASS for real web↔iOS↔web interchange; NOT YET PROVEN for Android.** Unlike the earlier intended contract, a published-RN iOS run now satisfies it: web `loro-crdt@1.16.4` binary snapshot (1,341 bytes) → native `loro-react-native@1.10.3` import/mutation → 154-byte incremental update → actual independent web 1.16.4 import. After concurrent 4-versus-6, both replicas retained author and causal history; after a native 8 resolution, web converged to exactly the native resolved content. The iOS app survived a separate native process restart with its persisted snapshot. See [result, first-result and independent web-verification JSON](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11744245324). Format compatibility between these exact versions is **empirically proven on iOS**, not presumed from upstream versioning; Android is a separate missing proof.

## Phase-two native qualification (2026-10-12)

This continuation does not restart or weaken the 18 web scenarios. It adds fail-closed, machine-readable **native** results and uses the actual npm `loro-react-native@1.10.3` TurboModule in an isolated Expo Router harness. All data are disposable test fixtures; no provider credentials, production AppState/storage or user backups are accessed. Normal app CI stays separate.

### Reproducer and status rules

- `node --test scripts/spikes/loro/parse-native-log.test.mjs`: **8/8 PASS** in [experiment 38186124459](https://github.com/0cwa/creative-cooking/actions/runs/38186124459) and later web jobs. Regression includes the exact Apple octal backslash format, Unicode, out-of-order/duplicate frames, missing/malformed/incomplete result, and contradictory status.
- Simulator logs now emit `LORO_NATIVE_RESULT_V2:<run-id>:<1-based-index>/<frame-count>:<URI-encoded-JSON-fragment>`. Each result contains `status: PASS | PARTIAL | FAIL`, per-feature checks and version/operation diagnostics; large byte arrays/history are split into individually single-line-safe frames. The parser emits `result.json` with `FAIL` and exits nonzero for any missing/corrupt result. A previous PASS cannot mask the newest truncated attempt. Raw `live.log`, `system.log` / `runtime.log` and native device/build logs remain separate uploaded artifacts.
- The harness compares recursively sorted semantic JSON **and** Rust `VersionVector.eq()`; maps are captured using `VersionVector.toHashmap()` (which exists in published RN 1.10.3; `toJSON()` does not). It records web binary update hash+size, before/after peer counters, top-level state and low-level public history. Distinct JSON object iteration order is diagnostic only, never an assertion by itself. Any changed content or vector is **FAIL**.
- A native `AsyncStorage` fixture stores the binary snapshot and expected semantic/vector identity. Only a second real simulator/Android process that loads it and reimports the same web update with no semantic/vector change can mark **process restart PASS**. A single in-memory `new LoroDoc(); import(snapshot)` is a separate test, not proof of app restart.
- The native harness creates/loads 48 additional actual UniFFI-backed documents in 24 create/import/export/reimport/load cycles, edits LoroText and movable lists, and creates a causal resolution `portions=8` after native 6/web 4. The web verifier imports both real native binary updates into 1.16.4, checks normalized convergence, retained alternatives and duplicate imports. The published UniFFI superclass **does** expose explicit `uniffiDestroy()`; a later isolated runtime check exercises both deterministic release and rejection of calls after destroy (previous artifacts used garbage-collected ownership). Without an actual heap profiler this still is **not** proof of zero leaks.
- Native conflict provenance uses the public native FFI route `exportJsonUpdatesWithoutPeerCompression` + `frontiersToVv` + `Frontiers.fromId` + `VersionVector.partialCmp`, which is different from the three JavaScript WASM history helpers. If native provenance is absent or cannot attribute real writes, report `PARTIAL` rather than inventing authors or assuming the LWW value contains them.

### Evidence matrix: distinguish compilation, live execution, and cross-platform convergence

| Evidence | Status verified 2026-10-12 | Grounding / remaining qualification |
|---|---|---|
| Web + common CRDT semantics | **PASS** | 18/18 on `loro-crdt@1.16.4` |
| Expo static GitHub Pages subpath/Chromium | **PASS** | Requires Loro WASM copied to export |
| Native result parser, fail-closed regressions | **PASS** | 8/8, including real Apple escaped newline |
| Actual iOS RN 1.10.3 binding / web 1.16.4 snapshot import | **PASS** | [Native iOS job 114780893586](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/job/114780893586), not a mock |
| iOS concurrent native 6/web 4 and byte round-trip to web | **PASS** | 154-byte native update, independent `web-verification.json` |
| iOS duplicate imports, semantic/value/vector/frontier/history stability | **PASS** | Key ordering drift explained, no operation/version change |
| iOS true app terminate/relaunch and persisted snapshot restore | **PASS** | distinct `first-result.json` and `result.json` run IDs |
| iOS causal 8 resolution and retained conflict provenance | **PASS** | `0@101` and `0@303` concurrent; `0@505` later |
| iOS text and native movable-list FFI, repeated load/export | **PASS** | 24 cycles, 48 documents; **published list-push convenience wrapper broken** |
| iOS out-of-order native delivery and full/shallow history retention | **PASS** | Run 38252473679, 15 checks; native trim loses unresolved review evidence and independent checkpoint survives OS restart |
| Native RN falsy-value writes and web import | **PENDING** | Published 1.10.3 source has `if (!value)`; isolated one-line JS fix + authentic native regression newly added, requires fresh paired JSON evidence |
| iOS explicit native Rust release and use-after-release detection | **PASS (functional, not heap-leak bound)** | Run 38252473679: 97 explicit destroys, use-after-destroy rejected |
| Native heap-leak bounds and foreground/background | **NOT MEASURED / PARTIAL** | Only restart + lifecycle smoke shown |
| Android ARM64 native library + APK integration | **PASS (compile only)** | 87,498,593-byte APK; actual ARM64 library present |
| Android ARM64 real app start, restart and web interchange | **PARTIAL until new runtime evidence** | macOS hosted emulator failed `HV_UNSUPPORTED`; new Linux x86_64→ARM64 guest TCG fallback pending, physical device optional |
| Android x86_64 with published release | **UNSUPPORTED / NOT EXECUTED** | No x86_64 Rust archive in published npm package |

Source artifacts: [iOS full native + web verification](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11744245324), [Android ARM64 emulator/build logs](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11743346589), and [CI run index](https://github.com/0cwa/creative-cooking/actions/workflows/loro-spike.yml). **Experimental workflow remains red for missing Android runtime proof**; normal production app CI is unaffected. Never infer PASS from logs, prebuild, IPA/APK compilation or an x86_64 emulator lacking Loro native code.

### Additional *executed* iOS qualification: run 38252473679

[Real simulator job 114835341943](https://github.com/0cwa/creative-cooking/actions/runs/38252473679/job/114835341943) **PASS** on the *unmodified published* `loro-react-native@1.10.3` binding. The first iOS process returned `PARTIAL` only because it could not already prove an OS restart. After a real second process launched, [`ios/result.json` and `ios/web-verification.json`](https://github.com/0cwa/creative-cooking/actions/runs/38252473679/artifacts/11752248335) both returned **PASS**, with all 15 native feature checks passing. This extends, rather than replaces, earlier run 38240053849.

- **Real native out-of-order delivery:** 99-byte first incremental update and 101-byte causally dependent second update. The second update did not apply without its predecessor; importing the first caused convergence. Duplicates preserved content and Rust version vector identity.
- **Real retained-history probe:** the public native history APIs reconstructed `4/iphone/0@101` and `6/ipad/0@303` after full native snapshot import. A later edit followed by real native `shallowSnapshot` export/import preserved current state but lost those old alternatives from normal operation-history inspection. **This is a directly observed data-loss-for-review hazard**, not theoretical.
- **Durable checkpoint:** the spike wrote an independent versioned review record to its disposable AsyncStorage fixture. A true `simctl terminate` and launch reconstructed it from the next OS process and verified the original alternatives. This tests the feasibility requirement; it is not a production review persistence implementation.
- **Lifecycle:** 24 native import/export/reload/duplicate-import cycles, 49 documents, and **97 explicit UniFFI object destroys**. Calling the destroyed document was rejected. No instrumented native heap-growth bound or memory-leak certification is claimed.
- **Minimal real defective API reproducer:** `LoroMovableList.push('should-not-insert')` emitted `undefined is not a function` in iOS, directly corroborating published `extension.ts`'s nonexistent `this.length()` against generated `len()`. The failed invocation left the list empty, while generated FFI `insert/len/mov` worked.
- [Actions artifact ZIP 11752248335](https://github.com/0cwa/creative-cooking/actions/runs/38252473679/artifacts/11752248335): **SHA-256 `2e1a84c607b9763270f949f3030563a4a09b038d6e5b7a8d6485716addd718f7`**, independently checked. It includes raw logs, two parsed results, independent web verification, native/size metadata, screenshot and per-file `SHA256SUMS.txt`.

The same [experimental workflow run](https://github.com/0cwa/creative-cooking/actions/runs/38252473679) compiled ARM64 Android again but its emulator still failed `HV_UNSUPPORTED` **even with `ANDROID_I_WANT_MY_TCG=yes` and `-accel off`**; that job never executed the Loro app. [Android ARM64 artifact 11751309489](https://github.com/0cwa/creative-cooking/actions/runs/38252473679/artifacts/11751309489) ZIP SHA-256 `c3fffdb570d17ba44b1b39c63feee17af1bdac14520d19c4dc58dccda3f36959`. The unsupported x86_64 archive is reported compile-only by [artifact 11751185642](https://github.com/0cwa/creative-cooking/actions/runs/38252473679/artifacts/11751185642), ZIP SHA-256 `7b9f31963fee78224ce9115bd478a22ecf36cebb0606236251fcf6d18eb2c427`. **Overall remains PARTIAL on iOS+Android coverage**, not an engine winner.

### New adversarial native falsy-value gate (awaiting native CI artifact)

The *published* `loro-react-native@1.10.3` JS `jsValueToLoroValue` converter starts with `if (!value)`, which maps valid **`false`, `0`, and `''`** and nested appearances to `LoroValue.Null` before reaching the type-specific branches. Exactly the same flaw is present in official RN source 1.13.2. This is an independent source-level binding defect affecting Creative Cooking's boolean flags and structured state, distinct from the confirmed list-push bug; the source audit alone does **not** count as a native runtime failure.

The isolated spike adds a real iOS/Android native probe that writes literal `false`, numeric zero, empty string, nested map and movable-list values through the actual RN binding, exports its native binary snapshot, and requires an independent `loro-crdt@1.16.4` verifier to import the resulting bytes and reproduce the expected structure and type/value identities. If any value becomes null, `checks.falsyValues=FAIL` and the fail-closed V2 parser refuses PASS; no tests replace the native engine with mocks.

To test the **smallest compatible remedy**, only this experimental workflow runs [`patch-published-falsy-adapter.mjs`](https://github.com/0cwa/creative-cooking/blob/spike/local-first-loro/scripts/spikes/loro/patch-published-falsy-adapter.mjs) immediately after pinning npm RN **1.10.3**. It replaces *one JavaScript guard* with `value === null || value === undefined` and records before/after SHA-256 hashes in `value-adapter-patch.json`. No Rust CRDT, UniFFI-generated code, native archives, app dependencies or production files are altered. A successful native artifact must identify **`loro-react-native@1.10.3+falsy-compat`**, not misrepresent patched code as untouched npm. The correction **does not fix** the separate list-push wrapper defect.

**Status of this additional test: PENDING genuine native artifact.** The prior confirmed iOS 4/6 binary pass is narrowly valid and not a blanket approval of falsy-value correctness. Any new success must include `native checks.falsyValues=PASS`, the genuine `falsySnapshotBytes`, `web-verification.json` from those exact native bytes, and the recorded patch hash. The experiment must remain a research PR, and application-level migration is still prohibited.

### Native API/version delta and operational maintenance

| API/build axis | Published RN 1.10.3 | Official RN source `8fad8d6` / metadata 1.13.2 | Web core 1.16.4 |
|---|---|---|---|
| `getAllChanges`, `getOpsInChange`, `cmpFrontiers` | **0/3 exact web APIs** | **0/3 exact web APIs** | **3/3** |
| `exportJsonUpdatesWithoutPeerCompression`, `frontiersToVv`, `Frontiers.fromId`, `VersionVector.partialCmp` | **4/4 alternate native history APIs** | **4/4** | Different public history interface |
| `ensureMergeableMap` and other mergeable-container methods | **Absent** | **Present** | Present |
| `LoroMovableList.push()`, `LoroList.push()`, `LoroList.pushContainer()` in shipped extension.ts | **All 3 call missing `this.length()`** | **Same three call sites** | Web has proper high-level list API |
| Generated native `len()`, `mov()`, `lenUnicode()`, `uniffiDestroy()` | **Present** (smoked `len/mov/lenUnicode`) | Present in official bindings | API shape differs |
| Rust FFI core | 1.10.3 | 1.13.7 | JS WASM CRDT 1.16.4 |
| Prebuilt official iOS/Android bindings | **Yes**, iOS arm64 + x86_64 simulator and Android arm64/armv7; Android x86_64 **missing** | **No** for Git-install source checkout; must regenerate/link | N/A |
| React Native upstream tested against | npm artifact published from older RN series | 0.79.2 / React 19.0.0 | Browser JavaScript; Creative Cooking uses RN 0.86.3 |

**Smallest maintainable route supported by evidence:** on iOS, **published 1.10.3 works without recompiling or forking Rust**, including binary interop and public native history. The three list convenience-wrapper `this.length()` mistakes require a tiny application compatibility adapter or upstream JS fix; **do not rely on the broken methods as published**. The missing web-style `getAllChanges` methods alone do not force a native fork because the RN FFI exposes an alternate public history route. If version/ABI/native behavior blocks acceptance, reproduce the official **1.13.2** source native build **without changing its Rust CRDT**: pin SHA `8fad8d61c11c23e7c57999533d637d316465ffc1`, Node/Yarn 3.6.1, `uniffi-bindgen-react-native@0.31.0-2`, Rust `loro-ffi=1.13.7`, and run upstream `yarn ubrn:ios:release` / `yarn ubrn:android:release`. The source `ubrn.config.yaml` requires three iOS Rust targets and two Android targets, with x86_64 Android commented out; Android builds need Rust NDK targets and `cargo-ndk`. Publish/cache regenerated native archives and retest actual Expo autolinking. Merely `npm install github:loro-dev/loro-react-native#8fad8d6` is insufficient (no prebuilt archives).

**Engineering estimate, NOT measured duration:** if published binaries qualify, expect roughly **1–3 engineer-days** for isolated-to-product boundary/integration and platform CI, plus **2–4 days** for retained-history review indexing and compaction policy work (the latter is not part of this spike). Keeping npm pinned avoids owning a Rust fork. If rebuilding current RN source is necessary, budget an additional **3–7 engineer-days** one-time for reproducible multi-target native builds, CocoaPods/Gradle autolinking, ABI packaging/caching and device CI, plus **0.5–2 days per upstream binding/FFI upgrade** for rebuilding and binary/history compatibility qualification. These are estimates under a working upstream build; observed native Android/iOS build sizes and failure logs are evidence, not proof of sustainable release engineering. A target-specific Android emulator or physical ARM64 device is still required for release qualification.

**Measured footprint (debug/release configurations are *not* like-for-like app-size delta comparisons):** Android arm64 debug APK 87,498,593 B on macOS ARM64 (earlier Ubuntu build 87,482,205 B); x86_64 debug APK 80,374,176 B but missing Loro .so; ARM64 Loro library previously 5,944,816 B; **successful iOS Release Simulator .app directory 53,868 KiB** (earlier experimental build 103,896 KiB). Upstream npm RN package installed size approximately 62 MB with prebuilt native archives; Git-install source checkout approximately 2.7 MB without them. These are native development artifact observations, not incremental production bundle size.

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

Native iOS/Android workflow steps generate a disposable Expo Router app from `scripts/spikes/loro/native-harness.tsx.template`; `ios/result.json`, `android-arm64-linux-tcg/result.json` or `android-arm64-physical/result.json` only count as platform proofs when real apps return complete V2 frames **and** corresponding web-verification JSON succeeds. To qualify on an external physical Android ARM64 device if hosted emulators fail: build the `arm64-v8a` debug APK with `./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a` after isolated Expo prebuild, then:

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

#### New isolated Linux x86_64 → ARM64 Android software-emulator experiment

After recording that **GitHub-hosted Apple Silicon ARM64 macOS lacks the Hypervisor Framework capability required to boot the Android 35 ARM64 guest** (including `-accel off` and explicit TCG opt-in), the experimental workflow now replaces the repeatedly failing hosted-macOS job with an **x86_64 Ubuntu guest-machine experiment**. The Linux Android Emulator distribution ships `qemu/linux-x86_64/qemu-system-aarch64[-headless]`, and Google's documented `ANDROID_I_WANT_MY_TCG=yes` plus `-accel off` selects CPU software emulation. This is an unsupported/slow developer-emulator fallback, **not production capacity evidence** or equivalent to running natively on physical ARM64 hardware. It avoids assuming unavailable nested Apple HVF/KVM acceleration; the guest is still required to be actual ARM64 Android.

The [isolated Linux ARM64 guest job](https://github.com/0cwa/creative-cooking/actions/workflows/loro-spike.yml) installs Google's Android 35 ARM64 system image on `ubuntu-latest`, builds a genuine `arm64-v8a` APK including the official pinned RN 1.10.3 ARM64 Rust library, and boots the Android guest with software QEMU. It uses the existing fail-closed [native device runner](https://github.com/0cwa/creative-cooking/blob/spike/local-first-loro/scripts/spikes/loro/run-android-arm64-physical.sh) in **explicit emulator-only mode**: requires `ro.product.cpu.abi=arm64-v8a`, `ro.kernel.qemu=1`, `emulator-*` serial, a real Android API level, `pm clear` before the first process, an actual PID, complete V2 native frames, `am force-stop`/PID disappearance and a distinct second PID, persisted review checkpoint and legitimate native binary updates. It then runs the independent web 1.16.4 verifier and uploads `android-arm64-linux-tcg/result.json`, `web-verification.json`, raw build/boot/runtime logs, ABI/API inventory, memory snapshots, value-adapter patch manifest and SHA-256 file list.

The separate **physical-device** mode still strictly refuses emulator serials and `ro.kernel.qemu=1` by default. Both modes require *genuine Loro operations in the reported guest ABI*, not merely an AVD image download, `adb` boot, APK packaging, an x86_64 container or a synthetic result.

**Status: PENDING actual Linux TCG job and artifacts.** Do not count the new attempt as an Android PASS until real ARM64 guest `result.json` and its independent web `web-verification.json` both exist and pass from the same build. If Linux TCG fails to start the ARM64 guest or is too slow, Android stays PARTIAL and the opt-in real ARM64 hardware runner remains the best qualification route.

#### Opt-in hardware runner: genuine ARM64 Android process evidence

The isolated workflow now also has a **manually dispatched** `arm64_physical` input. Set this to `true` only after registering a **Linux x64 GitHub Actions self-hosted runner with the label `android-arm64-device`**, a locally accessible and authorized **physical ARM64 Android** device, Android SDK/NDK (set `ANDROID_HOME`), and functioning `adb`. This job is **skipped for all pull requests** and all ordinary workflow dispatches; it never holds up main CI. An offline self-hosted runner will leave an explicitly requested hardware job queued rather than producing false results.

The [hardware test script](https://github.com/0cwa/creative-cooking/blob/spike/local-first-loro/scripts/spikes/loro/run-android-arm64-physical.sh) and [experimental workflow](https://github.com/0cwa/creative-cooking/actions/workflows/loro-spike.yml) compile the exact same pinned 1.10.3 Expo test APK and require an actual `lib/arm64-v8a/libloro-react-native.so`, `ro.product.cpu.abi=arm64-v8a`, a real Android API level, and `ro.kernel.qemu != 1` (no emulator masquerading as physical-device evidence). They establish a single selected device by `adb devices -l`, install the app, forward Metro 8081, poll **complete fail-closed V2 frames** from real `adb logcat`, require a first-process `PARTIAL` result, perform `am force-stop` and prove that PID disappears, then launch a distinct second OS process and require persisted restart `PASS`. The existing independent `loro-crdt@1.16.4` verifier then imports native-produced binary updates and must produce `web-verification.json` PASS. The job always uploads raw logs, ABI/API, device-identity, actual APK hash, pid evidence, meminfo, both results, verifier JSON when reached and a `SHA256SUMS.txt` manifest, including on failure.

For manual execution on an already built isolated fixture, with exactly one authorized USB device and Metro available:

```sh
# Only once the dedicated test APK exists and no other adb targets are selected:
LORO_ANDROID_APK=android/app/build/outputs/apk/debug/app-debug.apk \
  bash scripts/spikes/loro/run-android-arm64-physical.sh
npm install --no-save --no-audit --no-fund loro-crdt@1.16.4
node scripts/spikes/loro/verify-native-update.mjs \
  artifacts/loro/web-native-input.json \
  artifacts/loro/android-arm64-physical/result.json \
  artifacts/loro/android-arm64-physical/first-result.json \
  > artifacts/loro/android-arm64-physical/web-verification.json
node scripts/spikes/loro/hash-evidence.mjs artifacts/loro/android-arm64-physical
```

This is a reproducible hardware **qualification path**, not a claimed hardware runtime result. Until a real connected device executes it successfully, Android remains **PARTIAL** overall. The Linux x86_64→ARM64 TCG emulator experiment is explicitly unsupported/slow under Google's Android Emulator documentation. Real device testing remains preferred; even a successful software guest proves logical compatibility, not representative ARM64 hardware performance.


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
   **PASS on actual iOS RN runtime, PARTIAL on Android.** Published 1.10.3 really imports web state, exports updates, retains concurrent provenance and survives restart on the iOS Simulator. Android arm64 compiles but the hosted runner cannot boot an ARM64 emulator. Source-head 1.13.2 is not a drop-in compiled package.

2. **Can web and native exchange real Loro snapshots/updates?**  
   **YES on iOS, not Android.** [Real iOS web/native/web interop and causal convergence PASS](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11744245324). Android still requires execution on ARM64 hardware, not Gradle alone.

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
- **iOS Simulator native/web round-trip is proven. Android ARM64 execution is unproven** because hosted ARM64 emulator virtualization is unsupported; use a physical/remote device.
- RN package list convenience-wrapper mismatch (`this.length()` versus generated `len()`) affects published 1.10.3 and official source 1.13.2; native `mov()`/`lenUnicode()` differ from web names.
- Low-level operation-shape dependency for disagreement indexing (public native FFI does reconstruct the actual 4-versus-6 provenance).
- Explicit unresolved-review retention policy before shallow compaction. iOS runtime now demonstrates exactly why: native shallow-history trim loses the 4/6 alternatives; its disposable durable review checkpoint survives an OS restart.
- Published native JS converter loses falsy domain values according to the pinned source. The isolated `false/0/''` native round-trip probe and one-line JS compatibility correction are **pending actual native CI confirmation**, not a reason to overclaim general state correctness.
- Expo web static export must carry the Loro WASM asset.
- Device identity/authorship metadata belongs to Creative Cooking; peer IDs alone are not human device names.
- Sync transport, pairing/authentication, and encryption remain outside this engine spike.

## SHA-256 identities of verified native evidence archives

The following downloaded Actions artifact ZIP digests were independently verified locally (SHA-256), and are consistent with GitHub artifact digests. A ZIP checksum does not itself make missing result JSON a PASS.

| Run 38240053849 artifact | Result proven | Downloaded ZIP SHA-256 |
|---|---|---|
| [iOS 11744245324](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11744245324) | Genuine iOS runtime/OS restart and independent web verification PASS | 371d3135274ba86e6182a2a822a868a1edd80ba2bb4ffa6852235a7b4772533f |
| [Android ARM64 11743346589](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11743346589) | Compile only; HV_UNSUPPORTED emulator | bf274cd26eabf7223c4435941478bb1938fd3ca565f898b5d637a40aaa7de150 |
| [Android x86_64 11744095007](https://github.com/0cwa/creative-cooking/actions/runs/38240053849/artifacts/11744095007) | Missing x86_64 Rust archive; no native runtime | b783af0f6e690eb743a1a47987b9f1eba6520495117fd6179407f32c7452b37f |

Subsequent experimental native CI jobs also write SHA256SUMS.txt for raw output files and independently capture the APK hash. The V2 parser remains fail-closed: a log/artifact without actual valid result.json plus web-verification.json is not successful native convergence.

## CI, artifacts, and isolation

Normal Creative Cooking CI is unchanged and passed on the last completed branch run ([38264287845](https://github.com/0cwa/creative-cooking/actions/runs/38264287845)): Gitleaks, unit tests, TypeScript and production PWA export/verification. Fresh commits must be checked independently; the experimental Loro workflow is separate and expected to fail closed on unqualified ARM64 runtime. Experimental Loro jobs are separate and do not weaken those checks. The newly configured Linux ARM64 guest experiment is **unverified** until its exact native and web output files are published.

The Loro workflow uploads result JSON, benchmark JSON, API probes, static web screenshots/logs, **actual successful iOS runtime and independent web-verification artifacts**, and failed Android ARM64 host-emulator logs. [Normal app CI #38240054120](https://github.com/0cwa/creative-cooking/actions/runs/38240054120) passed at the successful iOS binary-roundtrip commit. Experimental workflow is intentionally still red due to nonqualified Android runtime. Production AppState/storage/backups/credentials remain untouched. The PR remains draft and must not be merged as a production migration.
