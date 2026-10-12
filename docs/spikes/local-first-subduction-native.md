# Subduction cross-runtime native interoperability — independent feasibility spike

**Status as of 12 October 2026: experimental; CI runtime evidence pending. NOT a production release or security certificate. Never merge.**

Umbrella: [issue #36](https://github.com/0cwa/creative-cooking/issues/36). This new draft-only branch (spike/local-first-subduction-native-interop) starts from main at a1c8993c4f45e9bb8de2b18d4f644088df99845a. No production AppState, backup, storage, screens, package, secrets, normal CI or Pages workflow is changed.

## Baseline and hard evidence separation

Read production README, docs/ARCHITECTURE.md, src/domain/types.ts, package.json and normal workflows. Read native engine research [#37](https://github.com/0cwa/creative-cooking/pull/37), [#38](https://github.com/0cwa/creative-cooking/pull/38), browser/Keyhive research [#40](https://github.com/0cwa/creative-cooking/pull/40), and evaluator interoperability research [#43](https://github.com/0cwa/creative-cooking/pull/43). PR #40 proves genuine Automerge bytes via Chromium/Subduction WASM/Rust redb/WS and longpoll, not native Expo. PR #43 additionally proves incremental Automerge and Loro ciphertext roundtrip with causal resolution and recoverable conflicts, but only **browser/relay**. A compiled native CRDT engine (PR #37 or #38) does not imply Subduction networking works on that device.

Source pins:

- Subduction commit [f0af1aab5f2fd44e5b224c22fc8b62660d50bc01](https://github.com/inkandswitch/subduction/tree/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01), Rust 1.91, core/CLI version 0.19.0, WASM via wasm-pack 0.14.0.
- Source read-only fixture/independent verifier: PR #43 commit [9c74e74247b926d9e0e6e3339739ad6882ea3e3e](https://github.com/0cwa/creative-cooking/commit/9c74e74247b926d9e0e6e3339739ad6882ea3e3e), Automerge JS 3.5.0 and Loro JS 1.16.4. Its fixture branch is not modified, only checked out into a separate directory.
- Target runtime: Expo 57.0.17, React Native 0.86.3, React 19.2.3, Node 22.13.0, Rust iOS simulator/device and Android ARM64 builds. The isolated workflow uploads a generated Cargo.lock and package SHAs; before those artifacts exist, the binary dependency graph is not claimed fully reproducible.

Inspected upstream native APIs: SubductionBuilder, subduction_core::MemoryStorage and OpenPolicy, sedimentree_core::SedimentreeId/CommitId/Blob, subduction_websocket::tokio::client::TokioWebSocketClient (real signed discovery handshake), add_commit, get_blobs, sync_with_peer, subduction_http_longpoll::HttpLongPollClient and subduction_iroh::client. WASM exports connectDiscover, connectDiscoverLongPoll and opaque Uint8Array commits. The pinned tree contains **no maintained Expo/Swift/Kotlin/UniFFI/JNI binding**. Upstream explicitly describes Subduction as an early unstable preview and warns not to use it in production.

## Isolated implementation and test design

The research-only module under [spikes/subduction-native/rust](../../spikes/subduction-native/rust) wraps actual Rust Subduction APIs, not an imitation protocol. It exports a bounded C ABI for iOS and JNI for Android, plus a **host-only** command-line probe. Its Tokio native client creates ephemeral test identity, performs real authenticated Subduction WebSocket discovery and sync, subscribes before writes, adds a binary commit with explicit causal parent IDs, reads back exactly opaque bytes, hashes them and serializes JSON. It uses OpenPolicy and memory storage deliberately.

The [standalone Expo 57 app](../../spikes/subduction-native/expo-probe) runs outside the production app. Its iOS simulator process calls the compiled Rust static library through an ExpoModule and writes result JSON to application Documents. Its Android ARM64 module packages the Rust shared object through JNI and performs the same handshake in the app process if and only if actually executed. An APK alone does not establish an Android runtime PASS.

The [adversarial Chromium spec](../../spikes/subduction-native/browser/native-interop.spec.ts) runs against a persistent, real upstream Rust CLI server. The static browser entry is served from /creative-cooking/ with real WASM, and it tests the same namespace on web and native. Every scenario carries **genuine independently generated Automerge and Loro incremental binary changes** in AES-GCM test envelopes, with distinct engine/space/document IDs hashed into separate Sedimentree IDs, and exact SHA256 checking.

The executable contract is:

1. Chromium sends base and a first concurrent edit to the Rust server, then disconnects. The server is terminated and restarted against its original redb storage and signing identity.
2. A native process uses upstream Subduction to catch up, publishes the conflicting second edit and returns actual bytes. The browser reconnects and reimports both engine histories: conflict alternatives 4 and 6 must be recoverable.
3. Chromium publishes the causal resolution 5. Duplicate delivery and idle re-sync must not create new commits.
4. Server stops/restarts again. Native application **terminates and relaunches as a new PID**, rebuilds a fresh sync session, catches up all four bytes and verifies original-engine projection and past 4/6 alternatives. A brand-new Chromium HTTP long-poll client catches up four bytes too.
5. Exact ciphertext byte hashes are checked both ways; no known fixture plaintext sentinel is permitted in relay files. The test distinguishes a Rust Linux host from an actual iOS/Android application.
6. Results and failures must write machine-readable JSON, logs and source/binary SHAs to GitHub Actions artifacts.

Separate experimental workflow: [.github/workflows/subduction-native-spike.yml](../../.github/workflows/subduction-native-spike.yml), with Linux host + Chromium (never mobile runtime), iOS simulator + device/simulator Rust compilation and Android ARM64 JNI + isolated Expo APK compilation. The simulator run is allowed to upgrade iOS execution only on actual installed Expo process JSON.

## Verification matrix — update only after inspecting fresh CI artifacts

This table is a **qualification gate**, not a claim of success. Source API inspection is verified, but no new actual-runtime results were captured when the report was first written.

| Claim | Current status | Required acceptance evidence |
| --- | --- | --- |
| Genuine upstream Rust Subduction API | SOURCE VERIFIED | Pinned source SHA, compiled binary + signed handshake |
| PWA under static /creative-cooking/ | PARTIAL (from PR #43's comparable browser proof) | This branch's real Chromium/WASM/relay test artifact |
| Rust host↔PWA exact binary updates | NOT TESTED | Real host process, server restart, SHA and verifier JSON |
| iOS simulator Rust archive | NOT TESTED | Targeted native build and binary SHA |
| iOS device Rust archive | NOT TESTED | aarch64-apple-ios artifact (compile-only) |
| iOS Expo runtime and app restart | NOT TESTED | simctl installed app, Rust networking, result.json and new PID |
| Android ARM64 JNI | NOT TESTED | aarch64-linux-android shared library compiled and hashed |
| Android ARM64 standalone Expo APK | NOT TESTED | Gradle build and packaged JNI binary (compile-only) |
| Android ARM64 app process runtime | NOT TESTED | Actual device/ARM64 emulator JSON, NOT a Linux host |
| Web↔native bidirectional bytes | NOT TESTED | Four exact opaque updates per engine, independent space IDs |
| Dedup, reconnect, relay restart, missed updates | NOT TESTED | Original server redb survives restart; native and browser both catch up |
| Engine reimport/conflict alternatives | NOT TESTED | Original engines prove concurrent 4/6, causal resolved 5 |
| Native WebSocket | SOURCE INSPECTED | Real signed native handshake against CLI |
| Native HTTP long poll | NOT IMPLEMENTED | Build/run upstream HTTP client through an actual Expo bridge |
| Native Iroh/QUIC and browser path | NOT IMPLEMENTED | Distinct native path and actual bridging with browser WS/HTTP |
| ARK E2EE, ACL, revocation or pairing | OUT OF SCOPE; NOT PROVEN | Security worklane, not transport byte test |

No PASS based on cargo check, C archive, IPA/APK size, browser-only evidence or fixture ciphertext alone. All evidence must identify OS, runtime, new PID, source versions, run/artifact IDs and exact byte SHA. A failed library integration must retain compiler logs as an explicit FAIL, not be hidden as a skipped test.

## Transport, lifecycle, ownership and estimate

Web PWA uses upstream Subduction WASM with WebSocket and optional HTTP longpoll. Native Rust currently uses Subduction's Tokio WebSocket client. Upstream native HTTP longpoll has a separate client API but is **not bridged to Expo in this repro**; an iOS/Android fallback cannot be assumed from browser longpoll passing. The Iroh QUIC client is native Rust only. Browser clients cannot be assumed to negotiate Iroh: a dual-transport Subduction relay/bridging topology needs its own proof.

To own a future integration, Creative Cooking would need: stable upstream Rust API pins and generated maintained FFI bindings or careful custom ABI ownership; Swift/C and JNI memory/exception boundaries; simulator+device/Android packaging and release signing; lifecycle subscriptions, network loss, background/resume and bounded retry; durable native signed identity and encrypted binary on-device persistence; schema migrations, binary integrity, rehydration, repair, storage compaction/review retention, version upgrades and crash diagnostics. The experimental **process-local memory storage** resets on relaunch and only the server durably retains redb; this is not a production offline storage adapter. Engineering scope is **substantial**, especially without maintained upstream mobile bindings.

Security is deliberately not tested: the CLI runs with --auth open, native peer uses ephemeral signer, binary fixtures use disposable AES-256-GCM only (NOT ARK or Keyhive), no real protected ACL, household pairing, revocation or no-key-relay guarantee. The separate adversarial Keyhive/ARK worklane must independently establish those properties.

**Decision held:** no production migration, no selected final stack, no merge. This worklane may only qualify mobile Subduction transport/runtime with actual platform evidence.
