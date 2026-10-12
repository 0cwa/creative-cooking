# Subduction + Keyhive/ARK: replication feasibility spike

**As of 12 October 2026 — research only; NOT a shipping recommendation or architecture winner. Leave draft.**
Umbrella [#36](https://github.com/0cwa/creative-cooking/issues/36). Separate Automerge [#37](https://github.com/0cwa/creative-cooking/pull/37), Loro [#38](https://github.com/0cwa/creative-cooking/pull/38), and p2panda/Iroh spikes.

> **Critical upstream warnings.** Subduction says it is an early release preview, its API is **very unstable**, and **DO NOT use for production**. Keyhive says **pre-alpha, DO NOT use in production**, has **not had a security audit**, and its nonce/key-commitment construction has not been independently reviewed. ARK is alpha. A functional protocol demo does not supersede these warnings.

## 1. Baseline and exact pins

Inspected current main at `a1c8993c4f45e9bb8de2b18d4f644088df99845a` before branching: [README](../../README.md), [architecture](../ARCHITECTURE.md), [AppState](../../src/state/AppState.tsx), [domain types](../../src/domain/types.ts), [web storage](../../src/storage/appStorage.web.ts), [native storage](../../src/storage/appStorage.ts), [backup schema](../../src/storage/backupFormat.ts), package.json, GitHub Actions, and existing open PRs/issues.

Creative Cooking is Expo **~57.0.17** / React Native **0.86.3** / React **19.2.3**, with a static GitHub Pages PWA using IndexedDB and native AsyncStorage. The PWA must remain useful completely offline. Provider secrets live in a **separate vault** and are absent from `PersistedState` and its JSON backups. No provider/device-only secrets may enter replicated state. Opt-in device sync must not impose an account or force inventory administration.

Baseline main: [CI passing](https://github.com/0cwa/creative-cooking/actions/runs/35992984449), [Pages passing](https://github.com/0cwa/creative-cooking/actions/runs/35992984724). No app files, ordinary persistence, backup or production workflows changed.

| Component | Exact pin and version | Maturity |
| --- | --- | --- |
| [Subduction](https://github.com/inkandswitch/subduction/tree/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01) | Commit `f0af1aab5f2fd44e5b224c22fc8b62660d50bc01` (2026-10-07); CLI crate **0.19.0**; prerelease `v0.19.0-nightly.2026-10-07` | Explicit **not for production**, unstable API |
| Browser Subduction WASM | Same commit; source manifest `@automerge/subduction` **0.24.0** | Preview; package manifest is not evidence of stable npm compatibility |
| Automerge/Subduction WASM bridge | Same commit; source manifest `@automerge/automerge-subduction` **0.19.0** | Experimental bridge |
| [Keyhive](https://github.com/inkandswitch/keyhive/tree/b7968be799705492428c94226ca28042c733a9e0) | Commit `b7968be799705492428c94226ca28042c733a9e0` (2026-10-01), Rust workspace **0.0.0-alpha.3**, WASM prerelease `keyhive-wasm/0.3.0-alpha.1` | **Pre-alpha; unaudited** |
| [Automerge Repo Keyhive / ARK](https://github.com/automerge/automerge-repo-keyhive/tree/5d09e8c8cfdebd5656b1426b66aea6b1395f83da) | Commit `5d09e8c8cfdebd5656b1426b66aea6b1395f83da` (2026-09-25), package **0.6.0-alpha.1** | Alpha; depends on automerge-repo **2.6.0-subduction.48**, automerge-subduction **0.16.1**, keyhive **0.3.0-alpha.1** |
| Automerge test engine | `@automerge/automerge@3.5.0` | Released core, used only for fixture binary changes |
| Native Rust toolchain | **1.91.0** (pinned by upstream) | A build requirement; not evidence of Expo-native support |

Note the **ARK bridge version 0.16.1 vs Subduction HEAD bridge 0.19.0** discrepancy. Do not mix packages on assumption of wire/API compatibility. Source anchors: [Subduction README](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/README.md), [CLI source](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/subduction_cli/src/server.rs), [redb storage](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/subduction_redb_storage/README.md), [Keyhive README](https://github.com/inkandswitch/keyhive/blob/b7968be799705492428c94226ca28042c733a9e0/README.md), [ARK guide](https://automerge.org/docs/keyhive/ark-api-guide/) and [ARK manifest](https://github.com/automerge/automerge-repo-keyhive/blob/5d09e8c8cfdebd5656b1426b66aea6b1395f83da/package.json).

## 2. Evidence labels and executable experiment

- **UPSTREAM** = code and/or test inspected at exact upstream commit, **not** independently executed in this project.
- **SPIKE CI PASS** = executed successfully in [experimental run #38183684382](https://github.com/0cwa/creative-cooking/actions/runs/38183684382) at commit `2a29f28f18655aee2ef694966613f75c6e4c00c6`; this proves only the specific exercised scenarios, not Keyhive/ARK security.
- **NOT PROVEN** = missing device/crypto/security evidence or a precisely stated blocker.

Experimental files are [fixture generator](../../scripts/spikes/local-first-subduction-keyhive/make-fixtures.mjs), [browser test](../../scripts/spikes/local-first-subduction-keyhive/creative-cooking.spec.ts) and the [opt-in experimental workflow](../../.github/workflows/subduction-keyhive-spike.yml), all isolated from production.

The generator uses **genuine binary Automerge incremental changes** with three deterministic *domain edits*, rather than shipping JSON snapshots: (1) pantry addition (chickpeas), (2) recipe addition (structured two-portion recipe), and (3) chat append. Each *change* is separately AES-256-GCM encrypted with a fresh ephemeral test key and nonce. Change-digest-derived commit IDs and causal parents identify Subduction blobs. The app-side test holds the encryption key and replays the decrypted changes through Automerge. No provider keys are used.

The Playwright test exercises two independent Chromium browser contexts against a **real local upstream Subduction CLI** and persistent redb directory:

1. WebSocket connect and initial A-to-server-to-B sync, decrypt/replay pantry update.
2. Disconnect B; A adds recipe; A uploads and disconnects; **stop/restart** Subduction using **same key file and data dir**; B reconnects *with A offline* and catches up.
3. Reconnect A; add third chat commit; B catches up; repeat idle sync and compare `commitsReceived`; repeat duplicate commit, disconnect/reconnect.
4. Create third browser using **HTTP long poll**; fetch, decrypt, reconstruct all three updates.
5. Inspect on-disk `sedimentree.redb` and content-addressed blobs for known plaintext markers; record evidence JSON, object-count stats and actual encrypted fixture sizes.

**Scope warning:** The test server deliberately runs **`--auth open`** to isolate Subduction's basic transport; this is **insecure for users**. The fixture encryption is independent AES-GCM, **NOT Keyhive/ARK E2EE**. Successful plaintext-sentinel scanning does not establish a security audit, protect metadata, prove a decryption key is absent in a different stack, or show authorization/revocation works.

Reproduce using workflow instructions: checkout upstream exactly at the pinned SHA, Rust 1.91, wasm-pack, Node 22/pnpm 9, build `subduction_cli` and `subduction_wasm` for browser, generate fixtures with installed Automerge 3.5.0, run the supplied Playwright test and selected upstream `relay_topology_sync`, `addbatch_storage_durability` and `responder_cache_fast_path` tests. Normal app CI still runs independently. Network access is used only to download code/tools and dependencies, **not** to contact public sync or identity services.

## 3. Scenario matrix

| Feature / scenario | Verified status (2026-10-12) | Proof or blocker |
| --- | --- | --- |
| PWA (1, 8) | **PASS browser WASM harness; Expo integration NOT PROVEN** | Browser clients connect via WS and HTTP; production Expo static export and SW integration not tested |
| iOS (14) | NOT PROVEN | No iOS Rust binary, Expo custom module, CocoaPods, native runtime/Hermes test |
| Android (14) | NOT PROVEN | No Android NDK cross-build, Expo module, Gradle integration, emulator/device run |
| WebSocket (1, 5) | **SPIKE CI PASS** | Two separate Chromium clients exchanged encrypted Automerge changes with local Rust CLI |
| HTTP long poll (6) | **SPIKE CI PASS** | Third browser received, decrypted and reconstructed all three changes |
| Iroh (7) | **SPIKE CI PASS for native direct-only** | Pinned upstream local QUIC test between two Rust CLI servers passed; Iroh relay fallback/browser/mobile remain NOT PROVEN |
| Durable offline catch-up (2) | **SPIKE CI PASS** | B offline, A uploads and disconnects, relay restarts, B catches up solely from server durable store |
| Server persistence (3) | **SPIKE CI PASS** | Real `sedimentree.redb` and stable signing key retained across server process restart |
| Duplicates, reconnect, incrementality (4) | **SPIKE CI PASS for commit-object convergence; partial packets NOT PROVEN** | 3 incremental changes; duplicate/reconnect kept count=3, idle received=0; no measured wire bytes or mid-packet interruption |
| E2EE / relay plaintext blindness (9) | **Fixture-only SPIKE CI PASS; ARK NOT PROVEN** | AES-GCM encrypted actual changes, client decryption/replay, redb plaintext markers absent; server `--auth open` and no Keyhive E2EE tested |
| Relay-only permission (10–11) | SOURCE-VERIFIED; end-to-end NOT PROVEN | Relay fetch vs Edit author put code; no permission lifecycle test |
| Delegation / second device (12) | Documented API; NOT PROVEN | ARK contact cards/member grant, no cryptographically verified QR/invite/historical-key test |
| Revocation (13) | Documented API; NOT PROVEN | ARK revoke API; no proven forward secrecy or immediately enforced remote device removal |
| Self-hosting / cost (15) | **Local CLI functional; operations NOT PROVEN** | CLI + redb disk tested; TLS proxy, backups/restores, quotas and hosting budget not validated |
| API stability | **UNSTABLE** | Explicit Subduction early-preview + ARK alpha and Keyhive pre-alpha |
| Audit/security maturity | **NOT READY** | Keyhive unaudited, nonce/key commitment unreviewed, concrete policy issues below |

**Executed and verified:** [experimental run #38183684382](https://github.com/0cwa/creative-cooking/actions/runs/38183684382) and [standard Creative Cooking CI #38183684385](https://github.com/0cwa/creative-cooking/actions/runs/38183684385) both passed at `2a29f28f`. Security/Expo-native gaps remain unproven.


### Executed evidence: local-only pinned GitHub Actions

[Experimental run #38183684382](https://github.com/0cwa/creative-cooking/actions/runs/38183684382) **succeeded** at `2a29f28f18655aee2ef694966613f75c6e4c00c6`. [Ordinary CI #38183684385](https://github.com/0cwa/creative-cooking/actions/runs/38183684385) was **green** on the same commit, covering normal typecheck, PWA export, app E2E and Gitleaks. All infrastructure in the test was local; source/tool dependencies were downloaded as usual.

| Executed suite | Recorded outcome |
| --- | --- |
| Pinned upstream `relay_topology_sync` | **14 passed**, 0 failed |
| Pinned upstream `addbatch_storage_durability` | **4 passed**, 0 failed |
| Pinned upstream `responder_cache_fast_path` | **5 passed**, 0 failed |
| Native Linux `cargo check -p subduction_core -p subduction_iroh -p subduction_keyhive` | **PASS**; *not* iOS or Android compilation |
| Pinned upstream direct-only Iroh/QUIC Rust CLI E2E | **1 passed**, 0 failed; *not* public relay fallback |
| Creative Cooking two-browser + long-poll encrypted fixture E2E | **1 passed**, 0 failed |

The browser test created three distinct **actual Automerge binary changes**, each independently AES-256-GCM-encrypted under a fixture key present in the app-side test, not the relay. Recorded source plaintext change sizes: **172, 385 and 293 bytes**; encrypted blob sizes: **200, 413 and 321 bytes** (each includes 12-byte nonce, 16-byte tag). This is *not* a total wire-byte accounting.

| Checkpoint | Observed commit counts | Implication |
| --- | --- | --- |
| WebSocket A initial upload → B first sync | A sent **1**, B received **1**, B count **1** | New encrypted pantry change reached second browser |
| B disconnect, A edit/upload and disconnect; server stop/restart; B reconnect | B received **1**, B count **2** | Offline catch-up from durable **redb**, with A absent and server restarted using same signing seed |
| A third incremental chat edit | B count **3** | Third change eventually reached B; explicit pull reported 0 received because async subscriber push already delivered it |
| Duplicate commit; idle sync | B count remains **3**; idle **0 received** | No duplicate accumulation; not a wire-bandwidth benchmark |
| Clean WebSocket reconnect | B count remains **3** | Reconnect did not lose previous state |
| New browser C via HTTP long poll | C received **3**, count **3** | Independent HTTP client reconstructed the complete Automerge fixture stream |
| Relay persistent representation | `sedimentree.redb` present; tested cooking-data plaintext markers absent | Ciphertext fixture stored, plaintext sentinels not present; **not** a security audit or Keyhive proof |

**Important integration discoveries:** a previously unknown sedimentree is **not automatically uploaded** by `addCommit` alone: a subscribing sync (`subscribe=true`) is required to establish history with the relay. Asynchronous propagation is not guaranteed to be visible immediately upon a successful sync response. The final deterministic test uses bounded polling, matching upstream's own relay-topology tests, instead of assuming synchronous delivery.

**Limitations:** neither mid-packet interruption nor network byte totals were measured. `--auth open` was intentionally used, so none of these passed transport tests prove Keyhive relay-only permissions, ARK document protection, historical key distribution, delegated edit/admin roles, revocation/rekeying or multi-user isolation. The Linux compilation is not native Expo 57, iOS or Android evidence. The upstream experimental and unaudited warnings remain unchanged.

## 4. Subduction vs plain Automerge synchronization

Automerge handles local CRDT documents, changes, application-level merges and ordinary sync-state messages. Subduction adds **Sedimentree** history partitions and metadata diff/minimization, subscriptions/relay forwarding, incremental change/fragment dissemination, signed transport handshakes, multiple transports (WebSocket, HTTP long-poll, Iroh/QUIC), persistent CLI server storage, and Keyhive document ACL hooks. This may permit a service to replicate encrypted binary histories without opening recipe plaintext.

It does **not** select which pantry/recipe/chat documents belong to personal/shared spaces, resolve domain-level conflicts, supply a user-friendly device-pairing UI, or substitute for native storage/backup/recovery. Encrypted payloads do **not** hide peer IDs, sizes, timing, access patterns or all tree metadata.

**Live P2P vs durable asynchronous:** two devices connected at once can swap changes without a hosted store; a disconnected B cannot catch up after A vanishes unless another peer or service durably retains the changes. The CLI's redb+filesystem persistence is the proposed always-reachable third peer. Uninterrupted replication only works for document IDs the server knows and retains. [Upstream Iroh E2E](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/subduction_cli/tests/iroh_e2e.rs) explicitly states **no sedimentree discovery protocol yet**, so it seeds both servers for the same tree. Secure invitation/tree discovery remains Creative Cooking's responsibility.

**Incrementality:** upstream exposes `commitsReceived`/`commitsSent` and fragment transfer statistics. A second/third edit should move deltas; idle repeats should move zero new commit blobs. A zero-commit check is **not** proof of low wire bandwidth: metadata/handshake frames still cost bytes. Quantitative network byte accounting and large-history compaction are future work.

## 5. Static GitHub Pages PWA and server architecture

~~~text
Creative Cooking GitHub Pages static PWA -- opt-in WSS / HTTPS long poll
    | IndexedDB persists local app offline
    v
https://sync.example.org (TLS cert, reverse proxy, upgrade + long poll)
    v
Subduction Rust CLI on localhost (stable Ed25519 signing key; auth policy)
    | /var/lib/subduction/sedimentree.redb  (transactional)
    | /var/lib/subduction/blobs/**          (large immutable blobs)
    | /var/lib/subduction/.keyhive/**      (when Keyhive enabled)
    ^
    | WebSocket or native QUIC/Iroh (only after mobile integration)
native iOS/Android app: native local DB + native identity/FFI
~~~

**Yes, the frontend may remain entirely static**. GitHub Pages itself cannot host a WebSocket listener, long-poll process or persistent volume. Additional requirements: a Subduction executable, stable `--key-file` **not `--ephemeral-key`**, `--data-dir` on persistent disk, stable `--service-name` matching client handshake configuration, HTTPS/WSS reverse proxy, long-poll path routing, CORS/origin configuration, web subpath WASM asset resolution and CSP checks. Enable WebSocket Upgrade and suitable read timeouts; long polling is more friendly to restrictive proxies but has repeated HTTP headers and active request/session overhead. All cloud sync endpoints remain optional; offline app features never block on them.

**Iroh:** current CLI `--iroh` is opt-in; `--iroh-direct-only` uses LAN/direct QUIC; default attempts public relay fallback and `--iroh-relay-url` configures a self-hosted alternative. The browser uses WSS or HTTP to a logical peer; it does **not** use native Iroh QUIC in ordinary browsers. Bridging both to the same actual stored document/authorization namespace needs independent end-to-end proof.

## 6. Security, roles, identities and revocation

[ARK API guide](https://automerge.org/docs/keyhive/ark-api-guide/) documents identities backed by persisted Ed25519 keys, signed contact cards, cryptographic group/document access, and ordered **relay < read < edit < admin**. With `initializeAutomergeRepoKeyhive`, protect documents using **`repo.create2`** and grant sync server **Relay** via `hive.addSyncServerRelayToDoc(handle.url)`; **`repo.create` silently bypasses the protected ID factory and creates an unprotected document**. Separate Keyhive identity storage from ordinary Automerge doc storage and provider credentials. A self-hosted sync server's peer ID must agree with the configured `SyncServerIdentity` contact card; otherwise grants can target the wrong identity or fail silently.

| Level | Intended effect | Current source evidence and caveat |
| --- | --- | --- |
| **relay** | Fetch and replicate ciphertext without a document decryption key | Keyhive policy's `authorize_fetch_with` allows at least Relay; no live no-key relay test in this branch |
| **read** | Relay plus decrypt/read document | Requires successful document secret access; not tested |
| **edit** | Read plus sign/create new document updates | Policy checks verified **author** has Edit for put |
| **admin** | Manage/transfer member rights as well as edit | ARK exposes grant/revoke, not tested end to end |

**Verified implementation limitations (not theoretical concerns):**

1. [CLI policy](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/subduction_cli/src/policy.rs) explicitly returns allow for **legacy/unprotected document IDs**, bypassing Keyhive storage ACL. Private/shared space services must reject these at ingress or enforce a safe separate namespace.
2. [Keyhive put policy](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/subduction_keyhive/src/policy.rs) documents **TODO: only `author` currently checked for Edit**; a forwarding `requestor` with no Relay grant is not separately checked.
3. `authorize_connect_with` currently confirms a parseable Ed25519 peer ID, **not** household membership. Handshake authentication is not document authorization.
4. Public-member grants can intentionally allow anyone to fetch/edit; prevent accidentally public household documents.
5. Keyhive source explicitly admits unaudited crypto. Real Keyhive E2EE/ACL is **not** proven by this fixture's test-only AES-GCM encryption.

**Delegate/new device:** obtain a verified signed contact card for device B, authorize its intended per-document role with `hive.addMemberToDoc`, replicate the authorization record, and give it historic doc access as appropriate. This may be presented as a QR invitation containing public identity, encrypted invitation and document references — **not provider credentials or existing private plaintext** — but QR verification and historical key delivery have not been proved. ARK's membership change currently rotates keys and may write an internal membership-timestamp field to an Automerge doc; omit it from recipe editing UI.

**Revoke:** `hive.revokeMemberFromDoc` exists, but a removed/offline device may retain cached old keys, already-decrypted recipe/chat information, ciphertext and backups. Revocation can at best protect *future* updates after correct rekeying and policy propagation. It cannot remotely wipe prior data. Rejected future writes, queued commits during partition, stale relay ACL caches, historical access and offline rejoin **must be tested**.

For the future personal/private vs household/shared model, separate document/space keys and explicit allowlists. Pantry and chosen recipes might be shared; personal allergies, chat and preferences may be device/personal-only; **provider keys never replicate**. Do not build the app around a universal synced `PersistedState` blob.

## 7. Operational burden, persistence, backups and costs

The current CLI is **not** just an ephemeral message forwarder. [`subduction_redb_storage`](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/subduction_redb_storage/README.md) uses redb B+trees for metadata/small blobs **up to 16 KiB**, stores larger blobs as content-addressed files, fsyncs redb commits and fsyncs files before referencing them. Old `sedimentree_fs_storage` is not the present CLI default. It supports `subduction migrate --from ... --to ...` for old stores.

A deployment operates a Rust CLI process, TLS/reverse proxy/DNS, persistent disk, stable server signing seed, Keyhive identity/archives/events (under `.keyhive`), session/connection limits, metrics and monitoring, upgrade staging, tenant quotas and backups. **Back up the whole redb + blob directory + .keyhive + signing seed as a consistent recovery unit**, ideally stopping/quiescing writes; upstream warns a live file copy can capture a torn redb database page. Restore testing is essential. External content-addressed blobs currently lack full garbage collection after document deletions.

Operational risks: high retained histories, attachment growth, multi-tenant isolation, remote untrusted peers, abuse/rate limiting, authentication confusion, disk full, stale backups, server outage, protocol version migration, large payloads, browser/service-worker WASM version skew and Keyhive secret recovery. CLI metrics include process/storage gauges and optional Prometheus; any **admin/inspection endpoint with no authentication must bind only localhost**. Browser and mobile need bounded backoff and offline-first UX.

No benchmarked RAM/CPU/throughput/disk budget, tenancy density or vendor cost has been measured. A small self-hosted VPS with storage and TLS might cost on the order of a few to tens of dollars/month *before* backups/egress/operational labor, **illustrative only**. Self-hosting is plausible for technically capable households but not a zero-ops default. A hosted service can remain **plaintext-blind only with carefully audited crypto and authorization**, not merely by turning on TLS.

## 8. Answers to the ten evaluation questions

1. **Beyond plain Automerge sync messages?** Sedimentree incremental encrypted-history replication, pluggable transports, persistence/relay and authorization hooks; no application recipe merge rules.
2. **Durable asynchronous catch-up?** **Controlled local spike PASS:** B recovered data while A was offline and after Subduction restarted with the same redb and signer. An always-reachable durable peer is needed; production durability/availability not proven.
3. **Can the server stay unable to read cooking data?** **Fixture-only PASS:** encrypted Automerge changes replayed on clients and no known plaintext marker appeared in persisted server bytes. The server did not receive the AES fixture key. **Real Keyhive/ARK E2EE is NOT proven**; metadata remains visible.
4. **Static PWA?** Yes, with an additional hosted WSS/HTTPS service. Real Chromium WASM clients passed WS/HTTP transports, but actual Expo PWA bundle/service worker integration remains untested.
5. **New server?** Subduction CLI + stable signing identity + redb/blob persistent volume + optional Keyhive state, reverse proxy/TLS and backup/monitoring.
6. **iOS/Android?** Custom Rust native library bridge/Expo dev build, FFI, platform key storage, lifecycle and native compilation/device tests. No verified existing ready-made bridge.
7. **Keyhive/ARK usability?** APIs exist for protected docs/identity/grants/revocation, but alpha/pre-alpha, unaudited and moving packages; not viable to adopt as production dependency today.
8. **Relay/read/edit/admin useful?** Yes conceptually for personal and household spaces; source ACL code exists but end-to-end roles and enforcement gaps need resolution.
9. **Revocation usable for device removal?** API present, no tested future-secret/writer enforcement; never retroactively revoke already obtained information.
10. **What blocks shipping?** Explicit upstream production warnings, audit/review gap, ACL caveats including unprotected-ID bypass, ARK package mismatch, native mobile bridge, invite/security/recovery design, production operation/testing.

## 9. Next proof gates, without declaring a winner

- First validate the pinned **two-browser + WebSocket + redb restart + offline catch-up + HTTP long-poll** CI, and collect measured bytes/fragments, partial-transfer interruption and performance, not only commit counts.
- Run a *separate* ARK identity/security E2E against correctly version-matched released alpha packages: relay-only server with no decryption key, read/edit/admin negative cases, delegation/historical access, revocation/rekeying and stale-device attacks; harden unprotected-ID admission and put-requester ACL.
- Build the smallest usable native iOS and Android Rust/Expo component and exercise actual runtime; otherwise document the exact cross-build or bridge blocker.
- Keep the existing app usable forever offline and do not replicate credentials/device-only settings.

**No overall local-first architecture winner is declared.** Automerge with a simpler interim transport while waiting for Subduction/Keyhive maturity is a valid future choice.

---

## 10. Adversarial Keyhive/ARK security investigation — 12 October 2026

**Outcome: NOT PRODUCTION READY; the current transport and ACL architecture is **unsafe if legacy document IDs are accepted as private/shared household documents**.** This is an intentionally **failing security experiment**, NOT a blanket assertion that protected documents can be decrypted by outsiders. A negative test failing here means the upstream authorization boundary was shown to permit an operation that the hypothetical private-household service must reject.

This follow-up did **not** repeat the real Automerge/Loro binary opacity proof in [PR #43](https://github.com/0cwa/creative-cooking/pull/43). Its purpose is identity, protected-document generation, cryptographic access, authorization, pairing and revocation—not engine selection.

### 10.1. Executed, independently pinned dependency sets (do not combine them blindly)

| Scope | Exact source/dependency graph | Executed/runtime | What is *not* established |
| --- | --- | --- | --- |
| **ARK JS + Keyhive WASM** | ARK [`5d09e8c8cfdebd5656b1426b66aea6b1395f83da`](https://github.com/automerge/automerge-repo-keyhive/tree/5d09e8c8cfdebd5656b1426b66aea6b1395f83da), version **0.6.0-alpha.1**; **frozen upstream `pnpm-lock.yaml`**, `@automerge/automerge-repo 2.6.0-subduction.48`, `@automerge/automerge-subduction 0.16.1`, `@keyhive/keyhive 0.3.0-alpha.1`, Node **22**, pnpm **10.15.0** | Exact graph installs and builds; actual WASM identity, protected document, crypto and ARK `buildServerSubductionPolicy` exercised with Vitest in [security run #38251954609](https://github.com/0cwa/creative-cooking/actions/runs/38251954609) | Not an authenticated HTTP/WS/QUIC transfer to a Rust CLI, not an end-to-end package compatibility certification |
| **Rust Subduction CLI and Chromium WASM** | Subduction [`f0af1aab5f2fd44e5b224c22fc8b62660d50bc01`](https://github.com/inkandswitch/subduction/tree/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01), native CLI/core **0.19.0**, Subduction browser WASM **0.24.0**, Rust **1.91.0**, wasm-pack **0.14.0**, Node **22**, pnpm **9** | Real pinned CLI started with **`--auth keyhive`** (NEVER `--auth open`), stable test signer, redb persistence and different signed Ed25519 WebCrypto Chromium clients in [security run #38251954609](https://github.com/0cwa/creative-cooking/actions/runs/38251954609) | Test clients are not ARK-managed protected document owners; no new-device grant was replicated onto the Rust relay |
| **Native Keyhive core, independently isolated** | Keyhive [`b7968be799705492428c94226ca28042c733a9e0`](https://github.com/inkandswitch/keyhive/tree/b7968be799705492428c94226ca28042c733a9e0); `keyhive_core` crate **0.6.0**, workspace Rust **1.91.0** | Separate [owned executable core adversarial suite](../../scripts/spikes/local-first-subduction-keyhive/keyhive-core-security.rs), compiled and executed in dedicated isolated workflow job. **PASS: 5/5** at [run #38266039641](https://github.com/0cwa/creative-cooking/actions/runs/38266039641), covering independent role decryption, delegation/attenuation, prekey recovery, offline revocation/rejoin and archive restoration; native component-only | Native library tests are not a browser/Expo/ARK integration or remote server enforcement test |

**Version-skew gate:** At the pinned ARK revision its bridge is `@automerge/automerge-subduction 0.16.1`, whereas the pinned Rust Subduction source builds bridge **0.19.0**. An accidental mix of these releases is **not** a coherent proven ARK→Rust E2EE stack. The ARK package graph *itself* builds with its lockfile; the native CLI/browser graph *itself* builds. We must prove the combined signed-wire protocols at exact compatible versions before claiming end-to-end E2EE, pairing or revocation. No upstream sources have been patched.

**Upstream security update, 12 October 2026:** At the source inspection, Subduction `main` remained `f0af1aa` and ARK `main` remained `5d09e8c`. Keyhive advanced beyond `83e079d`: [upstream security fix #250](https://github.com/inkandswitch/keyhive/pull/250), merged as exact commit [`a864f5c8159215a03fbdc5f0d042dff47f3ac0c0`](https://github.com/inkandswitch/keyhive/commit/a864f5c8159215a03fbdc5f0d042dff47f3ac0c0) at 14:57:33 UTC, prevents **a malicious identity revoking someone else by citing a third party's delegation as proof**. Our *independent identical-code before/after executable regression* below confirms the **pinned** `b7968be` is vulnerable and the newer fixed version rejects this attack. The fix has **not** been brought into ARK's pinned dependency graph, nor does it fix Subduction/ARK legacy-ID and requester-Relay gaps. [Keyhive SECURITY.md](https://github.com/inkandswitch/keyhive/blob/b7968be799705492428c94226ca28042c733a9e0/SECURITY.md) still says **DO NOT use in production**, pre-alpha and unaudited with nonce/key-commitment construction awaiting independent review; Subduction also warns against production and ARK remains alpha. No independent cryptographic audit or production-readiness statement is demonstrated.

### 10.2. Fail-closed adversarial matrix — expected versus observed

Evidence labels are strict: **EXECUTED JS POLICY** invokes ARK's actual policy with genuine Keyhive WASM keys and grant events (the caller/author tuple is passed directly; no signed-wire author verification); **EXECUTED RUST WIRE** runs two cryptographically distinct clients through a live `--auth keyhive` Subduction CLI; **EXECUTED WASM** invokes actual Keyhive cryptographic API; **UNPROVEN** means not independently demonstrated. `FAIL` means an explicit security invariant was violated, not that the harness should be made green.

| Attack / permission scenario | Required/expected outcome | Observed outcome and evidence level |
| --- | --- | --- |
| Protected owner creates cooking document | Generate protected 32-byte ID with real Keyhive factory, not legacy `Repo.create` | **PASS — EXECUTED WASM/ARK.** `Repo.create2` with `keyhiveIdFactory`, generated actual **32-byte** ID with nonzero tail; `hasDocument` true |
| Owner encrypts and decrypts synthetic cooking bytes | Plaintext inaccessible without content keys; owner decrypts | **PASS — EXECUTED WASM.** **57 plaintext bytes → 286 ciphertext/envelope bytes**, owner recovered original, ciphertext did not contain literal plaintext; independently authenticated owner secret |
| Relay fetch, no read key | Relay may retrieve ciphertext; cannot decrypt | **PASS at JS policy**: Relay fetch granted. **PASS at WASM crypto boundary**: separate Relay-only Keyhive identity unable to decrypt **285-byte envelope**; no remote no-key relay E2E proven |
| Read fetch/decrypt | Authorized separate reader can decrypt | **PASS policy** for Read fetch; **UNPROVEN/INTEGRATION FAILURE cryptography**: independent reader with signed archive ingested *could not decrypt* a 56-byte content/285-byte envelope, although protected document known; full pairing/event/key epoch propagation incomplete |
| Edit or Admin fetch/put | Both can read and write; only Admin delegates | **PASS JS policy**: Edit and Admin fetch and put allowed, Edit requirement rejects Read/Relay authors. Native Keyhive delegation needs separate executed core proof |
| Read or Relay attempts Edit put | Deny | **PASS — EXECUTED JS POLICY**: both rejected `insufficient access ... requires at least Edit` |
| Cross-household outsider fetches protected ID | Deny | **PASS — EXECUTED JS POLICY**: rejected, requires at least Relay. Separate outsider Keyhive identity could not decrypt sampled envelope (WASM) |
| New-device signed membership propagation | Verified contact card plus entitlement and **actual key** available to recipient | **PARTIAL — EXECUTED WASM**: signed membership archive ingested by distinct identities (**13,430 bytes**) but recipient positive decryption **not achieved** in ARK experiment; this is not successful verified pairing |
| **Forged signed revocation referencing someone else's delegation** | Mallory must not revoke Bob using Alice's founding delegation proof; Bob retains authorized Read | **FAIL — EXECUTED KEYHIVE CORE on pinned `b7968be`:** forged Ed25519-signed revocation was accepted (`UNAUTHORIZED_REVOKE_ACCEPTED`), so the expected-denial test fails. **PASS — independent identical test against upstream `a864f5c` fix:** returns `DENY` and preserves Bob's Read. Both full source checkouts unpatched, Rust 1.91, local synthetic keys, reproducible [run #38267512881](https://github.com/0cwa/creative-cooking/actions/runs/38267512881) and [before/after transcripts with resolved Cargo.lock files](https://github.com/0cwa/creative-cooking/actions/runs/38267512881/artifacts/11755023440). The fix is **not** in the evaluated stack and is not a full network revocation test |
| Signed contact-card tampering | Reject a modified `KeyOp::Add` or `Rotate` signature and disallow identity admission | **FAIL — EXECUTED WASM admission probe** in [run #38266039641](https://github.com/0cwa/creative-cooking/actions/runs/38266039641): a previously unknown synthetic contact card with its first Ed25519 signature byte flipped was received, and `getAgent` changed from absent to present. This shows **unverified agent graph admission at this API boundary**; it does **not** show a forged delegation, signing-key possession, document access, or a network pairing exploit. The probe checks admission after the call, not merely whether parsing threw |
| Role change Read→Edit, revoke, regrant Read | Read denied put, Edit allowed put, removed denied, regranted Read still denied put/allowed fetch | **PASS — EXECUTED JS POLICY** for all five grant/revoke/downgrade checks |
| Removed reader receives future group keys | Deny decryption after fresh rotation and authorization propagation | **UNPROVEN at ARK**: baseline second reader could not decrypt even before revocation, so a post-revoke denial cannot prove forward-secrecy; native Keyhive test is a separately executed core control |
| Historical plaintext and old backups on revoked device | Cannot be erased remotely | **BY DESIGN**, not a passing erase test. Assume old ciphertext/plaintext/keys remain available and protect only future epochs |
| Offline rejoin and queued stale-author writes | Latest ACL converges, revoked device does not regain future keys, queued unauthorized edits denied | **UNPROVEN as full Rust/ARK signed-wire E2E**. Core test exercises a stale archive offline rejoin, but cannot stand in for durable relay queued edit authorization |
| Unauthenticated forwarding with an authorized editor identity | Requester lacking Relay must **not** forward even when author is authorized to Edit | **FAIL — EXECUTED JS POLICY**: `authorizePut` **granted** an ungranted requester presenting a real Edit author's identity; Rust [`subduction_keyhive` policy](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/subduction_keyhive/src/policy.rs) has corresponding TODO for separate requester validation. A cryptographically forged-author wire submission has **not** been demonstrated |
| Legacy/unprotected 16-byte ID zero-padded to 32 | In a private-household namespace, ungranted client put and fetch both **DENY** | **FAIL — EXECUTED JS POLICY**: ARK fetch allowed without any Keyhive grant. **FAIL — EXECUTED RUST WIRE**: ungranted signer A uploaded a legacy commit, relay restarted, independent ungranted signer B retrieved **one** commit. Native policy is explicit about allowing legacy IDs |
| Unknown *protected-shaped* document ID not granted to client | Reject put and fetch | **PASS — EXECUTED RUST WIRE**: no server grant/known tree, upload sync failed and second client received **0** commits. This does not prove successful authorized protected-ID sync |

**Exact critical Rust wire execution:** [Actions run #38251954609](https://github.com/0cwa/creative-cooking/actions/runs/38251954609), Chromium test `adversarial-relay.spec.ts`, pinned commit `f0af1aab5f2fd44e5b224c22fc8b62660d50bc01`, real CLI `server --auth keyhive`, 2 distinct Ed25519 handshake signers and persistent `sedimentree.redb`. `pushOutcome={success:true,sent:1}` → stop/restart server with same test signing seed and redb → B `receiver={success:true,received:1,commitCount:1}`; both original and retry **reproduced**. Expected `commitCount=0`. The job **FAILED on purpose** with `SECURITY FAIL: ungranted legacy ID accepted across Keyhive-authenticated server restart`. [Playwright diagnostic artifact](https://github.com/0cwa/creative-cooking/actions/runs/38251954609/artifacts/11748377615) retained. The unrelated unknown protected-looking ID control denied upload/fetch. Actual Rust wire traffic, not just an inferred source branch, demonstrated the legacy bypass.

**Precise separate ARK result:** same run's native Node/WASM Vitest job; protected factory and owner E2EE passed, Relay/Read/Edit/Admin policy matrix and upgrade/downgrade passed, but direct policy **granted** an unauthorized forwarding requester and unprotected document fetch. Separate reader still could not open content. The test was intentionally **RED (7 passing, 5 failing cases at captured revision)** rather than suppressing negative failures, and uploaded an [ARK matrix artifact](https://github.com/0cwa/creative-cooking/actions/runs/38251954609). Subsequent harness changes must be judged by their own CI runs; a failed expected-denial assertion remains a security finding until upstream or a verified isolated mitigation fixes it. **Later [run #38266039641](https://github.com/0cwa/creative-cooking/actions/runs/38266039641)** executed 12 ARK WASM/JS probes: **8 passed, 4 failed**, including the contact-card graph-admission result and a separately authorized reader unable to decrypt after archive/key-epoch propagation. The latter is a positive pairing/integration failure, **not a revocation PASS**. The requester-Relay and unprotected-ID failures persist and intentionally keep the security job red. This is component-level JS policy invocation, not a forged signed-write packet against Rust.

### 10.3. Visibility, cryptography and authorization boundaries

The *old* AES-GCM fixtures with `--auth open` never established Keyhive E2EE. This follow-up executed real Keyhive envelope encryption and independent identity decryption attempts, but the **Rust** legacy bypass uploaded random test bytes to an **unprotected** ID. Therefore the Rust relay test does **not** prove it could read **protected** ARK recipe plaintext. The no-key Relay identity's inability to decrypt a synthetic Keyhive envelope is genuine but is not a live relay storage-side test. Similarly, a 32-byte unknown-ID denial is not authorization propagation success.

**Observed bytes/metadata:** protected document ID **32 bytes** (nonzero final 16 bytes); legacy ID **16 random + 16 zero bytes**; standalone Keyhive envelope **57→286** and **56→285** bytes; Keyhive WASM authorization archive **13,430 bytes**; durable legacy relay redb file `sedimentree.redb` survived restart, with **one ciphertext-or-opaque commit received by independent client**. No end-to-end total bytes, packet timing distribution or full relay key/secret snapshot measured. A relay can observe document identifiers, peer/contact/member/authorization metadata, blob sizes, event ordering, timing, access pattern, and the count of changes even when document content ciphertext hides recipe/pantry/chat plaintext. No device/provider credential or personal cooking data was used.

**Authorized publish is not network identity:** a signed peer connection may authenticate *who connects* but does not make that identity a household member. The JS policy `authorizePut(requester, author, document)` checks Edit for **author**, not Relay for **requester**; this is **not equivalent to validating an Ed25519 signature over actual published commit bytes**. A separate forged-author wire attack, unsolicited writes to a granted protected ID and queued offline edits are still needed. Protected ID admission must be default deny and explicit, rather than letting zero-padded legacy IDs silently fall through.

**No upstream source was patched locally.** A before/after comparison of **two official upstream Keyhive revisions** was independently executed for the forged-revocation bug; this is a *fixed upstream release-candidate commit*, **not** a Creative Cooking patch and **not** an ARK/Subduction integration or production-grade recovery result. Production choices would first need audited, upstream-maintained fixes with a strict protected-only tenancy boundary and independent requester Relay enforcement, plus fresh end-to-end replay tests proving previously seen edits and stale ACL snapshots cannot bypass revocation. Until then, the private/shared model MUST NOT deploy on this stack.

### 10.3.1. New independent forged-revocation proof: pinned FAIL, upstream fix PASS

The **same** unmodified owned test, [revocation-proof-regression.rs](../../scripts/spikes/local-first-subduction-keyhive/revocation-proof-regression.rs), was copied to two *separate* exact upstream Keyhive checkouts (no upstream authorization patches). Mallory, a distinct genuine Ed25519 signer, submitted a signed \`StaticRevocation\` to evict Bob from a synthetic cooking document, fraudulently citing Alice's founding delegation as its proof. The test insists that \`receive_revocation\` reject the operation *and* Bob retain Read. Independent [run #38267512881](https://github.com/0cwa/creative-cooking/actions/runs/38267512881), [reproduction transcripts and resolved Cargo.lock files](https://github.com/0cwa/creative-cooking/actions/runs/38267512881/artifacts/11755023440):

| Pin used at runtime | Actual signed-revocation outcome | Strict test result |
| --- | --- | --- |
| **Pinned candidate** Keyhive \`b7968be799705492428c94226ca28042c733a9e0\` | \`observed=UNAUTHORIZED_REVOKE_ACCEPTED\` | **FAIL, 0/1 passed.** Prior security expectation violated |
| **Official upstream security fix** \`a864f5c8159215a03fbdc5f0d042dff47f3ac0c0\` (PR #250) | \`observed=DENY\`, original Read retained | **PASS, 1/1 passed.** Same regression test |

Rust **1.91.0**; \`cargo test -p keyhive_core --test creative_cooking_revocation_proof -- --nocapture\`; the source revisions are pinned, but *both upstream Cargo.lock files were stale when using \`--locked\`*, so Cargo resolved dependencies in temporary CI checkouts, captured both resulting lockfiles in the artifact, and tested the resulting executable graphs. Exact transitive dependency resolution therefore must be preserved with the attached locks for archival reproducibility. The first attempted run with \`--locked\` was correctly classified as **dependency setup failure**, **not** security evidence. The later successful comparison proves only the concrete Keyhive-core revocation witness acceptance at these source revisions; it does not demonstrate a forged Subduction wire request, remote key exfiltration, or any exploit against a production service. The security-red original test MUST NOT be suppressed.

To rerun just these security gates in independent local checkouts:

\`\`\`bash
git clone https://github.com/inkandswitch/keyhive keyhive-old
git -C keyhive-old checkout b7968be799705492428c94226ca28042c733a9e0
git clone https://github.com/inkandswitch/keyhive keyhive-fixed
git -C keyhive-fixed checkout a864f5c8159215a03fbdc5f0d042dff47f3ac0c0
for d in keyhive-old keyhive-fixed; do
  cp scripts/spikes/local-first-subduction-keyhive/revocation-proof-regression.rs \
     "$d/keyhive_core/tests/creative_cooking_revocation_proof.rs"
  (cd "$d" && cargo +1.91.0 test -p keyhive_core \
    --test creative_cooking_revocation_proof -- --nocapture)
done
\`\`\`

**Production gate:** update *coherently* with upstream-reviewed revocation hardening **and** retest across ARK/Keyhive, browser, Subduction Rust, persistence, device invite, offline queue, and downgrade semantics. Keyhive's \`a864f5c\` fix **does not eliminate** the proven legacy-ID or requester-Relay bypass, and is not a reviewed production cryptosystem.

### 10.4. Reproduction (security-red is the expected outcome on unsafe upstream)

**Code ownership:** `scripts/spikes/local-first-subduction-keyhive/ark-adversarial.test.ts`, `adversarial-relay.spec.ts`, `keyhive-core-security.rs`, `revocation-proof-regression.rs`, this report, and `.github/workflows/subduction-keyhive-spike.yml` only. The ARK and Keyhive Rust test files are copied into **detached pinned upstream checkouts in ephemeral CI workspaces**; upstream repos are not committed or patched. The browser test runs the actual pinned Rust CLI as a disposable localhost-only service. No production app state, Expo code, credentials, persistence, normal workflows or other spike PR was modified.

For exact pinned platform setup/repro **use the experimental workflow**, because it installs Rust 1.91, Node 22, wasm-pack 0.14.0, Playwright Chromium and the pinned package managers. Its steps are independently reproducible:

```bash
# From root of the PR #40 experimental checkout.
git clone https://github.com/automerge/automerge-repo-keyhive ark-upstream
git -C ark-upstream checkout 5d09e8c8cfdebd5656b1426b66aea6b1395f83da
cp scripts/spikes/local-first-subduction-keyhive/ark-adversarial.test.ts ark-upstream/test/creative-cooking-adversarial.test.ts
(cd ark-upstream && pnpm install --frozen-lockfile && pnpm build && \
 CC_ARK_SECURITY_EVIDENCE="$PWD/cc-ark-security-matrix.json" pnpm exec vitest run test/creative-cooking-adversarial.test.ts --reporter=verbose)

git clone https://github.com/inkandswitch/keyhive keyhive-upstream
git -C keyhive-upstream checkout b7968be799705492428c94226ca28042c733a9e0
cp scripts/spikes/local-first-subduction-keyhive/keyhive-core-security.rs keyhive-upstream/keyhive_core/tests/creative_cooking_security.rs
(cd keyhive-upstream && cargo +1.91.0 test -p keyhive_core --test creative_cooking_security -- --nocapture)

git clone https://github.com/inkandswitch/subduction subduction-upstream
git -C subduction-upstream checkout f0af1aab5f2fd44e5b224c22fc8b62660d50bc01
(cd subduction-upstream && cargo +1.91.0 build -p subduction_cli && \
 wasm-pack build subduction_wasm --out-dir e2e/server/pkg --target web --release)
cp scripts/spikes/local-first-subduction-keyhive/adversarial-relay.spec.ts subduction-upstream/subduction_wasm/e2e/
# After installing Subduction WASM's frozen pnpm dependencies, the Playwright
# browser and local http-server (all steps in .github/workflows/subduction-keyhive-spike.yml):
(cd subduction-upstream/subduction_wasm && \
 CC_SUBDUCTION_CLI="$PWD/../target/debug/subduction_cli" pnpm exec playwright test adversarial-relay.spec.ts --project=chromium --reporter=line)
```

The two currently vulnerable negative tests should return **nonzero exit codes**. Keep full reporter output and attached machine-readable JSON as evidence; **do not enable `--auth open`, remove assertions, apply `continue-on-error` or merge a red security spike to main**. The existing baseline fixture test remains separated and continues to demonstrate only Subduction transport, not cryptographic authorization. The normal [Creative Cooking CI](https://github.com/0cwa/creative-cooking/actions/workflows/ci.yml) runs on this PR independently; no production CI workflow edits were made.

### 10.5. Production gates and operational work owned by a future stack

A usable implementation would require (1) a coherent signed-wire ARK and Subduction version set with protocol/serialization compatibility and migration tests; (2) real protected-document ownership with recipient-scoped signed contact-card onboarding, prekeys and explicit verified invitation UX; (3) server enforcement of **both** author Edit and requester Relay with an exhaustive negative matrix, and an explicit choice to reject or completely isolate legacy IDs; (4) deterministic positive Read/decrypt after pairing, genuine Relay without data key and scoped encrypted historical-key access; (5) real revocation rekey, stale archive and queued offline edit denial across restart and restore; (6) independent audit before adopting unaudited Keyhive; (7) Keyhive secret, archive, issuer key and redb/blob backup/restore crash-consistency tests; (8) traffic-size, member metadata, timing, quota/abuse, event-spoofing and cross-household risk analysis; (9) native Expo iOS/Android integration under background/locked-device lifecycle; (10) hosted TLS/identity stable signers, quotas, backups, version rollout, rotation and monitoring.

A small self-hosted deployment must maintain stable Ed25519 server key and `--data-dir` together with the **full** redb, filesystem blob tree and `.keyhive` state, with **consistent point-in-time backup** and a tested restore. Without a reliable key-recovery flow, a device reset can strand encrypted recipes, and restoring an old authorization snapshot may dangerously resurrect access until recent signed events converge. No recovery cutover or production cost/performance test has been executed by this branch. Application provider credentials remain *outside* any replicated state. Offline-first cooking must continue working with or without this experimental sync system.

**Decision: DO NOT SHIP; retain #40 as DRAFT/UNMERGED.** Positive encryption and Keyhive core capabilities do not overturn reproduced missing authorization constraints or the explicit early-preview/pre-alpha/unaudited warnings. No Automerge/Loro/p2panda architectural winner is selected here.
