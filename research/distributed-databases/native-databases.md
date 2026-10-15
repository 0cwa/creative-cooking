# Native/integrated distributed databases — fresh review, 2026-10-15

## Finding

Do not rank these solely by whether a ready-made Expo adapter exists, or dismiss an actively developed alpha because a production security gate remains open. **Anyproto deserves a bounded integration spike; DXOS deserves a security/topology qualification spike; NextGraph deserves a precise upstream-completion check before app integration.** They offer substantially more database-shaped abstractions than Matrix. None is presently proved in Creative Cooking. This review independently fetched current primary repositories and inspected source, rather than inheriting catalog assessments. No runtime acceptance tests were executed, so source test assertions below are upstream evidence, not our pass results.

| Candidate | Activity and license | Actual reusable scope | Access/key lifecycle evidence | Browser + RN feasibility | Recommendation |
|---|---|---|---|---|---|
| Anyproto `any-sync` + `any-store` | Main commits Oct 13 / Oct 14; both MIT | Go reusable encrypted space/DAG replication + embedded document DB. `any-store` alone is not a distributed ACL database; app maps objects/changes into sync trees. | Roles owner/admin/writer/reader/guest; request-to-join approval, cancellable requests, invite revoke+rotate, member removal rotates read key; ACL order coordinated via node service. | Pure Go `any-store` now has OPFS/IndexedDB WASM VFS, but explicitly **no exported JS API**, only smoke binary. Native Go mobile bridge is plausible; Anytype Heart demonstrates platform bridges, not a drop-in generic SDK. | **Contender**. First prove generic tiny bridge and durable browser sync without importing restricted Anytype app stack. Missing JS facade is integration; inability to run full any-sync network in browser would be larger scope. |
| DXOS ECHO/HALO/MESH | Current main Oct 14, pushed Oct 15; FSL-1.1-Apache-2.0 with competing-use restriction, future Apache conversion | Existing TypeScript SDK/database, Automerge docs, credential graph, browser worker storage, edge replication, recovery; current source changing rapidly. | Real causal credential graph handles concurrent admin revocation, owner tie-break, recovery revocation. New feed at-rest crypto hook is optional and defaults to plaintext. Complete **blind-server group E2EE + removal rotation** not established from reviewed integration. | Browser is primary; new feed supports browser wasm-sqlite, Node SQLite, Cloudflare DO SQL. No first-party Hermes adapter established. WebView shell could preserve browser runtime but changes architecture. | **Contender for feasibility, not production approval**. Prove ciphertext at durable edge + member removal before UI work. Maintainer sensitive-data preview warning is explicit production gate, not reason to skip assessment. |
| NextGraph | Main Sept 30; canonical Gitea HEAD independently matches GitHub mirror; dual MIT/Apache2 | Rust encrypted semantic graph/document framework; TS React/Svelte/Vue bindings, broker, wallet, Automerge/Yjs discrete docs. | Permission types/capability design extensive; **AddMember/RemoveMember/AddPermission/RemovePermission/RootCapRefresh/BranchCapRefresh commit verifier handlers currently return `Ok(())` with no effects in reviewed file**. This is an incomplete implementation finding, not independently demonstrated exploit. | Browser SDK exists; official JS README says browser materialized UserStorage unfinished. Native framework is Rust/Tauri, so bridge possible, not demonstrated Expo. | **Upstream readiness gate first**. Ask whether functioning lifecycle exists elsewhere/new branch before spending integration time. Do not invent these security handlers ourselves. |
| Anytype Heart | Very active Oct 14; Any Source Available License 1.0 | Reusable middleware technically, but application-specific schemas, search stack, native packaging | Ships Anytype membership/account experience, broader than bare any-sync | Existing Android/iOS/desktop build targets and protobuf bridge, not static PWA SDK | Useful reference app; **do not assume permissive any-sync license applies to Heart**. Commercial use constrained to Allowed Networks unless separately licensed. |
| AnyBlock | Active Oct 13; MIT | v1 protobuf + v2 human-readable interchange format, codecs/export bundle validation | No identity/group-key/transport lifecycle | Platform-neutral format | Useful data-exit inspiration, **not replication/database backend**. |

## Anyproto details: strongest deeper-review discovery

The prior assessment understated browser feasibility. Current `any-store` is now a pure-Go in-tree pager/WAL database with own on-disk format, not simply “SQLite native only.” Its `wasm/` directory has VFS selection **OPFS → IndexedDB → memory**, a browser loader, and document insertion/read smoke example. Crucially it explicitly says: “No JS API is exported here; this is a smoke-test binary. Downstream SDKs import this module and expose their own JS bridge.” This is genuine progress toward PWA support; it does not prove `any-sync`'s transport stack compiles and works in browser WASM. Browser memory fallback must become an explicit failure in acceptance, never silently count as durable persistence.

`any-sync` encrypted trees accept arbitrary app change payloads; that makes retaining Automerge technically conceivable without storing all household state in a chat stream. However the clean generic DB-to-tree materialization API needs demonstration. `any-store` query/search/transact features do not automatically gain conflict semantics or authorization by combining package names. A tiny list change mapping is enough to discover the actual adapter cost.

Concrete current ACL source, not marketing:

- `AclPermissions` includes owner/admin/writer/reader/guest (guest cannot request removal or upgrade).
- `AclSpaceClient` exposes `RevokeInviteAndRotate`, `RevokeAllInvitesAndRotate`, `AddAccounts`, `RemoveAccounts`, `ChangePermissions`, `AcceptRequest`, `DeclineRequest`, `CancelRequest`, `OwnershipChange`.
- `BuildAccountRemove` embeds a read-key change and excludes removed identities from key encryption.
- `revokerotate_test.go` tests a single atomic revoke+rotate record withholding the new key from the revoked invite while surviving invites keep access.
- Anyone-can-join invite holders can derive the current read key even before admission; approval-based request-to-join is therefore the safer default for household invitations, and invite deletion without rotation is not equivalent to withdrawing exposed key material.
- ACL mutations call `nodeClient.AclAddRecord` before adding the resulting record locally. This is coordinated/ordered membership, despite offline CRDT document edits. Concurrent admin membership changes need connectivity/ordering behavior qualified; do not promise fully offline causal ACL convergence.
- Existing sync node/file node/consensus/coordinator services provide asynchronous infrastructure. A permanent node must retain state for devices with non-overlapping sessions. No peer-to-peer protocol makes an absent durable replica unnecessary.
- Bare any-sync does not establish user-friendly lost-device recovery. The reusable `accountservice` key storage vs Anytype account mnemonic/secure device recovery should be explicitly scoped; do not silently import restricted app middleware for this.

**Bounded Anyproto proof:** create a tiny **Go library with JSON request/response facade**, two encrypted spaces, one list item, one read-only principal. Persist via native any-store and browser VFS; send actual generic DAG payloads through existing self-hosted services. Browser test comes first: can an official transport build/connection exchange and reload encrypted payloads using the pinned Go stack? Then build the smallest Android JNI/gomobile wrapper (existing bridge patterns, no hand-written crypto) to execute create/read/change. If full any-sync cannot run in browser without porting its network stack, record that as a high-cost runtime mismatch and stop. The proof should output dependency/license closure, not just demonstrate a Go-only unit test.

## DXOS details: architecture-fit does not prove group encryption

Current HALO/ECHO code has real engineering around authorization that is especially relevant to household administration:

- Credential graph merger has explicit concurrent-branch handling: when a member is removed or downgraded from admin to editor, paths issued by that member are flagged; owner decisions break conflicts with non-owner decisions.
- `CredentialsDocumentStore` now replicates credentials in an Automerge document, reading **add-only history**, so a writer cannot revoke an administrator merely by deleting the administrator's credential from current document state. An upstream test covers the deletion case.
- Recovery manager supports revocable recovery credentials and refuses deleting the last recovery method locally. Source candidly notes that concurrent devices can still revoke all credentials because this guard is local, without consensus. This is a concrete conflict acceptance case, not reason to call the feature absent.
- Durable asynchronous delivery has a concrete new feed layer: browser/Node/Cloudflare persistent stores and server-assigned positions, rollback/store replacement detection, local re-push/de-dup. This is more than “peer sessions must overlap.” A qualification should use the actual edge deployment rather than inventing a durable peer.
- New `FeedStore.cypher` encrypts persisted block payloads at rest when supplied. Current default is plaintext; `createWebCryptoCypher` tests are not evidence that deployed edge replicas never receive plaintext. It is a storage abstraction, and full data-path key distribution + E2EE evidence must be checked independently.
- SDK's current security policy explicitly says not to use it for sensitive/confidential/personal information. Treat this as a production adoption gate to resolve with upstream concrete guarantees, while still allowing a generated-data feasibility proof. Dietary/allergy information must not be used in an unqualified test.

**Bounded DXOS proof:** one browser household ECHO space with persistent edge, two identities; one browser offline and closed while another writes. Inspect edge storage and wire captures for a distinctive generated plaintext marker. Then revoke an offline member and verify it cannot read future payloads or introduce accepted new writes, including a stale-authority branch that admits a third person. Require an existing supported E2EE/rotation configuration; if that configuration does not exist, document missing upstream security work and stop rather than building our own group key scheme. Only after this passes is a WebView-vs-Hermes adapter worth sizing.

## NextGraph details: be precise about planned versus implemented

The canonical upstream remote `https://git.nextgraph.org/NextGraph/nextgraph-rs.git HEAD` returned exactly the mirror pin below. This review is not accidentally judging a stale GitHub fork.

There is real permission processing: `repo.verify_permission()` checks required permissions against member metadata, and new ORM code reverts unauthorized graph patches. It would be inaccurate to claim the whole system has no access control. However six specific lifecycle commit verifiers inspected in `engine/verifier/src/commits/mod.rs` are empty successful handlers. Types and protocol documentation for capability refresh are not enough to demonstrate key rotation or removal. This directly concerns the requested household membership lifecycle.

The official JS README says wallet API is undocumented/intended to be superseded by capability delegation and browser materialized storage is unfinished. That need not prevent all offline operation: encrypted blocks might be persisted and rematerialized, but a fresh-start offline edit test must establish the actual SDK behavior, not presume native Rust persistence transfers to browser. RemoteVerifier deliberately gives the server decryption credentials, so it is not an acceptable shortcut if the requirement is blind-server E2EE.

**Bounded NextGraph gate:** identify exact working public add/remove/rotate API and relevant integration test on canonical upstream. If absent, record explicit upstream gaps. If present elsewhere, run a standalone browser wallet session, persist a tiny discrete Automerge list, close/relaunch offline, remove a member, and verify future access. No Expo port or full app before this.

## Evidence pins and primary URLs

All fetched current 2026-10-15; repository HEAD commits, not claims of release compatibility:

### Anyproto

- any-sync pin `9c00aeeb97370712af8e99bde4a81c586651e903`, Go 1.26.0 declared in go.mod:
  https://github.com/anyproto/any-sync/blob/9c00aeeb97370712af8e99bde4a81c586651e903/README.md
- ACL roles:
  https://github.com/anyproto/any-sync/blob/9c00aeeb97370712af8e99bde4a81c586651e903/commonspace/object/acl/list/models.go
- Actual caller APIs and node coordination:
  https://github.com/anyproto/any-sync/blob/9c00aeeb97370712af8e99bde4a81c586651e903/commonspace/acl/aclclient/aclspaceclient.go
- Removal/rotation builders:
  https://github.com/anyproto/any-sync/blob/9c00aeeb97370712af8e99bde4a81c586651e903/commonspace/object/acl/list/aclrecordbuilder.go
- Invite revoke-and-rotate upstream tests:
  https://github.com/anyproto/any-sync/blob/9c00aeeb97370712af8e99bde4a81c586651e903/commonspace/object/acl/list/revokerotate_test.go
- any-store pin `5e5c787c44b49baeef7decf0920afb9467a63b92`:
  https://github.com/anyproto/any-store/blob/5e5c787c44b49baeef7decf0920afb9467a63b92/README.md
- Browser VFS/no-JS-API limitation:
  https://github.com/anyproto/any-store/blob/5e5c787c44b49baeef7decf0920afb9467a63b92/wasm/README.md
- AnyBlock interchange, not database:
  https://github.com/anyproto/any-block/blob/cd807bb0f0ab9e32679a64cc8e9d2842dc66176e/README.md
- Anytype Heart source license caveat:
  https://github.com/anyproto/anytype-heart/blob/d98420b1113536afd08cde6de9a5816f6d27ffff/LICENSE.md
- Existing native bridge build patterns:
  https://github.com/anyproto/anytype-heart/blob/d98420b1113536afd08cde6de9a5816f6d27ffff/docs/Build.md

### DXOS

- Current pin `0d811677577e239ae9a0f8b6ab035cb9c986835b`; README/API links:
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/README.md
- Production security gate:
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/SECURITY.md
- FSL license:
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/LICENSE
- Concrete causal membership rules:
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/packages/core/halo/credentials/src/state-machine/member-state-machine.ts
- Add-only credential document:
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/packages/sdk/client-services/src/CredentialsDocument.ts
- Recovery manager and concurrent-last-credential caveat:
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/packages/sdk/client-services/src/internal/identity/identity-recovery-manager.ts
- Persistent durable feed topology/restart design:
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/packages/core/echo/feed/README.md
- Optional plaintext-default storage crypto hook:
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/packages/core/echo/feed/src/cypher.ts
  https://github.com/dxos/dxos/blob/0d811677577e239ae9a0f8b6ab035cb9c986835b/packages/core/echo/feed/src/feed-store.ts

### NextGraph

- Canonical remote (verified matching current pin):
  https://git.nextgraph.org/NextGraph/nextgraph-rs
- SDK overview with browser persistence and remote-verifier caveats:
  https://github.com/nextgraph-org/nextgraph-rs/blob/05cfe6c4102710b4769c267caa5bfc34df10395b/sdk/js/README.md
- Six empty lifecycle handlers:
  https://github.com/nextgraph-org/nextgraph-rs/blob/05cfe6c4102710b4769c267caa5bfc34df10395b/engine/verifier/src/commits/mod.rs
- Real permission check (avoid overgeneralization):
  https://github.com/nextgraph-org/nextgraph-rs/blob/05cfe6c4102710b4769c267caa5bfc34df10395b/engine/repo/src/repo.rs
- Real unauthorized patch revert path:
  https://github.com/nextgraph-org/nextgraph-rs/blob/05cfe6c4102710b4769c267caa5bfc34df10395b/engine/verifier/src/orm/graph/handle_frontend_update.rs

## Shared acceptance cases and stopping rule

One list, two households, two editors/one reader/one admin; synthetic data only. Persistent relaunch offline; devices never online together; durable service restart; reader's forged write; offline revocation/reconnect; stale admin adding somebody concurrently with its removal; invite cancellation with exposed-key rotation; lost-device recovery; engine-neutral export and restore. Record when authority becomes effective and that past decrypted material cannot be clawed back. Test cross-household visibility with distinct marker payloads. Stop an integration lane when it needs a new cryptographic protocol/security implementation, not merely when it needs a small conventional adapter.
