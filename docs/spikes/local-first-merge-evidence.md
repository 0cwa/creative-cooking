# Merge Analyzer feasibility: Automerge 3.5.0 vs Loro 1.16.4

> **Draft experimental evidence only; not a production migration, UI, engine selection, or permission to prune history.** Built independently from `main` for [issue #36](https://github.com/0cwa/creative-cooking/issues/36). Read-only inputs: [Automerge #37](https://github.com/0cwa/creative-cooking/pull/37), [Loro #38](https://github.com/0cwa/creative-cooking/pull/38). AppState, backups, credentials and screens are unchanged.

## Purpose and execution

Compare **equivalent product behaviour** despite different history interfaces. `spikes/merge-evidence/` contains an engine-independent [proposed TypeScript contract](../../spikes/merge-evidence/contract.ts), immutable event fingerprint + local checkpoint prototype, separate thin adapters, a 12-scenario ledger, and a realistic retained-history benchmark.

```sh
cd spikes/merge-evidence
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run benchmark
```

The isolated [experimental GitHub workflow](../../.github/workflows/merge-evidence.yml) runs this on Node **22.13.0**, installs **exact** `@automerge/automerge@3.5.0` and `loro-crdt@1.16.4`, and uploads `scenario-results.json`, `merge-event-ledger.json`, `benchmark-results.json`, the durable checkpoint JSONs, and the generated npm lock. The root package/dependencies/normal CI remain untouched. Workflow results are the authoritative executable evidence, not unverified assertions in this report.

## Event contract and product behaviour

`MergeEvent` includes: stable SHA-256 fingerprint/id over sorted engine operation/change identity tokens plus logical path; event kind, entity and path; complete alternatives with values, opaque author, change and operation IDs and known dependencies; concurrency; observation frontier; unresolved/resolved/dismissed status and proven resolution; optional actions; and explicit completeness/missing capabilities. IDs are stable **within the same observed history across delivery order and restart**; identifiers from different engines are not expected to be equal. No timestamp or displayed LWW winner enters a fingerprint.

An event is **derived evidence**, not an authoritative replicated edit. A source adapter **may not** declare `resolved` just because it sees one value: an explicit causal proof for the later `5` edit is mandatory. A device's **local dismissal** only affects its local ledger, never silently dismisses another device's item. Shared review decisions, if ever wanted, require a separately designed replicated review operation with explicit per-user/space policy. Repeated extraction, duplicate updates, replay, and ledger restart must not reopen resolved or dismissed events. Opaque device identity is never a provider credential.

Events can be low priority. Clean field merges and non-overlapping text/reorder edits need no blocking review. Same-field portions or title disagreement stays reviewable even if the engine renders one winner. Delete vs edit and duplicate pantry items are **application semantic events**: stable IDs, tombstones and separate preferences must survive. A heuristic yield/ingredient mismatch is only a **suggestion to inspect**, not a CRDT conflict or automated correctness verdict.

### Example serialized event shape

```json
{
  "schemaVersion": 1,
  "id": "merge:v1:<sha256-of-actual-evidence>",
  "fingerprint": "<sha256-of-actual-evidence>",
  "sourceEngine": "loro",
  "kind": "scalar-disagreement",
  "entity": {"type": "recipe", "id": "recipe-1"},
  "path": ["portions"],
  "alternatives": [
    {"value": 4, "authorId": "101", "changeId": "0@101", "operationId": "0@101", "dependencies": null},
    {"value": 6, "authorId": "202", "changeId": "0@202", "operationId": "0@202", "dependencies": null}
  ],
  "concurrency": "concurrent",
  "frontier": ["0@101", "0@202"],
  "completeness": "partial",
  "missingCapabilities": ["per-operation-dependency-list-not-exposed-by-index"],
  "status": "unresolved",
  "resolution": null,
  "actions": ["choose-value", "edit-new-value", "dismiss-for-now"],
  "reason": "Concurrent writes to one atomic scalar"
}
```

This is **illustrative**: the actual code-generated hashes, change counters/frontiers, identities and status examples are in the machine-readable workflow artifact. `<...>` placeholders above are not literal fixture output. Automatic event identity excludes local review status.

## Deterministic scenario ledger — observed results

**[Latest full scenario+retention PASS run #38186451482](https://github.com/0cwa/creative-cooking/actions/runs/38186451482)** at `28ecd972`: **13 PASS / 0 FAIL for each engine** (12 numbered product scenarios + R). The [machine-readable results and exact event alternatives](https://github.com/0cwa/creative-cooking/actions/runs/38186451482/artifacts/11720240531) are authoritative for change IDs, timings and individual assertions. PASS here means executable **Node web-engine evidence**, not native parity.

| # | Scenario | Automerge | Loro | Observed product outcome |
|---:|---|:---:|:---:|---|
| 1 | Different recipe fields | PASS | PASS | Independent title and portions edits preserved, no interrupting event |
| 2 | Different ingredient properties | PASS | PASS | Amount `3` and name `tomatoes (ripe)` preserved under one stable ID |
| 3 | Concurrent portions=4/6 | PASS | PASS | **Unresolved** scalar event; 4 and 6, author and actual change IDs, stable fingerprint after full restart |
| 4 | Later causal portions=5 | PASS | PASS | Causal proof closes dispute as **resolved**, historic alternatives 4/6 remain in event ledger |
| 5 | Concurrent atomic title | PASS | PASS | Both complete titles remain accessible despite one displayed winner |
| 6 | Non-overlapping method text | PASS | PASS | Both prefix `Gently ` and suffix ` Simmer for 10 minutes.` retained |
| 7 | Reorder vs content edit | PASS | PASS | Step order `step-2, step-1`, edited `step-1` note survives |
| 8 | Delete vs edit | PASS | PASS | `deleted=true` plus offline title edit, both authored intentions retained; no physical deletion |
| 9 | Two independent carrot items | PASS | PASS | Both IDs and preference **2 versus 5**, no destructive silent dedup |
| 10 | Suspicious yet valid yield | PASS | PASS | Separate **application-policy** event with source change IDs, not a CRDT conflict |
| 11 | Three replicas/merge direction | PASS | PASS | Same 4/6 alternatives and identical event fingerprint across merger orders |
| 12 | Duplicate/out-of-order/restart | PASS | PASS | Real engine updates converge; event replay dedup; local dismissal does not change other device's review status |
| R | History/persistence policy | PASS | PASS | Both ordinary full snapshots retain alternatives; Loro shallow loses raw alternative evidence, while pre-prune checkpoint remains unresolved; corrupted checkpoint rejected |

The Loro artifact identifies the portions alternatives as `0@101` (4) and `0@202` (6), with causal resolution `0@303` (5). Automerge's op IDs/change hashes are distinct opaque actor/hash tokens included in the artifact, not mapped to fabricated universal IDs. The visible Loro portions value of 6 in this fixture is **not** a user-approved choice.

## Implementation and correctness boundaries

**Automerge adapter:** uses public `getConflicts` for live multi-value reads; `getChangesMetaSince` and `getAuthorForActor` for attribution and dependency hashes; `save/load`, `merge`, `getChanges/applyChanges` for real replay. An op ID alone is **not** a unique change-hash join if the same actor has multiple changes, so the prototype reports missing capabilities rather than making one up. First-class scalar reads are cheap; low-priority activity history, durable dismissal, and semantic rules still need a separate derived ledger. **Ordinary `save()` retains competing edits**; no destructive Automerge prune is asserted or attempted.

**Loro adapter:** uses supported `getAllChanges`, `getOpsInChange`, `cmpFrontiers`, `frontiers`, snapshot/update import/export, and `LoroMovableList/LoroText`. A local incremental index records operation IDs and fields once, then uses frontier change detection to avoid scanning the full operation history on every query/render. Metadata enumeration on updates still costs O(retained change count); this is not a native conflict primitive, replication engine, or custom vector clock. Because `getOpsInChange` is low-level `any[]` with serde-shaped root containers and map writes, its shape is pinned by the executable tests. Causal comparisons use engine `cmpFrontiers` exclusively. Scalar alternatives and their author/operation IDs are reconstructable only while the underlying history is retained.

**Durability and compaction:** the prototype writes a checksum-validated, fsynced, atomic-rename **local review checkpoint first**, with unresolved event alternatives and a derived index. Then it exercises Loro `shallow-snapshot` at a post-conflict frontier: reconstructing losing writes from this compacted engine document is not assumed possible. The checkpoint survives, and missing evidence never silently becomes a review resolution. The conservative default is **retain full engine history while any unresolved item exists**, with evidence checkpointing before any hypothetical future destructive compaction. An unresolved checkpoint after pruning can preserve UI evidence but may **not** establish causal closure across removed operations; hold unresolved or require explicit review/retention policy. A production database needs transaction/recovery semantics for engine checkpoint + index, which this file experiment does not implement. Index and review status are locally derived data, not new authoritative replicated recipe changes.

## Capability matrix (as evidenced by referenced engine PRs; this worklane runs JS only)

| Engine / platform | Scalar alternatives | Change/author provenance | Reliable review retention | Evidence level |
|---|---|---|---|---|
| Automerge JS 3.5 web/Node | First-class `getConflicts` | JS change/deps and actor-author | Full save/load and local checkpoint test | Web evidence; this harness |
| Automerge Swift 0.7.2 iOS | Conflict/sync tests pass in simulator (#37) | Swift source metadata demonstrated in engine spike | No independent native ledger test here | **PARTIAL merge-ledger parity**, simulator core confirmed |
| Automerge Java 0.0.9 Android | Values exposed | Proven provenance API gap; live web↔Java SyncState mismatch (#37) | No Android runtime retention proof | **PARTIAL**; app build is not runtime proof |
| Loro JS 1.16.4 web/Node | Reconstruction from retained ops, not live LWW | Public low-level history & frontier APIs | Full snapshots yes; shallow requires checkpoint or retained history | Web evidence; this harness |
| Loro RN 1.10.3 iOS | No demonstrated current-op API parity | Published native release behind 1.16.4 JS | No executable native ledger test | **PARTIAL / unproven** |
| Loro RN 1.10.3 Android | ARM64 build proved, not runtime | No demonstrated parity | No executable native ledger test | **PARTIAL / unproven** |

Do not promote a web-derived index to native capability without an actual native binding API/runtime result. Do not equate `PARTIAL` with a negative verdict on future bindings.

## Measured cost and integration implications

**Verified pinned Linux runner:** [experimental Actions run #38186275958](https://github.com/0cwa/creative-cooking/actions/runs/38186275958) — [machine-readable JSON artifact #11719139761](https://github.com/0cwa/creative-cooking/actions/runs/38186275958/artifacts/11719139761), 26/26 scenario+retention assertions passed. Subsequent commits add stronger review-isolation regression tests; use the latest PR checks for the final verdict. The artifact carries the exact CPU, Node version, five timing samples, event examples, ledger state and checkpoints.

The [benchmark](../../spikes/merge-evidence/benchmark.mjs) builds **200 pantry entries, 500 additional recipes × 5 ingredients × 4 steps, 100 conversations × 20 messages**, and **800 retained causal edits** plus a concurrent 4/6 dispute. Two different schemas implement the same logical workload; these are **evidence-layer measurements, not fair general-purpose CRDT engine benchmarks**.

| Node 22.13.0 / Linux sample metric | Automerge JS 3.5.0 | Loro JS 1.16.4 |
|---|---:|---:|
| Full engine snapshot | 246,439 B | 275,581 B |
| Cold load **plus conflict evidence extraction**, median of 5 | 385.0 ms | 80.5 ms |
| Warm evidence query median of 20 | 8.315 ms | 0.169 ms (activity index) |
| Direct first-class conflict read **without metadata scan** | 0.0154 ms | Not available |
| Full-activity index initial build | Not built | 44.2 ms / 15,015 decoded ops |
| Full-activity index JSON | Not built | 2,103,716 B |
| Filtered review-only index JSON / indexed writes | Not built | 194,387 B / 1,007 |
| Filtered review-only initial build / warm query | Not built | 39.2 ms / 0.063 ms |
| Full activity index update after one new operation | Not built | 17.6 ms / 1 newly decoded op |
| Serialized one-disagreement local ledger | 1,259 B | 793 B |
| Adapter source lines (including fixture/replay helpers) | 140 | 238 |

**Interpretation matters more than a speed ranking.** Automerge's live `getConflicts` primitive alone takes ~0.015 ms here. Its warm `scalar()` prototype also reads **all** change metadata for author/change attribution, which explains the much larger ~8.3 ms full-evidence number. A production Sync Activity feed or repeated same-author op-to-change mapping would need an indexed provenance strategy even with Automerge. This spike deliberately did **not** build an Automerge full-activity index; treating its missing index bytes as zero overhead would be misleading.

Loro can deliver ~0.06–0.17 ms warm queries from a frontier-cached derived index, but the **full-activity index is ~7.6× its snapshot size** because it retains a verbose JavaScript representation of map operations. Filtering for review-relevant recipe/pantry/ingredient fields reduces it to ~194 KB (~0.7× the snapshot), at the cost of **not** providing a complete historical activity feed. Both index variants decode operations once during build, then use the frontier check to skip full history enumeration on ordinary UI renders. After new changes, `getAllChanges` still enumerates retained change headers (1,653 **cumulative** header visits in this update benchmark), though only one newly seen op was decoded. Index update cost is consequently **not** constant in total history size, and a durable incremental change notification API or chunking would be useful in a production port.

The 5-sample medians and construction timings vary significantly between hosted runners. These are **not physical device, JS-to-native crossing, browser UI frame, or APK/IPA measurements**. Differences in nested Automerge structure versus Loro root containers, the snapshot format, and the scope of their evidence adapters prevent a winner claim. The serialized ledgers are not directly comparable per byte because the two engines carry different change identifiers/dependency detail.

### Maintenance cost and failure modes

- **Automerge:** ~140 lines for the experimental adapter. It substantially reduces **live multi-value detection** code, but full Sync Activity/history queries, repeated-actor op→change joins, durable local review state, semantic rules and native metadata bridges remain. Java 0.0.9's existing attribution gap and live web↔Java sync incompatibility are separate blockers from this evidence implementation.
- **Loro:** ~238 adapter lines. Owns low-level serde operation parsing, maximal-write causal tests, mode-specific index persistence, frontier invalidation and compaction guards. The JavaScript index can be optimized to just review-relevant fields, but the RN publication and API/version gap matters.
- **Shared:** stable-ID/tombstone migrations, reviewed-vs-dismissed semantics, physical-delete retention, credential-safe redaction, schema/version migration of local index/checkpoints, transport duplicates, and cooking-specific semantic inspection.
- **Failure modes:** Loro shallow compaction losing old losing-writes, stale/corrupted local ledger after restart, an unapproved LWW display promoted to a human decision, index invalidation missing imported remote changes, future operation-shape changes, or native bindings missing API parity. The test rejects tampered checkpoints and proves local review states diverge safely; there is **no** production multi-store transaction yet.

## Research limitations

This branch intentionally does **not** provide an Expo UI, cross-native benchmark, generalized diff of every recipe field, production storage transaction, or decision between the engines. The synthetic authors/device IDs are test fixtures, not authenticated device identity. Do not merge the experimental branch into production based solely on these results.
