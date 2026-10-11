# Merge Analyzer feasibility: Automerge 3.5.0 vs Loro 1.16.4

> **Draft experimental evidence only; not a production migration, UI, engine selection, or permission to prune history.** Built independently from `main` for [issue #36](https://github.com/0cwa/creative-cooking/issues/36). Read-only inputs: [Automerge #37](https://github.com/0cwa/creative-cooking/pull/37), [Loro #38](https://github.com/0cwa/creative-cooking/pull/38). AppState, backups, credentials and screens are unchanged.

## Purpose and execution

Compare **equivalent product behaviour** despite different history interfaces. `spikes/merge-evidence/` contains an engine-independent [proposed TypeScript contract](../../spikes/merge-evidence/contract.ts), immutable event fingerprint + local checkpoint prototype, separate thin adapters, a 12-scenario ledger, and a realistic retained-history benchmark.

```sh
cd spikes/merge-evidence
npm install --no-audit --no-fund
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

## Deterministic scenario ledger

Both engine adapters exercise identical human-visible outcomes. Each row produces a separate machine-readable `PASS` or `FAIL` with evidence and timing; no score is inferred merely from normal LWW reads.

| # | Scenario | Required ledger outcome |
|---:|---|---|
| 1 | Different recipe fields | Both edits survive; zero interrupting events; optional activity history only |
| 2 | Different ingredient properties | Amount and qualified name both preserved by stable ingredient ID |
| 3 | Concurrent portions=4/6 | **Unresolved** scalar event, both values/authors/change IDs, restart-stable fingerprint |
| 4 | Later causal portions=5 | Proved new change follows both alternatives; old event becomes **resolved**, retains 4/6 |
| 5 | Concurrent atomic title | Distinct full title alternatives preserved, no unapproved winner |
| 6 | Non-overlapping method text | Merged prefix and suffix retained; no false scalar conflict |
| 7 | Reorder vs content edit | Step IDs and new order survive, content change retained |
| 8 | Delete vs edit | Tombstone and edited entity coexist; semantic event offers keep/delete |
| 9 | Two independent carrot items | Both distinct IDs and preference 5 versus 2 remain, semantic dedupe suggested |
| 10 | Suspicious yet valid yield | Separate policy heuristic, not an automatic CRDT conflict |
| 11 | Three replicas/merge direction | Same alternatives and stable event ID across orders |
| 12 | Duplicate/out-of-order/restart | Real engine updates converge; event replay and local dismissal are idempotent |
| R | Destructive-history retention | Both ordinary full snapshots retain 4/6; Loro shallow trim loses raw losing-write evidence; durable checkpoint remains unresolved |

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

## Cost, integration and failure modes

The [benchmark](../../spikes/merge-evidence/benchmark.mjs) builds a roughly cooking-shaped fixture: **200 pantry entries, 500 additional recipes × 5 ingredients × 4 steps, 100 conversations × 20 messages**, and **800 real retained causal edits** plus two concurrent portions edits. It measures build and snapshot bytes, cold load+evidence extraction median, warm queries, Loro index first build/incremental change cost/index bytes, ledger bytes, Automerge first-class conflict reads separately, and adapter lines of code. Results are stored in `benchmark-results.json` rather than hardcoded here until a successful Actions run exists. Node/V8 runner measurements are directional, **not iPhone/Android timings**. Structural schema differences mean these are evidence-access measurements, **not a CRDT-wide speed verdict**.

Maintenance-cost distinctions:
- Automerge: less code for *live scalar conflicts*, but still an activity/change index, semantic rules, persistence, provenance join tests, and native bridge parity; op-to-change association can become ambiguous on repeated actor writes.
- Loro: extra low-level op decoding, update-triggered index management, causal maximal-write selection, version compatibility tests and destructive compaction guard; its RN bridge release lag may require native API work.
- Shared: stable-ID/tombstone schema migration, explicit review decisions, local checkpoint consistency, cleanup retention UX, privacy redaction, transport delivery dedupe, metadata upgrades, and a separate semantic policy engine.
- Risks: dropped operations after shallow trimming, stale index after app crash, index version mismatch, missing native metadata, rendering an unapproved LWW winner, and replay re-opening dismissed events. No app account/credential/device-only data belongs in replicated evidence.

## Research limitations

This branch intentionally does **not** provide an Expo UI, cross-native benchmark, generalized diff of every recipe field, production storage transaction, or decision between the engines. The synthetic authors/device IDs are test fixtures, not authenticated device identity. Do not merge the experimental branch into production based solely on these results.
