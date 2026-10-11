# Automerge local-first feasibility spike

Date: 2026-10-11

Status: research/build spike only. This branch does not migrate production state, does not change provider credential handling, and must not be merged as a production rollout.

Umbrella: #36 — **Evaluate local-first device sync architecture**

Draft PR: #37 — **[spike] Automerge local-first engine and native feasibility**

## Scope

This spike evaluates Automerge as a replicated local-first state engine behind a future backend boundary:

```text
AutomergeBackend
  ├─ WebAutomergeBackend
  └─ NativeAutomergeBackend
```

The normal Creative Cooking application remains unchanged. Production `AppState`, IndexedDB/AsyncStorage persistence, backup/restore, provider credentials, and UI are not migrated in this PR.

The experiment uses stable entity IDs plus explicit order lists rather than treating the current array-shaped `PersistedState` as the final replicated schema. That is intentional: stable identity is needed so reorder/edit and concurrent additions are not coupled to array positions.

## Current upstream state verified on 2026-10-11

| Component | Current official state | Exact revision used / inspected | Maturity relevant to this spike |
| --- | --- | --- | --- |
| `@automerge/automerge` | 3.5.0; current `main` still reports 3.5.0 | spike uses 3.5.0; release commit `4d2a8f6bfecfb7f1e4fca126e6d2122ac526f903`; current upstream `main` `7118d9cfd3611f71af44538793816881c5305562` | Mature web/Node JS binding backed by WASM. 3.5.0 added opaque author metadata and history lookup APIs that are directly useful for device attribution. |
| Automerge Rust core | 0.12.0 | `4d2a8f6bfecfb7f1e4fca126e6d2122ac526f903` for the compiled current-core probe; current `main` also reports 0.12.0 | Canonical core. Rust 1.90 minimum in the inspected source. |
| `automerge-c` | 0.2.2 | same Automerge commit `4d2a8f6bfecfb7f1e4fca126e6d2122ac526f903` | Official C API over the current Rust core. It exposes document and sync-state/message APIs and compiled successfully for Android arm64 in this spike. |
| Automerge Swift | stable 0.7.2 | release tag commit `aa45d17ac92cef2b8ded63b47e65a28dc85e3418`; current upstream `main` `658cb91e914cabca4cba75557ed35a7de6ad1bfc` | Viable official Apple binding with a prebuilt XCFramework. Current `main` contains unreleased fixes beyond 0.7.2. |
| Automerge Java/Kotlin/Android | stable 0.0.9 | release/current commit `523d63bc8003fb8d9941f1e8e1ee249f58214581` | Official Java API, Kotlin helpers, and Android AAR are published. Java exposes explicit native-memory `free()` lifecycle. Same-version native sync works, but JS 3.5 ↔ Java 0.0.9 sync interoperability failed in this spike. |
| Official React Native Automerge work | placeholder repository only | `automerge/react-native-automerge` at `9eb73115080c6e9ef5785b36e0b7d7d846cf9ec7` | README says there is “nothing here yet” and describes a future Turbo Native Module. There is no usable official React Native module today. |
| Automerge Repo | stable 2.5.6; newest prerelease 3.0.0-experimental.2 (2026-10-09) | stable 2.5.6 commit `38d06b9d9ef0bbe1e0693d3b859015f38897f34b`; experimental.2 commit `cd0c78934a11653bb072ff07c9d1fb9c8a93e397`; current repo head `8b178e75ecca89f78465196ef786aa844da57aec` | Active, but transport/repository orchestration is separable from the document-engine question. This spike did not require Repo to prove CRDT semantics. |
| Polygen | 0.2.1 | repository head `01a331652c2e417bedd90a5cd23c41d58cacd184` | Explicitly “active development”; React Native 0.75+ / new architecture. README marks Wasm exceptions unsupported. Automerge 3.5’s WASM hits exactly that limitation in the bounded probe. |
| Hermes in this project | React Native 0.86.3 bundle exposes Hermes compiler 1.0.0, HBC bytecode 98 | measured from the installed RN 0.86.3 dependency in Actions | Hermes’ long-running official WebAssembly issue remains open and describes the absence of `global.WebAssembly`. Static Hermes can compile JavaScript *to* Wasm, which is the opposite direction from executing Automerge’s Wasm module. |

Upstream references used for this table are the official repositories/releases:
- https://github.com/automerge/automerge
- https://github.com/automerge/automerge-swift
- https://github.com/automerge/automerge-java
- https://github.com/automerge/react-native-automerge
- https://github.com/automerge/automerge-repo
- https://github.com/callstackincubator/polygen
- https://github.com/facebook/hermes/issues/429

## Exact spike dependencies

| Dependency | Pin |
| --- | --- |
| `@automerge/automerge` | `3.5.0` |
| `esbuild` | `0.28.0` |
| Automerge Swift | exact `0.7.2` |
| Automerge Java | `org.automerge:automerge:0.0.9` |
| Automerge Android native AAR | `org.automerge:androidnative:0.0.9` |
| Polygen | `0.2.1` |
| current-core C probe | Automerge commit `4d2a8f6bfecfb7f1e4fca126e6d2122ac526f903`, Rust core 0.12.0, automerge-c 0.2.2 |

## Native approaches attempted

| Route | Result | Evidence |
| --- | --- | --- |
| Direct Automerge JS/WASM in current Expo/Hermes | **FAIL as a practical route / PARTIAL runtime probe** | Automerge bundles to Hermes bytecode, but the bundle references `WebAssembly`, `TextEncoder`, `TextDecoder`, and `atob`; RN 0.86.3 exposes `hermesc` to CI but no host Hermes runtime binary. Official Hermes WebAssembly support remains absent. No production claim is based only on compiler acceptance. |
| Polygen | **FAIL** | Exact Automerge 3.5 WASM is 3,644,225 bytes. `wasm2c` fails with `invalid import tag kind: exceptions not allowed`; Polygen 0.2.1 likewise generates no native files. This matches Polygen’s published “Exceptions: unsupported” matrix. |
| Official Automerge Swift | **PASS for iOS feasibility** | Build, save/load, conflicts, live sync, JS↔Swift binary interchange, JS↔Swift sync, author-bearing JS document load, and an iOS Simulator package test all pass. |
| Official Automerge Java/Kotlin/Android 0.0.9 | **PARTIAL** | Java host binding runs the full 18-scenario contract with 17 PASS / 1 PARTIAL; JS→Java→JS binary interchange passes; author-bearing JS 3.5 docs load. However a live JS 3.5 ↔ Java 0.0.9 sync session times out and does not converge, so production cross-platform sync on this version pair is not proven. |
| `automerge-c` current core for Android | **PARTIAL but promising** | Rust core 0.12.0 / automerge-c 0.2.2 compiles for `aarch64-linux-android`, API 26, producing a 12,932,546-byte static library. A Nitro/Turbo/Expo bridge was not implemented in this bounded spike. |
| Handwritten TurboModule | **not attempted** | It is not simpler than using the official Swift binding and a generated/small native bridge over the official core. Reimplementing Automerge is explicitly out of scope. |

## Recommended backend boundary from the experiment

The application should not expose Automerge’s JS Proxy API as the cross-platform contract. A small interface is sufficient:

```text
create / load / save
getHeads
merge or apply encoded changes
create sync session
generate sync message
receive sync message
read/write the structured Creative Cooking schema
inspect scalar conflicts
inspect change metadata / diffs needed for Sync Activity and Merge Analyzer
```

The prototype route to carry forward is:

| Platform | Backend route |
| --- | --- |
| Web/PWA | `@automerge/automerge@3.5.0` behind `WebAutomergeBackend` |
| iOS | small Expo/Nitro/native module over Automerge Swift 0.7.2; this is already proven interoperable with the web binding in the spike |
| Android | do **not** ship Java 0.0.9’s sync protocol against JS 3.5.0. Either update to a future Java binding that proves wire compatibility, or build a small generated native bridge over the current Rust/C core. The current-core Android static-library compile makes the latter feasible enough for a follow-up bridge spike. |

This is not a production implementation decision. It is the smallest route consistent with the evidence available today.

## Common CRDT contract

The authoritative web harness runs the exact 18 common scenarios with deterministic IDs and simulated `iphone`, `macbook`, and `ipad` identities.

The Java 0.0.9 host binding also runs the same scenario family. Its only semantic downgrade is test 7 source/history detail: conflicting values are available, but the Java `Conflicts` API does not expose the operation/source metadata needed to attribute each alternative as richly as JS 3.5.

| # | Scenario | Web 3.5.0 | Java 0.0.9 | Exact observation |
| ---: | --- | --- | --- | --- |
| 1 | Different recipe fields | **PASS** | **PASS** | Title and portions both survive. |
| 2 | Same nested entity, different properties | **PASS** | **PASS** | Ingredient amount `3` and qualified name `tomatoes (ripe)` both survive. |
| 3 | Concurrent additions | **PASS** | **PASS** | Both ingredients survive; merge direction yields the same order. Web observed `tomatoes, bread, garlic, basil`. |
| 4 | Concurrent text editing | **PASS** | **PASS** | Web exact result: `Chop onions finely and cook gently until golden.` |
| 5 | Chat appends | **PASS** | **PASS** | Neither append disappears; deterministic order is retained. |
| 6 | Set-like additions | **PASS** | **PASS** | `peanuts` and `sesame` both survive in a map-as-set representation. |
| 7 | Same scalar disagreement | **PASS** | **PARTIAL** | Web preserves values 4 and 6, op IDs, actor→author/device mapping, concurrent change metadata, and a later resolution depending on both heads. Java preserves values and resolution semantics but not equivalent source metadata. |
| 8 | Same atomic title | **PASS** | **PASS** | Both title alternatives remain reviewable. |
| 9 | Delete versus edit | **PASS** | **PASS** | Physical deletion hides the recipe. Tombstone + stable entity preserves both delete intent and concurrent edit for semantic review. |
| 10 | Duplicate pantry item | **PASS** | **PASS** | Both logical “carrots” items and their distinct preferences survive; application semantic dedupe is required. |
| 11 | Reorder + edit | **PASS** | **PASS** | Stable-ID map + order list preserves the reorder and the edited step. |
| 12 | Restart | **PASS** | **PASS** | Save/load/restart followed by new edits works. Java also exercised repeated explicit native frees. |
| 13 | Out-of-order delivery | **PASS** | **PASS** | Raw encoded changes delivered dependency-last converge after the missing dependency arrives. |
| 14 | Duplicate delivery | **PASS** | **PASS** | Duplicate encoded changes are idempotent; duplicate sync message is safe in-session on JS. |
| 15 | Long offline divergence | **PASS** | **PASS** | Eventual convergence with clean edits plus preserved 4/6 disagreement. |
| 16 | Merge direction | **PASS** | **PASS** | A→B and B→A produce equivalent logical/conflict results. |
| 17 | Actual sync protocol | **PASS** | **PASS within Java 0.0.9** | JS sync uses actual `SyncState` APIs: 4 messages / 3 rounds. Java same-version sync also converges. Cross-version JS 3.5 ↔ Java 0.0.9 is a separate interoperability failure below. |
| 18 | Three replicas | **PASS** | **PASS** | Three replicas converge. |

Web summary: **18 PASS / 0 PARTIAL / 0 FAIL**.

Java host summary: **17 PASS / 1 PARTIAL / 0 FAIL**.

## Product merge semantics

### Normal sync

A change whose dependencies include the state already seen by the receiving device is ordinary causal continuation. Nothing in the spike requires a user interruption for this case.

### Clean concurrent merge

The spike uses `diff(baseHeads, mergedHeads)` plus change metadata to identify what arrived. Independent paths such as title + portions or amount + ingredient name survive automatically.

A future low-priority Sync Activity entry can be derived from this evidence without blocking the user.

### Genuine disagreement

For the critical portions case:

- base = 2
- iPhone = 4
- MacBook = 6
- merged rendered value in this run = 4
- `getConflicts` still exposes both `4` and `6`
- each alternative has an operation ID
- Automerge 3.5 author metadata maps the changing actor to the stable opaque authors used for `iphone` and `macbook`
- neither conflicting change depends on the other, proving concurrency
- the resolving iPad change to 5 depends on both conflicting heads
- after the resolution, `getConflicts` returns no unresolved alternatives

That is enough evidence for the intended review UX:

```text
How many portions?
[4] [6] [Enter another value]
```

A representative machine-readable event emitted by the harness is structurally:

```json
{
  "kind": "disagreement",
  "path": "recipesById.recipe-1.portions",
  "alternatives": [
    { "device": "iphone", "value": 4, "opId": "..." },
    { "device": "macbook", "value": 6, "opId": "..." }
  ],
  "heads": ["...", "..."],
  "resolution": {
    "value": 5,
    "change": { "device": "ipad", "deps": ["<phone-head>", "<laptop-head>"] }
  }
}
```

The deterministic rendered value must never be interpreted as “the winner.” The unresolved alternatives are the product truth until the user or application policy resolves them.

## Clean-merge history / ledger feasibility

| Question | Finding |
| --- | --- |
| Which change/device altered a value? | **Yes on JS 3.5.0.** Change metadata exposes actor, hash, dependencies, message/time, and 3.5 author metadata. The spike maps opaque author IDs to simulated device IDs. Java 0.0.9 does not expose equivalent rich metadata. |
| Were two changes concurrent or causally ordered? | **Yes.** Compare dependency hashes / heads. Concurrent changes in the scalar test do not depend on one another. |
| What was automatically combined? | **Yes.** Diffing the pre-merge heads to converged heads produces patches, while change metadata identifies the incoming changes. |
| What alternatives existed in a disagreement? | **Yes.** `getConflicts` returns all live concurrent scalar values; JS exposes the operation IDs used by the spike to connect alternatives to actors/authors. |
| Was a disagreement later resolved? | **Yes.** A later assignment that causally descends from both conflicting heads removes the unresolved conflicts; its change deps prove it superseded both. |
| Can old history be compacted without losing unresolved review evidence? | **Not proven.** `save()` gives a compact binary representation but retains Automerge history. A production compaction/pruning policy was not implemented. Unresolved MergeEvents should be materialized as application review records before any future destructive history compaction. |

## Semantic review above the CRDT

Automerge resolves structural merge mechanics; it does not decide product meaning.

### Delete versus edit

Physical deletion is unsuitable for a reviewable delete-vs-edit case because the normal rendered document can omit the entity. The recommended schema is a tombstone on the stable-ID entity:

```ts
lifecycle: {
  deleted: boolean;
  deletedAt: string | null;
  deletedBy: DeviceId | null;
}
```

A concurrent edit can then coexist with `deleted: true`. The Merge Analyzer can emit:

```text
This recipe was deleted on one device and edited on another.
[Keep edited recipe] [Keep deleted]
```

Physical deletion can happen later after review/retention rules permit it.

### Duplicate pantry items

Two devices adding `carrots` under different stable IDs produces two valid CRDT entities. That is the correct structural result. The application must detect the logical duplicate using a conservative normalized name and produce a semantic review record. Differing preferences (the spike used 5 vs 2) must remain visible; silently collapsing one item would destroy evidence.

### Suspicious structurally-valid recipes

No CRDT can decide whether independently valid field edits form a bad recipe. A future Merge Analyzer should inspect the converged logical recipe and generate review only for suspicious combinations. It should not interrupt for ordinary compatible concurrent edits.

## Cross-platform interoperability

### Web ↔ Swift/iOS

**PASS for the exercised interoperability path.**

The spike proves:

1. JS 3.5 creates a binary Automerge document.
2. Swift 0.7.2 loads it.
3. Swift modifies it.
4. JS 3.5 loads the Swift-produced binary.
5. Web and Swift fork from a common binary and make independent edits.
6. Live JS and Swift sync states/messages converge.
7. A cross-language same-scalar 4/6 conflict remains visible on Swift as values `[4, 6]`.
8. After the same sync, JS sees values `[4, 6]` plus the operation IDs.
9. Swift 0.7.2 loads a JS 3.5 author-bearing document.
10. The Swift package compiles for iOS Simulator.
11. An iOS Simulator test exercises conflict persistence plus a native sync session successfully.

The iOS simulator test is a backend smoke test, not a port of all 18 scenarios.

### Web ↔ Java/Android

**PARTIAL.**

Proven:

- JS 3.5 binary → Java 0.0.9 load: PASS.
- Java mutation → JS 3.5 load: PASS.
- JS 3.5 author-bearing document → Java 0.0.9 load: PASS.
- Java 0.0.9 same-binding sync: PASS.
- Java host common scenario suite: 17 PASS / 1 PARTIAL.

Not proven / failed:

- A live JS 3.5 ↔ Java 0.0.9 sync session does **not** converge. The bounded probe times out after 30 seconds (`syncExitCode=124`).
- Therefore Java 0.0.9 cannot currently be accepted as the Android production sync backend against the web 3.5 binding, even though their persisted document format is interoperable.

### Android target

The Android AAR and instrumentation APK compile from a clean Actions checkout. The instrumentation test embeds the same 18-scenario Java contract.

The 2026-10-11 Linux Actions emulator attempt reached `sys.boot_completed=1`, but the unaccelerated emulator did not have the Android `package` service available when Gradle attempted to install the test APK. That failure is runner/runtime infrastructure, not a compile failure. A follow-up rerun adds an explicit package-service readiness wait; its final result should be recorded here before the spike is considered closed.

Separately, the current Automerge Rust/C core compiles successfully for Android arm64 API 26, proving a current-core Android bridge is build-feasible.

## Persistence findings

- `save()` / `load()` round-trip works and preserves unresolved scalar conflict evidence.
- Web IndexedDB can store Automerge bytes directly; no JSON/base64 conversion is required.
- Native AsyncStorage is a poor long-term binary persistence layer. A production native backend should use a binary-friendly file/SQLite-style store and keep AsyncStorage only for migration metadata if needed.
- Existing Creative Cooking backup semantics should remain independent of engine persistence. The safest user-facing backup remains versioned logical JSON with provider credentials excluded; restoring it should create a fresh CRDT state/change rather than implicitly restoring stale peer session state.
- Sync state is connection/session state. The tested APIs assume a reliable in-order transport for a live session; reconnects should establish/reset a peer sync session rather than replaying arbitrary old transport state.
- A persisted Automerge document is not a substitute for application schema migrations. Creative Cooking still owns schema versioning and domain invariants.

## Performance

Representative fixture:

- 200 pantry items
- 500 recipes
- 100 conversations
- 20 messages per conversation
- 5 ingredients / recipe
- 4 steps / recipe

Runner: GitHub-hosted Linux x64, Node v22.13.1, AMD EPYC 9V45, 4 visible CPUs, ~16.8 GB memory.

| Metric | Result |
| --- | ---: |
| Fixture construction | 1,045.193 ms |
| Serialized document | 346,281 bytes |
| Save | 22.549 ms |
| Tiny incremental edit / last encoded change | 215 bytes |
| Cold load median, 5 samples | 339.102 ms |
| Two-replica initial sync after one tiny edit on each replica | 219.756 ms |
| Sync wire bytes | 346,991 bytes |
| Sync messages / rounds | 4 / 3 |
| Gross V8 heap delta for loaded doc after GC | 3,006,096 bytes |
| Isolated web bundle delta | 4,904,464 bytes |
| Isolated web bundle delta, gzip | 1,639,001 bytes |

Timing is directional, not a mobile microbenchmark. The first sync session transferred approximately the whole fixture even though each replica had only a tiny new edit; a production transport benchmark must also measure warm/established peer sessions and repeated incremental sync.

Native dependency observations (not final app binary deltas):

| Native artifact | Observed size |
| --- | ---: |
| Swift native static library in resolved build | 48,373,408 bytes |
| Automerge Swift 0.7.2 upstream XCFramework zip asset | 54,278,033 bytes |
| Java 0.0.9 API jar | 17,234,831 bytes |
| Android 0.0.9 native AAR | 8,639,751 bytes |
| Current-core `automerge-c` Android arm64 release static library | 12,932,546 bytes |

## Web production bundle impact

The isolated esbuild probe adds ~4.90 MB minified raw / ~1.64 MB gzip. That is material for a static PWA.

This spike does **not** add Automerge to the production Expo bundle. A production implementation should test code splitting/lazy loading and the slim/explicit-WASM entry points before accepting the full-fat bundle cost.

## Build complexity

| Route | Complexity | Maintenance notes |
| --- | --- | --- |
| Web JS/WASM | Low–medium | Easy API and strong history/conflict inspection; significant bundle payload. |
| Swift binding | Medium | SPM + prebuilt XCFramework; good interoperability evidence; track unreleased Swift fixes and binding/core version alignment. |
| Java/Kotlin binding | Medium | Easy Maven/Android consumption and usable native API, but explicit native memory lifecycle and current cross-version sync incompatibility are blockers. |
| Current-core C + Nitro/native bridge | High initially | Rust/NDK/cargo-ndk + C/C++/JSI bridge and ownership tests, but it can keep Android on the same current core/protocol as web. Generated bridge code must be treated as untrusted until interop/lifecycle tests pass. |
| Polygen | Not suitable today | Automerge WASM requires exception support that the current Polygen/wasm2c path does not provide. |

## Automerge Repo

Automerge Repo is active and has both a stable 2.5.6 line and a new 3.0 experimental line. It can provide document repository/network/storage orchestration, but adopting it does not remove the native core/binding problem.

Creative Cooking is also statically deployed on GitHub Pages, so any remote peer discovery/relay/storage remains an explicit product/infrastructure choice. Offline/local operation must never depend on Repo or a remote service being reachable.

This spike therefore keeps document semantics, native engine feasibility, and transport/server architecture separable.

## Licensing

The inspected Automerge JS/core/C, Swift, Java, Automerge Repo, and Polygen components are MIT-licensed. No copyleft blocker was identified in the primary engine/binding dependencies used by the spike.

A production dependency review must still audit transitive native and build-time dependencies and preserve required notices.

## Risks

| Risk | Severity | Why it matters |
| --- | --- | --- |
| Binding/core version skew | High | Persisted binary format interoperates across the tested versions, but JS 3.5 ↔ Java 0.0.9 sync messages do not. Wire compatibility must be a CI contract, not an assumption. |
| Android production backend unresolved | High | Official Java 0.0.9 is insufficient for web/native sync today; current-core C bridge is only compile-proven. |
| Native metadata asymmetry | Medium–high | JS 3.5 exposes richer author/change/conflict attribution than Java 0.0.9. Merge Analyzer evidence must not depend on APIs missing from a platform backend. |
| Semantic conflicts above CRDT | High | Delete-vs-edit, logical duplicates, and suspicious merged recipes require application review logic. |
| History retention / compaction | Medium | Unresolved disagreements can be lost if destructive compaction is introduced without first materializing review evidence. |
| PWA payload | Medium | ~1.64 MB gzip isolated Automerge delta is material. |
| Native binary size | Medium | Native libraries are large enough to require final APK/IPA measurement. |
| Sync-session transport assumptions | Medium | Automerge sync state is intended for reliable in-order live transport; reconnect behavior must be explicit. |
| Native memory/lifecycle | Medium | Java and C-backed routes own native resources. Repeated open/load/free and app lifecycle stress need tests. |
| Official RN integration maturity | Medium | The official React Native repository remains a placeholder, so Creative Cooking would own the native bridge for now. |

## What a production implementation would require

1. Define a versioned replicated schema with stable IDs, maps-by-ID, explicit order lists, tombstones, and application-owned validators.
2. Implement the small `AutomergeBackend` contract and keep application code independent of JS Proxy/native binding details.
3. Migrate the existing `PersistedState` to the replicated schema once, with rollback/backup protection; do not put credentials into the document.
4. Keep the current logical JSON backup contract or explicitly version a replacement; backup restore must not silently rejoin stale peer sessions.
5. Add binary-friendly native persistence and direct binary IndexedDB persistence on web.
6. Implement a transport/session layer that recreates sync state on reconnect and can operate fully offline when no network exists.
7. Implement Merge Analyzer event materialization for clean concurrent merges, scalar disagreements, delete-vs-edit, duplicate pantry items, and suspicious merged recipes.
8. Preserve unresolved review evidence independently of any future history-pruning policy.
9. For iOS, wrap Automerge Swift behind the backend boundary and run the full common contract in an iOS runtime.
10. For Android, either wait for/prove a Java binding whose sync protocol interoperates with the chosen web version or build the minimal current-core C/Nitro bridge and run the full common contract plus cross-platform sync in an emulator/device.
11. Add version-skew interop fixtures to CI: web-produced binary, native-produced binary, bidirectional sync, same-scalar conflict evidence, and resolution.
12. Re-measure PWA bundle impact, cold load, repeated incremental sync, APK/IPA size, and native memory on representative devices before rollout.

## CI evidence

The experimental workflow `.github/workflows/automerge-spike.yml` keeps the normal project CI unchanged.

It produces machine-readable artifacts including:

- `scenario-results.json`
- `benchmark-results.json`
- `bundle-impact.json`
- `java-scenario-results.json`
- `java-web-sync-result.json`
- Swift/web conflict evidence JSON
- iOS simulator build/runtime logs
- Hermes probe logs
- Polygen/wasm2c logs
- current-core Android C build log/result
- Android instrumentation build/runtime reports

The normal Creative Cooking CI continues to run tests, typecheck, Expo PWA export/verification, Playwright, and Gitleaks.

## Bottom line of this spike

Automerge’s **document semantics are a strong match** for the required product behavior: clean concurrent fields merge, same-value disagreements remain recoverable, causal resolution is detectable, and the JS 3.5 history APIs contain enough evidence for a future low-noise Sync Activity / Merge Analyzer.

Native feasibility is **asymmetric today**. iOS via Automerge Swift is concretely viable and interoperable in the exercised path. Android’s official Java binding is useful but fails the required live sync interoperability against JS 3.5. The current Rust/C core compiles for Android, so a thin current-core native bridge is a credible next step rather than a reimplementation.

No overall engine winner is declared here, and no production rollout is performed.
