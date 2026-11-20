# Persistent optional local-first sync: relay operations and ownership spike

**Research only; do not merge or deploy.** Branch: `spike/local-first-relay-operations`, branched from `main` at `a1c8993c4f45e9bb8de2b18d4f644088df99845a`. Umbrella [#36](https://github.com/0cwa/creative-cooking/issues/36). This spike evaluates **operations**, not which CRDT engine, network substrate or cryptographic authorization system Creative Cooking should select.

## 1. Executive result and evidence discipline

**Verified operational feasibility, with a critical durability counterexample — NOT production ready.** [Experimental Actions run #38265453804](https://github.com/0cwa/creative-cooking/actions/runs/38265453804) **PASSED** both isolated jobs at code SHA `797af9d40b18bd4996adc7544c535ccf6bc66b91`, with [machine-readable artifact #11755420061](https://github.com/0cwa/creative-cooking/actions/runs/38265453804/artifacts/11755420061). This is a **frozen research measurement**, not evidence of a later head unless that head's isolated workflow is also green. The last earlier complete normal CI was [#38259300194 PASS](https://github.com/0cwa/creative-cooking/actions/runs/38259300194); the code-head normal CI's Gitleaks detected a false-positive hard-coded synthetic WebSocket handshake header, so the research branch history is squashed and the header now generated without an embedded key literal. **Verify the corrected PR-head normal and isolated jobs independently.** Unit tests' fake redb bytes only verify backup **manifest handling**; the Chromium plus actual pinned Rust CLI exercises the real persisted store.

The results are deliberately split: `PASS` for exact exercised behavior, `OBSERVED_UNDURABLE_SYNC_RESULT` for the genuine `ENOSPC` data-loss counterexample, `SIMULATED_ONLY` for an orphan temp blob, `PARTIAL` for quotas and short load, and `NOT TESTED` for host failover, untrusted public abuse, protected authorization and mobile clients. `syncWithPeer().success===true` is **not** a verified durable server acknowledgment.

The test uses the **real Subduction Rust server** and **browser WASM** with a stable local Ed25519 seed, actual redb and external blob files, but deliberately uses `--auth open`. Fixture-only AES-256-GCM encryption is **not** Keyhive/ARK E2EE, authorized device pairing or real revocation. Upstream explicitly warns Subduction is not ready for production. The app must remain fully usable without internet, account or sync server; the static GitHub Pages PWA can never itself run a stateful relay.

### Evidence from read-only source PRs — not results of this new spike

- [#39 p2panda/Iroh](https://github.com/0cwa/creative-cooking/pull/39): actual same-host three-process p2panda/SQLite third-replica store-and-forward; independent browser ciphertext mailbox; no complete native ↔ PWA p2panda runtime. An **Iroh relay is online packet transport, not durable user-data storage**. p2panda 0.7.1 / Iroh 1.0.3; iOS netdev compilation blocker in that spike.
- [#40 Subduction/Keyhive](https://github.com/0cwa/creative-cooking/pull/40): actual browser Subduction WASM → Rust redb → reconnecting late browser, long poll and AES-wrapped Automerge change bytes. That result proves unprotected fixture transport and persistence, not ARK/Keyhive permissions or E2EE.
- [#43 evaluator readiness](https://github.com/0cwa/creative-cooking/pull/43): genuine Automerge 3.5.0 and Loro 1.16.4 incremental binary updates carried over real Subduction WebSocket/redb/HTTP with conflict evidence and late catch-up. This operations spike reuses the **engine-neutral opaque change transport shape** and generates real Automerge cooking changes to measure one identical workload. It does not claim native clients, household authorization or comparative engine performance.

### Evidence legend

`TESTED PASS/FAIL` requires a run ID and JSON/trace; `SIMULATED ONLY` is a controlled proxy/file fault rather than actual upstream crash-point injection; `SOURCE ONLY` comes from pinned upstream code/README; `NOT TESTED` is an unresolved gate. A local simulation cannot prove multi-region recovery, years of retention or production SLAs.

### Frozen, real single-host measurements (12 October 2026)

These measured values are from **run #38265453804**, artifact **#11755420061**, not an estimate of steady-state hosted cost or a comparison with p2panda. Runner: Ubuntu Linux `6.17.0-1022-azure`, 4 reported vCPUs (AMD EPYC 7763), 16,770,748,416 bytes of host memory, Node 22.13.0. The Rust process is unprivileged and uncontainerized on this shared Actions runner; there is **no enforced 1-vCPU/512-MiB host constraint**.

| Observation | Recorded outcome | Scope limit |
| --- | --- | --- |
| Payload/workload | **28 real incremental Automerge 3.5.0 cooking updates**, 92,954 plaintext-engine bytes, **93,738 fixture-AES ciphertext bytes**, one 60,254-byte external file (>16 KiB) | One synthetic data set, not matched against p2panda or all future household histories |
| Final on-disk store | **379,807 bytes** for redb + external blob + 65-byte signing seed; **4.05× unique ciphertext** | Only this post-reopen snapshot; redb file allocation changes, so this is **not** a linear growth rate or universal overhead |
| Disk versus update count | 1,056,833 bytes just before SIGKILL after 4 commits; 379,807 bytes at 12, 20 and 28 commits after reopening | Physical redb allocation changed across restart; no valid steady-state extrapolation from these few samples |
| Startup | **106 ms observed time to TCP listener**, 257 ms to finish harness start sequence, including **150 ms intentional settling** | Shared hosted runner, no cold boot, DNS/TLS certificate or disk mount in this timing |
| Rust RSS | **38,884 KiB** baseline, **45,488 KiB** after initial load, **48,176 KiB** with eight concurrent WebSocket peers | One sampled process, no percentiles, peak over real sustained workloads or total system memory accounting |
| CPU | `ps` process %CPU sampled; 51.0% at the 28th update and 11.5% during eight-peer fan-out | Process-lifetime snapshots, **not normalized per-update CPU** or a constrained-host utilization forecast |
| Browser concurrency | **Eight simultaneous open WebSocket connections**, six extra Chromium peers each recovered 28 exact ciphertext changes in **3,548 ms** total setup/fetch | Single one-host tree, no multi-tenant traffic, rate limiter or significant WAN latency |
| TLS-proxy application bytes | Final **184,573 bytes WS upstream / 1,021,144 bytes WS downstream**; **260 bytes HTTP request / 100,551 bytes HTTP response** | Includes WS handshakes/reconnect/catch-up on several phases; excludes TLS record and IP overhead, not billable egress |
| Idle bandwidth | **0 added WS stream bytes** during one measured second while two WS sessions were connected | Does not establish overnight/always-on idle traffic or mobile heartbeats |
| Proxy policy | HTTPS/WSS/HTTP long poll; CORS allowed PWA origin 204, denied hostile Origin 403 on OPTIONS **and WSS upgrade**, oversize HTTP 413, eight-connection observed peak | Missing-Origin preflight was also accepted; origin filtering is **not authentication**, and 16-session cap/per-tenant quotas were not load-tested |

**Durability blocker under real ENOSPC:** a private **12 MiB tmpfs** genuinely returned `ENOSPC` to its file writer. A first actual update was independently persisted. Under full disk, a second real Subduction sync returned **`success:true, sent:1`**, but after `SIGKILL` and restart a fresh peer found **only one update**. Once disk space was freed, the *original surviving browser* retried and a fresh recipient received **both exact encrypted changes**. Thus **do not count transport success as a durable receipt**, do not compact a client's unsent/pending data on that signal, and require a separately proved durable server-ack protocol or retained-client replay. Recovered baseline data is not proof of new-write safety under disk pressure. This is evidence of a production hard gate, not a green durability claim.

**Versioned interop on real binaries:** Subduction Rust CLI 0.18.0 at `2566cbfc5d1d529ed8c109009a645ee73d7dc0dd` and 0.19.0 at `f0af1aab5f2fd44e5b224c22fc8b62660d50bc01` each actually built. New WASM → old server, old server restart, old persisted redb → new binary, a new post-upgrade write, same-store downgrade, old WASM → new server, and the old binary from a **pre-upgrade quiescent backup** all **PASS** with independent browser reads and exact ciphertext (one or two commits in the version subtests). This does **not** test live protected Keyhive history, other version pairs, arbitrary schema changes, or rollback of post-snapshot writes: snapshot rollback visibly returns to **one**, not two, updates.

**Recovery/authorization boundaries:** full quiescent redb/blob/signer backup and fresh restore yielded all 28 exact ciphertext changes; corruption/missing key/partial backups were rejected by a **non-signed SHA-256 manifest**. An orphan temp blob survived restart only as a simulation (no real mid-fsync injected kill). `--auth open` intentionally produces no Keyhive history: the separate `.keyhive` backup check in Node is synthetic. Neither public-key rotation nor authorized device revocation is proven.

Machine-readable preserved summary: [`spikes/relay-operations/verified-evidence.json`](../../spikes/relay-operations/verified-evidence.json). The full artifact includes per-phase metrics and failed/qualified cases; no fixture key, actual signer seed or personal data is uploaded.

## 2. Immutable version/infrastructure envelope

| Component | Version/pin | Qualification |
| --- | --- | --- |
| New Subduction CLI, core and WASM | [`f0af1aab5f2fd44e5b224c22fc8b62660d50bc01`](https://github.com/inkandswitch/subduction/tree/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01); CLI 0.19.0 nightly (2026-10-07), WASM source 0.24.0 | `cargo build --locked`, `wasm-pack build`; experimental upstream release |
| Previous genuine server binary | [`2566cbfc5d1d529ed8c109009a645ee73d7dc0dd`](https://github.com/inkandswitch/subduction/tree/2566cbfc5d1d529ed8c109009a645ee73d7dc0dd); v0.18.0 nightly (2026-09-30) | Built from *different source*, not a version-string alias; same-store upgrade/downgrade attempted in a **separate** disposable store |
| Previous browser client | exact same 0.18.0 commit | CI attempts a separate old WASM build and serves its static page; unavailable builds recorded `NOT TESTED`, not pass |
| Rust / browser / Node | Rust 1.91.0; wasm-pack 0.14.0; Node 22.13.0; Playwright/Chromium from pinned upstream lock | GitHub `ubuntu-latest`; specific runner/kernel/CPU/RAM included in JSON |
| Binary workload | `@automerge/automerge` **3.5.0** | 28 genuine **incremental** cooking-domain changes, SHA-256 IDs and dependency links, AES-wrapped, including an incompressible >16 KiB external blob. Size, actual transferred bytes and generation time recorded |
| Test relay | one process on 127.0.0.1 with `--service-name creative-cooking-local-ops-v1 --auth open --key-file <root>/identity.key --data-dir <root> --max-message-size 131072` | Stable key **in** store to include in snapshot. WebSocket and HTTP enabled; no Iroh/Keyhive roles |
| Reverse proxy | short-lived local Node `https` + transparent WebSocket TCP bridge, self-signed test certificate | Performs TLS/WSS/HTTPS, exact allowlisted browser origin, OPTIONS CORS, 256 KiB HTTP limit and 16 simultaneous WS cap. **Not deployable production proxy or access control** |
| Topology | headless Chromium A, B, C late HTTP, fresh restored D, Rust server, TLS proxy, one Linux Actions host | No public DNS/ACME, actual remote Internet, mobile OS, NAT, hardened service supervisor or hardware resource limits |

All test keys, local certificate, store contents and the disposable AES fixture stay in the runner temporary directories and are **not uploaded**. The artifact contains only bounded metrics, file names/sizes and non-secret checksums, no payload or server signing seed.

## 3. Executable experiments and what they mean

| Gate | Direct evidence in harness | What does *not* follow |
| --- | --- | --- |
| Actual persistent service | CLI started with stable identity, on-disk `sedimentree.redb`, source and more-than-16-KiB content-addressed external blob | Enterprise-grade database or audited fsync guarantee |
| Clean / abrupt restart | Browser A uploads, B disconnects, A disappears, Rust SIGKILL; same key/store reopened, B catches up exactly | Machine power loss / storage firmware guarantees |
| Long-offline gap | Peers hold no concurrent uptime; later fresh browser recovers from the store | Calendar days, token expiry, app suspended across months (time is short in CI) |
| Deduplication | Re-add same change ID, get count unchanged; idle sync reports zero new changes | All concurrent malicious replay scenarios |
| Quiescent full backup | Stop server, recursively copy redb, external blobs, signer key and any other files, SHA-256 each file, verify manifest, restore fresh directory | Live backup, multi-writer snapshots, cryptographic authenticity of manifest |
| Loss/corruption | Truncate redb, drop external blob, omit signer, partial restore: integrity verification must refuse before server launch | Automatic *application-level* recovery if invalid store is loaded without preflight verification |
| Blob write interruption | Simulated orphan `.tmp` in a restored real redb/blob store; fresh Rust late peer reconstructed 28 exact updates | A process truly interrupted **after blob fsync but before database commit** has still not been injected |
| Lost/rotated signer | Backup SHA-256 manifest rejects replaced signer; pinned server peer IDs are compared on fresh restarts with the same Ed25519 seed | Never equate these local checks with production pairing trust, cross-device key rotation or old-device revocation |
| Unavailable/crashing service | Proxy returned 502 with Rust backend down, then real restart and fresh peer recovered 28 updates; bounded probe retry schedule exercised separately | Probe/backoff is NOT the shipping PWA/native client retry implementation, and no WAN outage was induced |
| Secure transport | Local self-signed HTTPS/WSS plus Chromium WASM sync, HTTPS long-poll, CORS/Origin preflight and denied foreign origin | Public DNS/ACME certificate issuance, credential authentication, encrypted user-state authorization |
| Wire and host costs | Real proxy WS/HTTP stream bytes; 1-second idle delta; RSS/`ps` CPU snapshot, 4/12/20/28 edit disk snapshots, eight simultaneous WS peers, TCP startup | No TLS/IP envelope cost, p95 sustained load, system energy cost or unconstrained public request traffic |
| Load / abuse | 28 serial exact engine changes, eight concurrent browser WS peers plus HTTP late reader; tested HTTP 413 and foreign-origin HTTP/WSS 403 | Session ceiling 16 not hit; no authenticated quotas, flood/WS-frame-rate limit or untrusted network security proof |
| Full ENOSPC | **Real kernel ENOSPC on a private 12 MiB tmpfs while pinned Rust runs; transport success for update 2 did not survive crash; retained original peer successfully replayed it** | No durable server acknowledgment, database failpoint or production guaranteed crash consistency |
| 0.18 → 0.19 upgrade | Two distinct pinned CLI binaries and pinned browser WASM versions actually exercised with independent recipients: both directions, old-store/new-binary, same-store downgrade and pre-upgrade-snapshot rollback **PASS** for 1–2 updates | Other versions, Keyhive storage and post-snapshot rollback without lost updates not established |
| Constrained host | A four-vCPU Actions Linux runner with exact process RSS/CPU and eight local browser sessions measured | No enforced 1-vCPU/512-MiB cap; **NOT TESTED** |

A failed compatibility attempt is recorded as a **FAIL** under `actualChecks.versionedUpgradeRollback`; successful recovery from a *saved pre-upgrade store* is distinct from a safe in-place downgrade. Test code does not catch failures of the primary persistence, blob, CORS, backup or restore proof as successes.

### Result and measurement format

Machine-readable JSON is written to `spikes/relay-operations/ci-results/relay-operations-result.json` **in the CI workspace only**, and uploaded even if the browser test fails. It includes exact source/version, workload, measured storage bytes, RSS KiB, sampled CPU %, process starts, duration ms, HTTP/WSS counted payload-stream bytes, peak sessions, static allowed/denied origins, old/new upgrade subcases, and caveats. `fixture.ciphertextBytes` counts unique fixture payload, **not** full network egress; proxy byte counters are real observed **application-stream** bytes, excluding TLS record/frame overhead, TCP/IP headers, DNS and Internet routing.

Relative overhead is **observed disk bytes / unique ciphertext bytes** on this specific store after an explicit workload. It is not valid to compare p2panda three-process random frames to this 28-change browser workload as equal cost.

## 4. Reproduction from a fresh branch

The only tracked source paths for this PR are `spikes/relay-operations/**`, `.github/workflows/relay-operations-spike.yml` and **this** report. Existing app code, AppState, IndexedDB, AsyncStorage, SecureStore, JSON backups, provider keys, main CI and Pages remain untouched.

1. Open the isolated workflow's [Actions tab](https://github.com/0cwa/creative-cooking/actions/workflows/relay-operations-spike.yml) and run on the research branch, or open the draft PR to trigger the path-scoped workflow.
2. Inspect jobs `Full-store backup contract` and `Actual pinned Rust relay, Chromium, TLS and recovery`. The latter checks out both **exact full SHAs**, compiles `subduction_cli` for each with the locked Cargo dependencies, builds exact current WASM, and independently attempts old WASM.
3. Download `creative-cooking-relay-operations-evidence` and inspect `relay-operations-result.json` plus Playwright trace if failure. Compare run SHA to PR head. Do not use *previous* PR's green run as this branch's pass.
4. For local reproduction, follow the workflow step sequence: Linux with Rust 1.91, wasm-pack 0.14.0, Node 22.13, pnpm 9, openssl, Playwright Chromium, GitHub's pin-referenced source trees and `npm install --prefix spikes/relay-operations`. Copy `operations.spec.ts.template` into current upstream's `subduction_wasm/e2e/operations.spec.ts` and set the `CC_OPS_*` absolute-path variables in workflow. Run `pnpm exec playwright test operations.spec.ts --project=chromium --retries=0` from `subduction_wasm`.
5. The fast standalone backup contract is `node --test spikes/relay-operations/*.test.mjs`. It does **not** require Rust, but its fake-redb fixture must never be interpreted as real Subduction recovery evidence.

## 5. Operating / monitoring / backup / restore runbook (hypothetical private deployment)

This is a **future operator checklist**; there is no real public Creative Cooking sync deployment. Choose a dedicated private persistent host, not GitHub Pages. Preserve completely independent local app state while the optional service is down.

**Provision:** create a dedicated unprivileged OS account and persistent volume with separately monitored capacity. Keep signer seed mode 0600 with restricted ownership; in this spike it is `<data-dir>/identity.key`, but external `--key-file` paths are permissible **only if backed up alongside the data**. Bind Subduction to `127.0.0.1:8080`; expose TLS 443 via a maintained reverse proxy; do not expose `--auth open`. Protect metrics port, restrict incoming body/frame size, connection count and request rate, use an authenticator/authorization system only *after* it passes independent security testing. Configure host firewalls, non-root systemd unit, explicit binary SHA/checksums, log rotation, DNS/TLS renewals, PWA origin allowlist, uptime monitors, disk and inode alerts, public-abuse defense, recurring restore drills and reliable paging/support ownership.

**Stop-the-world full backup** (stop both writers and sidecars/Keyhive state writers; no writes until copy and verification complete):

```bash
# Illustrative paths only; never run against a live production writer.
sudo systemctl stop subduction
node spikes/relay-operations/backup-cli.mjs backup \
  /srv/subduction/data /srv/backup/staging/2026-10-12 --server-stopped
node spikes/relay-operations/backup-cli.mjs verify \
  /srv/backup/staging/2026-10-12
# Copy the verified snapshot to isolated/offsite immutable backup storage;
# keep restrictive ACLs, encrypt and restrict offsite access; log digest and retention.
sudo systemctl start subduction
```

The utility's `--server-stopped` switch is an **operator assertion**; it cannot prove the service is actually stopped. Backup root must contain `sedimentree.redb`, all `blobs/**`, `identity.key`, and any local `.keyhive/**` / authorization history, together with separate configuration/key stores **if the tested future Keyhive mode introduces them**. Back up TLS private key (or automate reissuance), DNS/configuration, encrypted offsite backup access and operational documentation independently. The script performs integrity checks with SHA-256 but is neither a secure signed archive nor a guarantee of crash-consistent live copies. redb only documents stopped/quiescent full-store copying; snapshotting a live directory may tear pages or mismatch external blobs.

**Disaster recovery / full loss:**

```bash
sudo systemctl stop subduction
node spikes/relay-operations/backup-cli.mjs verify /srv/backup/good-snapshot
node spikes/relay-operations/backup-cli.mjs restore \
  /srv/backup/good-snapshot /srv/subduction/recovered-fresh --server-stopped
# Verify permission/owner, expected Ed25519 identity fingerprint, directory
# and release pin. Point --data-dir to recovered-fresh; start ONE writer.
# Reconnect an already-trusted test client; verify exact canonical update history.
# Resume optional sync only after authorization + data checks pass.
```

Do **not** overwrite the only intact original data directory. A missing or corrupted blob/database/key fails manifest preflight; quarantine the bad copy, retry an independently verified backup or require re-replication from surviving **authorized** clients with appropriate key history. There is no basis yet to promise that every original CRDT history/update/review event can be regenerated from a client's snapshot. A lost service Ed25519 identity is **not** simply fixed by replacing it with an arbitrary new signing key; peer identity/pairing trust must be explicitly reviewed. Restoring Keyhive roles, key history and post-revocation forward secrecy has not been tested by this open-auth spike.

**Upgrade and rollback:** announce a maintenance window; hold new writes; record old binary/lockfile checksum, exact store+signer snapshot, auth/key-store version, client versions and old/new protocol/DB tests. Stop and verify, start the pinned next binary in a test copy, attempt new/old cross-connect, inspect persisted bytes and late catch-up. Only migrate a live deployment after successful tests. For rollback, **restore the pre-upgrade quiescent snapshot into a fresh directory with the original signer** and restart the old binary. Same-data old-process restart and original snapshot rollback are distinct. Any writes accepted after snapshot require a loss/replay plan; no automatic no-loss rollback is proved. Upstream's separate filesystem → redb `subduction migrate --from --to` is non-destructive but **not** the 0.18 → 0.19 trial; do not conflate storage-format migration with binary upgrade.

**Failure response:** for disk >80% or insufficient free inodes, reject new writes safely, alert before ENOSPC, resolve capacity then verify redb and blobs and perform authorized catch-up. On persistent crashes, corrupt files, truncated backup, mismatched key, repeated connection timeout or unauthenticated request flood: disable sync without disabling cooking; preserve logs/artifacts; restore from a verified immutable backup; re-run delayed-peer and write-idempotency checks; escalate lost-key events instead of silently resetting trust. Device reconnection should apply exponential backoff with jitter and a bounded retry ceiling; in this harness the sample intervals [250,500,1000,2000,4000,8000] ms are a **recommendation**, not evidence of production mobile retry behavior.

## 6. Production topology and total ownership

| Operator concern | Persistent Subduction option | p2panda/Iroh option |
| --- | --- | --- |
| When both human devices are absent | Persistent Rust Subduction node must remain online or catch-up fails | An **actual persistent third p2panda replica** must remain online. Iroh's online relay does **not** store missed updates; do not sell it as a mailbox |
| Storage | redb metadata, external content-addressed blobs, signer key, auth/key history if enabled | Replica's durable SQLite/operation storage and signing/group state **if implemented**; #39 actually tested third same-host native process, not deployed web host |
| Server implementation | Upstream CLI exists but explicitly unsupported for production; project's deployment, E2EE authorization and stability remain unresolved | No proven fully hosted production p2panda service in PR #39; project would need to implement/maintain persistent service or manage an always-on household device |
| Transport | WSS/HTTPS proxy + optional QUIC/Iroh paths; DNS, TLS, CORS, timeouts, authentication | P2P direct + NAT fallback Iroh relays plus a third replica; public relay transport is a distinct infrastructure/service choice |
| Device integration | Browser proof for actual Subduction WASM; no production native Expo integration | Browser/native interoperable p2panda+CRDT engine path not proven; existing iOS native build blocker |
| Cryptography | `--auth open` intentionally insecure; Keyhive/ARK alpha/unaudited, ACL and pairing gates unsatisfied | Spaces unqualified for end-to-end production household flows; third node in #39 saw plaintext random bytes |
| Burden | upgrades, compatible client/relay versions, hosted stateful disk, backup, signer rotation, proxy, monitoring, abuse, disaster restore | persistent third replica, discovery, relay policy, key/group rotation, host upgrade, restore, always-online availability, mobile bindings, monitoring, abuse |
| Credible reliability conclusion | Conditional feasibility until real soak, security and failover evidence | Conditional feasibility; no hosted durable p2panda service has been demonstrated |

Neither topology is a free replacement for local-only operation. The hosting decision is independent of Automerge versus Loro, and even ciphertext-blind relaying leaves service availability, identity metadata, quotas and operator burden.

## 7. Capacity, costs and sustainability — no unsupported price guesses

Do **not** quote `€5/month` or a specific household price range from a single short-lived runner test. Resource evidence must first include actual live vs idle byte rates, database growth per fixed payload, >16 KiB external blobs, TCP/TLS overhead, active sessions and memory, CPU under sustained multi-client load, backups, egress pricing and peak fanout. This harness produces measured **single-host local** samples (section 3); it cannot estimate real geographic traffic, support load, incident frequency or hosting SLAs.

Future transparent model (use verified measurements and explicit provider tariff, not fictional numbers):

```text
monthly hosting = VM monthly base + persistent disk provisioned GB-month
monthly backup = immutable/offsite stored GB-month × backup retention multiplier
monthly egress = measured monthly outbound GB × provider $/GB + optional relay transit
monthly human = measured deploy/restore/incident/support hours × explicit labor rate
total ownership = hosting + backups + egress + managed DNS/TLS/monitoring + human
```

Bandwidth from **unique updates × receiving devices × retransmissions** must reflect who is concurrently online and how long histories are retained. The data directory contains append-only history (plus uncollected external blobs after document removal per [upstream redb storage notes](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/subduction_redb_storage/README.md)); do not substitute logical state size for on-disk retention. Disk and egress have distinct prices. Actual external electricity, cooling, cloud billing, and human ops costs are **not measured** in this experiment; no operational cost range is defensible yet.

## 8. Release/ops hard gates remaining

**DO NOT MERGE; not production-ready** even if all isolated tests pass. A **known reproducible disk-full durability hazard** already exists: `syncWithPeer().success` was true while the second update vanished from the restarted service; only retained client history enabled exact replay. Required independently measured evidence still includes: Keyhive/ARK E2EE and author/requestor ACL enforcement, real authorized pairing and revocation, protection against stale signer and recovered revoked device, Web/iOS/Android Expo integration, host ENOSPC affecting real redb commits, true external-blob crash point, torn database recoverability, on-disk compatibility under migration/rollback, real old browser/new native matrix across versions, hardened proxy and public TLS, weeks-long offline retention, bounded sync/GC, resource-constrained multi-tenant load, public abuse resistance, offsite restore drill with *protected* auth history, operational rotation and routine maintenance costs. Independent security and reliability review is required before deployment.

The research branch must stay **DRAFT** and isolated. Neither application architecture nor CRDT engine is chosen here.
