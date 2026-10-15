# Independent AtomicData / AtomicServer source review

Inspected develop **`a803e305e2a668617ee99935783772a44419e552`**, read-only. No runtime builds/tests were executed and no external changes were made. Source/test existence is not a fresh passing acceptance receipt.

**Atomic deserves a conditional trusted-host shortlist alongside Jazz 2 and PowerSync, especially for a web-first, signed-resource, Loro-based design. It does not yet deserve equal Expo integration confidence.** Its OPFS/WASM/ACL/sync claims have concrete implementation and meaningful negative-test source, rather than only a forward-looking README. Hosting remains trusted; browser encryption at rest and encrypted transport do not make a server holding plaintext resources blind. Bootstrap/snapshot ingestion deliberately trusts authorized peers rather than proving every imported CRDT operation's author.

## Source evidence that changes its standing

| Capability | Concrete inspected evidence | Qualification |
| --- | --- | --- |
| Browser-local database | `ClientDbWorker` opens Rust WASM on OPFS; dedicated worker, Web Locks and BroadcastChannel coordinate multi-tab leader ownership; OPFS cold-load and snapshot replacement regression tests | Real implementation, not browser compatibility or crash-durability proof on this app |
| Native engine | `atomic_lib` Rust database/Loro core and Flutter FFI/WS integration; subprocess drive reconciliation test | Native implementation exists, but Flutter/Rust is not Expo/Hermes |
| Signed incremental edits | `commit.rs` validates Ed25519 signature and author rights; browser peer COMMIT path calls shared peer ingest; forged-commit test asserts unchanged state | Real signed-author path; not proof all snapshot state has equivalent author provenance |
| ACL integration | Browser authenticated challenge, drive scoping, read checks, writer admission, quota/enrollment policies and shared hierarchy checks before data persistence | Substantive integrated checks; requires threat-model and adversarial app fixture before deployment |
| Reconnect / persisted reconciliation | Version-vector sync, local outbox and snapshot materialization; source includes concurrent commit/peer-apply and process-boundary tests | Useful feasibility base; no observed disk-full/receipt qualification performed here |
| Peer browser acceptance | Real WebRTC+WASM+OPFS scripts, server data requests disabled, offline reconciliation and browser reload; mesh script + Rust negative security tests | More than a mailbox imitation; not fresh successful run evidence or physical/NAT/TURN qualification |
| Licensing | Root MIT, `atomic_lib`/server Cargo metadata MIT, `@tomic/lib` package MIT | Core permissive claim supported; trademarks/brand assets excluded, transitive notices remain normal adoption work |

Relevant pinned primary sources:

- [Browser local DB/worker](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/browser/lib/src/client-db.ts).
- [Browser peer ingress and negative tests](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/lib/src/sync/browser_peer.rs).
- [Shared sync engine/import policy](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/lib/src/sync/engine.rs).
- [Commit signature/rights implementation](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/lib/src/commit.rs).
- [Live state resolve/persist](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/lib/src/sync/ws_apply.rs).
- [Real browser acceptance script](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/browser/e2e/scripts/verify-peer-sync.mjs).
- [Cross-process reconciliation test](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/lib/tests/cross_process_sync.rs).
- [MIT license and brand qualification](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/LICENSE).

The pinned source packages identify themselves as `0.41.0-beta.8`; that is source metadata, not independent evidence that an equivalent complete package/runtime is published on npm/crates. New develop code must not be silently attributed to a released stable artifact.

## Snapshot trust is distinct from signed commit proof

The browser peer session authenticates against a fresh challenge bound to its drive and channel, then rejects pre-auth frames, unexpected identity, wrong drive, reader snapshot writes and replayed channel proof. It checks outgoing resource read rights again, including after revocation. The specific negative tests include `reader_cannot_push_snapshots`, `forged_commit_is_rejected_without_changing_state`, `outgoing_access_is_rechecked_after_revocation`, and delayed snapshot/tombstone cases. This is meaningful integrated security implementation.

For **COMMIT**, the session calls `ingest_commit_json(... CommitIngestOpts::peer())`; the author signature/rights path is real. For **SYNC_PUSH**, `import_sync_push` first admits the authenticated writer and target drive, merges Loro snapshot/delta state and persists the resulting resource. Only **after** that does it process optional signed envelopes. The code explicitly says a bad envelope is dropped, **never the push**. Thus accepted state is not contingent on a complete verified signed operation chain. The imported state and a claimed history-author ledger must not be treated as cryptographically equivalent.

Drive checks use already stored resource scope before merging, reject cross-drive entries and check a new resource's resolved parent/drive. The source has regression tests for forged incoming drive attribution. However bulk snapshot permission is an authenticated **drive-writer** boundary. It is not a demonstrated per-operation, per-author historical proof or a newly audited guarantee that hostile authorized drive writers cannot alter narrower resource ACL facts. Pair only with writers trusted at this broader boundary; explicitly test narrower resource restrictions if the app needs them.

Some local/mobile hub cache imports call unconditional trusted-state helpers. Their docstrings intentionally reserve those for established trusted callers. Do not expose these helpers directly to arbitrary transports or mistake the word `checked` for a signature proof.

Deletes have separate signed evidence/tombstone requirements, preventing bare peer deletion and stale snapshot resurrection in tested source cases. This improves deletion authority but does not convert ordinary bulk snapshots into signed state certificates. See [protocol documentation](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/docs/src/sync.md), which itself distinguishes signed commits from snapshots on trusted links, and [browser peer trust statement](https://github.com/ontola/atomic-server/blob/a803e305e2a668617ee99935783772a44419e552/docs/src/browser-peer-sync.md).

## Missing Expo seam and actual effort

No maintained React Native/Expo local persistence/sync adapter was found in the inspected source/docs. `@tomic/lib` being TypeScript does not solve that: its full local DB path depends on Worker, OPFS synchronous access, Web Locks, BroadcastChannel and browser WebRTC APIs. These do not map directly to Hermes. Flutter's existing Rust FFI demonstrates reuse potential, not a reusable Expo package.

There are three honest adoption paths:

1. **Web-first Atomic prototype:** keep the existing Expo static-web surface, isolate the repository adapter and browser worker/WASM assets. Native adoption remains deferred.
2. **Atomic native Rust core in Expo:** new owned JSI/Expo C/JNI/Swift bridge plus durable native store, identity key custody, background/foreground lifecycle, subscriptions and transport integration. This is substantial new ownership and should not be called a small missing AsyncStorage driver.
3. **HTTP-only `@tomic/lib` on native:** possibly reuse server API functionality, but this does not preserve mandatory indefinite local offline operation. A custom mobile cache/outbox/conflict scheme would recreate the hardest part and is not qualified by this review.

Do not rewrite the app to Flutter solely because Atomic ships a Flutter bridge. Require an explicit product/maintenance payoff and a real cooking fixture before reconsidering the framework.

## Fair position versus Jazz 2 / PowerSync

- **Atomic's distinctive strength:** integrated Loro resource model, signed incremental author commits, resource hierarchy/ACL and browser-to-browser operation with optional trusted always-on replica. It can materially reduce bespoke engine/transport assembly for a browser-first app.
- **Jazz 2:** integrated relational DB/accounts/row policies and an existing native/RN package route, though its own device artifacts require verification and integrated E2EE remains missing. Atomic currently has a larger Expo adapter gap; it should not outrank Jazz on native readiness merely because both cores use Rust.
- **PowerSync:** a different integrated local database/backend synchronization design. Its Expo/SQLite integration path and backend service connectors are the relevant comparison; Atomic may offer a more direct signed-resource/peer model, but no source evidence here establishes that Atomic is cheaper, more mature or easier on Expo. This review did not independently re-audit PowerSync source and does not claim feature parity.

All are legitimate **trusted-host** alternatives when that trust model is accepted. None gains host-blind household E2EE merely from TLS, encrypted local disk or user-controlled agent keys. Atomic browser peer links can work without an always-online data server, but closing all peers removes availability; WebRTC signaling/TURN are not durable storage.

## Bounded gate, no new platform port during feasibility

Keep Atomic on the trusted-host shortlist, with priority proportional to whether web-first adoption is acceptable. One browser fixture should create a private drive, two distinct agents, a read-only member and outsider; offline 4/6 recipe edits, restart, catch-up, ordered step move/edit, delete/edit and signed tampering denial. Export stable domain IDs, both disagreement alternatives/provenance and original full Loro history, distinguishing verified commit proof from snapshot-derived state.

The decisive negative case is an authorized drive writer attempting a bulk snapshot that modifies a narrower protected resource/ACL or attributes operations to another author. The test should establish the supported trust boundary, not assume that transport authentication certifies snapshot history. For secrets, replicate an explicit pantry/recipe allowlist and keep chats/provider/group/signing material separate; encrypted storage is not a sharing policy.

For current cross-platform adoption, the missing maintained RN adapter is already a valid feasibility gap. Timebox interface inspection or one tiny native-core call only if Atomic's advantages could justify owning that bridge; stop before implementing a complete Expo driver. Do not require a fourth broad native stack merely to rank the browser candidate.

Conclusion: **substantive current source supports conditional Atomic inclusion; no full-stack winner and no native readiness parity claim.** Its trusted-writer snapshot policy is a documented architecture tradeoff that must remain visible in any comparison scorecard.
