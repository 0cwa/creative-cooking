# Loro local-first feasibility spike

> Status: executable spike in progress. This branch is deliberately isolated from production AppState/persistence and from the Automerge spike. Do not merge this PR.

## Scope and fairness

This spike starts from Creative Cooking main at `a1c8993c4f45e9bb8de2b18d4f644088df99845a`. It does not migrate `AppState`, IndexedDB, AsyncStorage, the backup format, or credentials. The experimental document uses the same logical entity IDs and field boundaries as the application domain model.

Umbrella issue: #36.

## Pinned upstream inputs

- `loro-dev/loro` inspected at `c00c9fa501f8d32f68d6255eacb7035a67fb6ab6`.
- Web package under test: `loro-crdt@1.16.4`.
- `loro-dev/loro-react-native` inspected at `8fad8d61c11c23e7c57999533d637d316465ffc1`.
- React Native package under test: `loro-react-native@1.13.2`.
- The RN wrapper's bundled Rust crate declares `loro-ffi = 1.13.7`.
- Creative Cooking: Expo 57.0.17, React Native 0.86.3, React 19.2.3.

The official RN wrapper's own dev matrix is React Native 0.79.2 / React 19.0.0, so compatibility with this repo must be demonstrated rather than inferred.

## Central architectural question

Loro maps converge to one visible value for a key. The spike must establish whether a future Creative Cooking review UI can reconstruct competing same-field writes using only documented/public-enough Loro history/version APIs, without inventing a second replicated conflict engine.

The web package currently exposes history/version facilities including version vectors/frontiers, diffs, change traversal, JSON update history, and operation inspection. The current RN wrapper does not appear to expose the same high-level JS history surface or the newer `ensureMergeable*` helpers; CI probes and native builds below are the source of truth.

## Common test contract

| # | Scenario | Result |
|---|---|---|
| 1 | Different recipe fields | PENDING |
| 2 | Same nested entity, different properties | PENDING |
| 3 | Concurrent additions | PENDING |
| 4 | Concurrent text editing | PENDING |
| 5 | Chat appends | PENDING |
| 6 | Set-like additions | PENDING |
| 7 | Same scalar disagreement | PENDING |
| 8 | Different atomic titles | PENDING |
| 9 | Delete versus edit | PENDING |
| 10 | Duplicate pantry creation | PENDING |
| 11 | Reorder + edit | PENDING |
| 12 | Restart | PENDING |
| 13 | Out-of-order import | PENDING |
| 14 | Duplicate update | PENDING |
| 15 | Long offline divergence | PENDING |
| 16 | Merge direction | PENDING |
| 17 | Incremental sync/updates | PENDING |
| 18 | Three replicas | PENDING |

## Native / interop

| Check | Web | iOS | Android |
|---|---|---|---|
| Package/runtime initializes | PENDING | PENDING | PENDING |
| Snapshot/update import/export | PENDING | PENDING | PENDING |
| Real web/native interchange | PENDING | PENDING | PENDING |
| Same-field evidence survives exchange | PENDING | PENDING | PENDING |

## Performance fixture

Pending executable benchmark: 200 pantry items, 500 recipes, 100 conversations, about 20 messages/conversation.

## Research notes to verify with executable evidence

- Map scalar semantics are LWW-like: normal document state alone does not preserve a multi-value register UX.
- `loro-crdt` exposes `getAllChanges`, `getOpsInChange`, `exportJsonUpdates`, and frontier/version comparisons that may be sufficient to derive conflicting same-key writes from retained history.
- A shallow snapshot deliberately discards older operation history. If unresolved review evidence exists only in discarded history, compaction can destroy the ability to reconstruct it unless Creative Cooking materializes that unresolved evidence before compaction.
- Mergeable map-key containers improve concurrent child-container creation, but they do not turn scalar map keys into multi-value registers.
- The RN binding is a TurboModule/UniFFI bridge with prebuilt native artifacts; its package version is 1.13.2 and its Rust dependency is Loro FFI 1.13.7, behind the current web 1.16.4 package.

## Explicit questions

1. Does the official React Native binding actually work in this repo? **PENDING**
2. Can web and native exchange real Loro snapshots/updates? **PENDING**
3. Can same-field concurrent disagreement be reconstructed simply and reliably? **PENDING**
4. Does doing so depend on public/stable-enough APIs? **PENDING**
5. What does Loro's normal LWW map behavior cost Creative Cooking? **PENDING**
6. What native complexity does Loro save relative to implementing another engine bridge? **PENDING**
