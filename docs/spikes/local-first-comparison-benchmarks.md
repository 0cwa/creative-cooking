# Automerge versus Loro — neutral benchmark and static-browser parity

**Status:** isolated executable measurement worklane, **NOT** an engine selection or production migration.
**Umbrella:** [issue #36](https://github.com/0cwa/creative-cooking/issues/36).
**Evidence sources:** [Automerge draft #37](https://github.com/0cwa/creative-cooking/pull/37), [Loro draft #38](https://github.com/0cwa/creative-cooking/pull/38).
**Branch:** `spike/local-first-benchmark-parity`, created from `main` at `a1c8993c4f45e9bb8de2b18d4f644088df99845a`.
**Scope:** only `scripts/spikes/benchmark-parity/`, this report, and `.github/workflows/benchmark-parity.yml`. Normal application code, storage, credentials, backups and main CI/CD remain unchanged. Keep PR **DRAFT** and **UNMERGED**.

## Why older timings must not be compared directly

Automerge #37 reports a new SyncState session exchanging most of the document. Loro #38 reports version-vector incremental updates after peers already share history. Different initial conditions, timing boundaries, schema representation and protocol semantics prohibit using the existing headline figures for a speed ranking.

The new harness creates **one engine-independent canonical fixture and operation trace** and checks logical projections after every scenario. It measures both actual protocol and plain change/update paths, labels them separately, and records exact byte counts in each direction.

## Common logical fixture and schema

`fixture.mjs` generates the same deterministic objects and `TRACE` for both adapters (SHA-256 hashes stored in `results.json`):

| Count | Logical structure |
| --- | --- |
| 200 | Pantry entities with stable IDs, description/name, preference 1–5, creation/update timestamps and order |
| 500 | Recipe entities with stable IDs, title, description, portions, lifecycle tombstone flag and order |
| 2,500 | Five stable-ID ingredients per recipe; name/amount and explicit order |
| 2,000 | Four stable-ID method steps per recipe with 72-character CRDT text and explicit order |
| 100 | Conversations with stable IDs and ordered message IDs |
| 2,000 | Twenty messages per conversation with role, content and logical timestamp |

Seed `20261012`, fixed-width padded representative scalar/text fields, fixed ISO timestamp `2026-01-01T00:00:00.000Z`, fixed device actors/peer IDs and explicit deterministic edit trace. No provider credentials are in the fixture. The schema is a **candidate replicated performance schema**, not the production array-shaped `PersistedState` or migration plan.

**Representation trade-off:** Automerge uses nested maps-by-ID, order lists, and `updateText` for method text. Loro uses keyed root maps, movable order lists, and native LoroText containers for method text. Both receive the same scalar data and independent editing granularity. Container bookkeeping, initial-population transaction behavior and ordered-list algorithms differ. Any row affected by these structural choices is **not a pure CRDT-core microbenchmark**. We do not choose deliberately degenerate schemas to disadvantage either library.

## Scenario and metric dictionary

| Scenario | Timed boundary | Correctness condition |
| --- | --- | --- |
| Populate | New empty document to fully seeded replica | Canonical full projection matches fixture hash |
| Save snapshot | Engine snapshot serialization | Nonempty snapshot, exact byte size |
| Cold load | Decode/import an existing snapshot with engine already initialized | Complete logical projection unchanged |
| Prepare usable view | Full projected pantry, recipes and chats | Deep structural equality |
| Warm read | 100 each of pantry, recipe and conversation scalar records | Exactly 12,000 useful characters |
| Single-field edit | One committed title mutation | Projection matches common operation trace |
| Batch edit | Five pantry, three recipe and one method-step update | Projection matches trace |
| Brand-new second device | **Automerge true SyncState handshake versus Loro full snapshot import** | Fresh device converges and bytes/rounds counted |
| Warm incremental sync after bootstrap | Reuse the actual acknowledged bootstrap peer documents and SyncState session; Loro uses the same imported snapshot before version-vector deltas | One edit each; peers converge, exact bytes and any history-sized retransmission recorded |
| Follow-up incremental sync | Second edit pair in the same already-used session, with no new bootstrap | Two further independent edits; peers converge |
| Raw change exchange | Automerge getChanges/applyChanges / Loro version-vector update import | Both peers converge; **not** Automerge SyncState |
| Document merge | Automerge merge() / Loro import updates into fork | Same projection; separate named metric |
| Long offline catch-up | 21 edits per side including concurrent portions disagreement | 4 and 6 retained, all 40 independent updates preserved, peers converge |
| Third device | Full bootstrap of third actor from already converged state | Third projection matches both |
| Duplicate delivery | Reapply previously received binary updates | Idempotence; projection correct |
| Reload and continue | Save, dispose existing reference, load and further edit/sync | Exact state and new edit preserved |
| History growth | Three blocks of 20 sequential edits plus snapshot save and catch-up | 20/40/60 snapshot bytes and full post-catch-up equality |

We **never silently equate** initial bootstrap bytes with warm delta bytes, document `merge()` with a network sync session, or the Automerge SyncState protocol with plain getChanges/applyChanges. Transfer artifact records include `kind`, `aToB`, `bToA`, `messages`, `rounds`, and logical operation counts when relevant.

Correctness assertions run *outside* the timed function boundaries wherever feasible; operations that include sync still include their necessary protocol serializing, decoding, and applying costs. Each engine runs once for warmup, followed by five measured iterations, alternating engine order on the **same runner/job**. Timings are in milliseconds and include five raw samples, median and nearest-rank p95; history-block metrics have 15 samples. These are noisy hosted-runner observations, not representative phone benchmarks. The small p95 sample size is reported rather than disguised as a stable tail distribution.

`process.memoryUsage()` exposes **V8 heap**, external and ArrayBuffer memory separately; RSS includes native/WASM allocations. `process.resourceUsage().maxRSS` is the process high-water RSS on Linux, not engine-specific peak retained bytes. The benchmark reports gross before/after deltas with other live references potentially present, plus per-20-edit process-memory snapshots after GC during the sustained history test, without claiming causally attributable engine allocations. It does **not** call V8 heap delta a WASM allocation measurement. Five fresh-process dynamic-import timings measure combined JS module loading and WASM setup, **not pure WASM instantiation**; document load is separately timed. A production mobile implementation would require representative, independently instrumented tests.

Dependencies are pinned to `@automerge/automerge@3.5.0` and `loro-crdt@1.16.4` in the isolated package.json. Every run uploads its generated npm lockfile with registry integrity strings, exact package versions, an installed package-file tree SHA-256, OS/CPU/memory/Node/V8 and GitHub Actions commit/run ID. The deterministic fixture and operation trace have separate SHA-256 checksums.

## Reproduce

```sh
cd scripts/spikes/benchmark-parity
npm install --no-audit --no-fund
node --expose-gc run.mjs
node check.mjs
# Outputs: artifacts/benchmark-parity/results.json and results.csv
```

The isolated `benchmark-parity.yml` workflow runs the same command on `ubuntu-latest` with **Node 22.13.0**. The checker intentionally fails for missing timings, missing repetitions, invalid sample units, missing transfer counts, checksum drift or incorrect protocol labels. An ordinary failure stops the experimental workflow but cannot weaken or alter main's required checks.

## Real GitHub Pages style Expo export

The workflow performs **three real `expo export --platform web` builds** with `EXPO_PUBLIC_BASE_URL=/creative-cooking`, preserving all of the production routes and temporarily adding `app/benchmark-parity.tsx` only in the CI checkout. The temporary route is not committed and is deleted after export. Builds are: control route (no CRDT), Automerge route and Loro route. Thus the static asset totals contain both the application and the benchmark probe route. Engine deltas **include test-harness code** and are not a promised production implementation's final bundle delta.

The Chromium probe serves each built export from `/creative-cooking/` with realistic Brotli responses, runs initialization, snapshot import/export, independent incremental updates, duplicate delivery, persisted local snapshot reload, an offline document operation with network disabled, and checks route/resource status, JS exceptions and failed requests. Service workers are deliberately disabled in this *isolated local-document* probe to avoid a previously installed production SW concealing unexpected fetches. This is **not** a complete offline-PWA service-worker qualification.

Automerge 3.5.0's default `browser` package export imports raw `.wasm` as an ES module, which Metro/Expo rejects (confirmed in the first actual export CI). This harness uses Automerge's **documented** `@automerge/automerge/slim` entrypoint plus `initializeWasm('/creative-cooking/_expo/static/js/web/automerge.wasm')`, copying `node_modules/@automerge/automerge/dist/automerge.wasm` into that static location; this is a specific integration cost rather than a proof that the default import works.\n\nLoro requires explicitly copying `node_modules/loro-crdt/browser/loro_wasm_bg.wasm` to `dist-loro/_expo/static/js/web/loro_wasm_bg.wasm`; the export does not automatically include it. The browser probe asserts an HTTP 200 WASM request at the correct project base path. Automerge is exercised in exactly the same real export/browser setting instead of relying on the original esbuild-only size probe.

`static-cost.json` includes raw/gzip/Brotli bytes for every exported asset and control deltas, including WASM independently. `browser-*.json` includes network response content-encoding, initial CDP encoded bytes, Chromium resource timings, errors, result markers, and screenshots. Total exported asset cost is **not** the initial network transfer, which can be lower due to code-splitting and cache.

The build must be inspected for which scripts actually load on initial route navigation; these data do not claim a lazy-loading strategy will succeed until a candidate production integration demonstrates it.

## Results and exact executable run artifacts

**Passing dual-engine CI evidence:** [GitHub Actions run #38187058455](https://github.com/0cwa/creative-cooking/actions/runs/38187058455), from benchmark PR head `bfb61fce67fc82bb2a7050bd32c4ee788a185994` (five measured Node trials, Node 22.13.0 on hosted Linux/x64; all three real static Chromium exports passed). The latest harness additionally includes per-history-block memory observations and equivalent client-only lazy module import in both browser probes. Those subsequent changes must use their own new artifacts, not the historical timings below.

Exact passing artifacts:
- **[Node JSON/CSV + dependency lockfile](https://github.com/0cwa/creative-cooking/actions/runs/38187058455/artifacts/11719947744)** — exact raw times, 5-trial median/p95, transfer bytes, sync rounds, snapshots, process-memory categories, package-tree hashes, npm integrity strings, deterministic fixture and trace SHA-256.
- **[Chromium browser results, static asset inventories and three screenshots](https://github.com/0cwa/creative-cooking/actions/runs/38187058455/artifacts/11720580442)** — control/Automerge/Loro browser JSON, console/errors, WASM requests, offline/reload checks, network bytes and raw/gzip/Brotli static asset totals.

### Node latency and actual wire counts — passing evidence from #38187058455

All times in **milliseconds**. Latency values are the **median (p95)** of five samples; tail statistics with five samples are exploratory. Transfer bytes are **A → B / B → A** from `scenarioEvidence` (the common trace yields the same payload bytes across this run). The engines use different APIs/wire formats; this table is a boundary-aware record **not a speed ranking**.

| Operation | Automerge latency (median / p95) | Loro latency (median / p95) | Automerge wire bytes A→B / B→A | Loro wire bytes A→B / B→A |
| --- | ---: | ---: | ---: | ---: |
| **Bootstrap from a truly empty second device** | 1,390.607 / 1,409.886 | 142.076 / 386.915 | 739,371 / 126 (SyncState) | 678,010 / 0 (full snapshot) |
| **First warm exchange after acknowledged bootstrap** | 1,118.890 / 1,120.487 | 121.463 / 269.356 | 369,995 / 369,909 (history-sized resend) | 194 / 152 (deltas) |
| **Follow-up exchange in the established session** | 2.569 / 3.085 | 146.259 / 271.699 | 498 / 423 (incremental) | 193 / 150 (incremental) |
| **Plain change/update exchange (not SyncState)** | 8.081 / 9.138 | 146.944 / 252.371 | 242 / 167 (getChanges) | 194 / 152 (version vectors) |
| Snapshot serialize | 37.176 / 37.334 | 77.818 / 83.271 | — | — |
| Cold snapshot load | 811.741 / 816.708 | 2.567 / 2.585 | — | — |
| Prepare usable full logical projection | 9.475 / 10.035 | 310.095 / 450.309 | — | — |
| Single-field edit | 2.938 / 2.959 | 41.138 / 105.465 | — | — |
| Long offline divergent catch-up | 14.996 / 15.452 | 1,352.177 / 2,405.262 | Raw changes (see JSON) | Version-vector deltas (see JSON) |

**Complete logical snapshot bytes:** Automerge 369,612; Loro 678,010. Cold readiness should consider **both** load and full-view preparation, not one API's low-level decode time in isolation. The canonical logical dataset hashes to `50c6c264865aab9a134de07cc7ba784fb6bafe0b8d6da4a1eaa337e0572e04d2`.

The first SyncState exchange after initial bootstrap transmitted unexpectedly large traffic despite both peers sharing the base. This was **retained as evidence**, not normalized away. The second already-established exchange was small, showing why it is unsafe to equate a first SyncState session or its immediate follow-up with a warm version-vector delta. The raw getChanges/applyChanges path is separately measured. This observed behavior is specific to the synthetic giant initial transaction, the implementation, and the exact protocol sequence; it is **not** a general verdict about production sync throughput.

### Real Expo static export and initial Chromium transfer

**Passing Chromium run:** same [run #38187058455](https://github.com/0cwa/creative-cooking/actions/runs/38187058455). All engines initialized and loaded their WASM from `/creative-cooking/`, persisted and reloaded snapshots, applied new edits while `context.setOffline(true)`, and produced **zero JavaScript page errors and failed requests**. Browser service workers were blocked intentionally; this verifies browser-local CRDT function, *not* installed-PWA offline shell behavior.

| Static export / HTTP traffic | Control | Automerge probe | Loro probe |
| --- | ---: | ---: | ---: |
| Entire Expo export, raw bytes | 13,869,250 | 17,585,008 | 17,403,752 |
| Entire export, gzip bytes (offline recompression) | 4,785,180 | 5,948,277 | 5,931,775 |
| Entire export, Brotli bytes (offline recompression) | 3,272,480 | 4,078,659 | 4,079,002 |
| Brotli delta from control | — | +806,179 | +806,522 |
| Initial route load, CDP encoded network bytes (including HTTP headers) | 302,082 | 1,108,186 | 1,108,111 |

These static export sizes include the **unchanged app shell plus each temporary experimental benchmark route**, not a production-integrated migration or installed npm archive size. Initial network transfer is a separate Chromium measurement and is not the sum of all exported files. The browser JSON contains the actual Brotli asset transfer sizes, WASM URLs and code-splitting/chunk requests; the more recent branch also probes explicit lazy imports for both engines. A production lazy-loaded route and service-worker cache strategy still require an integration-specific qualification.

## Native worklane evidence (no manufactured parity)

The native engine worklanes are independent. As of the source reports inspected October 12, 2026, Automerge #37 demonstrates an iOS Simulator 18-scenario contract and JS↔Swift binary/sync interoperability; Java 0.0.9 direct SyncState↔JS 3.5.0 failed, and Android native runtime remains partial. Loro #38 demonstrates native build integration (including an ARM64 Android APK of 87,482,205 bytes with a 5,944,816-byte native library), but representative Android/iOS runtime and web/native interchange still require qualification.

**APK/IPA `engine minus identical no-engine app` deltas: unavailable on a common comparable build matrix. Native startup latency, retained memory and full ABI/runtime coverage: not comparable from the current artifacts.** Dependency archive, AAR or single APK sizes must not be substituted for these missing paired measurements. Refresh this section only by consuming the actual native PR CI artifacts with their exact device/ABI/OS/run metadata. No native branch is modified here.

## Fairness limitations and next evaluator handoff

- Fixture logical projection equality is required for seeded state, edits, reload and convergence; engines may choose different visible winners for truly concurrent writes, so correctness requires retention of **both** alternatives rather than identical winners.
- Loro root containers and its movable lists differ from Automerge nested maps and order lists. Text is character-aware in both. Report result rows alongside this constraint; benchmark modifications must preserve logical/operation parity.
- Host Node numbers do not predict Hermes, iOS Swift or native RN WASM/FFI performance. Runtime ownership, security maturity, transport compatibility, migration and merge-review UX are out of scope of this measurement PR.
- Static-export/WASM copying is proven only when the Chromium artifact exists. Installed package size is not a shipped web asset size.
- The final architecture evaluator should consider the executable measurements **together with** #37/#38 native evidence and #39/#40 transport/security worklanes, not infer a winning engine from any single performance number.

**Do not merge or use this PR to ship either engine.**

**Warm-session note:** The initial experimental run unexpectedly observed a history-sized Automerge SyncState message *despite shared history and a retained session* (old measured run #38186299280). Treating its time as a small incremental exchange would repeat the original comparison error. The revised harness records `retransmittedHistorySizedPayload` and tests a second session update rather than silently dropping or recategorizing those bytes. In the symmetric exchange, each peer generates its message before either imports updates, matching the upstream Automerge sync-test exchange pattern.
