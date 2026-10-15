# Distributed database and access control feasibility

Reviewed 15 October 2026. **Replace the Matrix-first / Jazz Classic shortlist with a broader database and permissions comparison.** Active alpha software is eligible. The decisive questions are implemented behavior, upstream progress, integration effort and trust boundaries, rather than a stable version label or a ready-made Expo wrapper alone.

**Source-qualified trial order: Chelonia first for encrypted integration, with p2panda as the strongest offline-authority challenger.** Keep Evolu and Anyproto in the active shortlist with narrowly defined completeness/platform checks. Current Keyhive/ARK remains the closest Automerge fit, but a fresh execution still fails important gates. **PowerSync + Postgres is the practical trusted-server baseline**, with PouchDB/CouchDB as the independent mature comparator. Jazz 2, Atomic Data and HHSv3 remain legitimate progressing alternatives, with different native and confidentiality gaps. No stack has yet won an executed cross-platform household bake-off.

## Scope and evidence

Six agent lanes and a coordinating review checked database engines, integrated collaboration frameworks, cryptographic authority systems, SQL/document sync services and policy engines. The earlier [227-entry OpenHaven inventory](../research/openhaven/evidence.json) provided discovery coverage; current repositories, implementation files and releases supplied the decisive evidence. The [source reviews](#source-reviews) cover both directory entries and adjacent candidates. Catalog screening is not an audit of every implementation.

The one new runtime experiment is the updated ARK Node/WASM probe described below. Other findings are source/release qualification, including inspection of upstream test code, not fresh passing app-runtime receipts. Source HEAD and published package capabilities are distinguished. Existing local household work and the working Automerge choice remain useful, but preserving an engine does not justify assembling an unfinished security platform.

## Requirements and trust choices

One person can belong to several households. Each household owns independent shopping lists, selected recipe copies and dietary requirements. Personal chats, notes and individual health data stay outside those scopes. A combined errands view queries authorized lists locally; it does not merge households or grant new access. Stable IDs and provenance preserve the destination of each checkoff and recipe copy.

Every contender must support durable offline edits and cold restart, non-overlapping device sessions, explicit reader/editor/admin authority, understandable removal/recovery behavior and portable exports. Offline administrator changes are an additional capability: a server-coordinated membership service can still support offline shopping. Do not reject it for failing a stronger requirement we have not selected.

| Trust model | What permissions mean | Consequence |
| --- | --- | --- |
| End-to-end encrypted groups | Peers enforce authenticated authority and only authorized members receive content keys; durable host lacks plaintext keys | Key distribution, removal, recovery and concurrent policy require an integrated implementation. Encrypted links alone are insufficient. |
| Trusted database/replica | Server or authorized durable replica can read data and enforces membership/row/resource policy | Far more complete SDK choices today. User must explicitly accept this privacy tradeoff; self-hosting changes the operator, not the cryptographic model. |

Neither model can retract plaintext already downloaded by a former member. Test future access, rejected queued writes and cooperative local cleanup separately. Do not count a failed initial reader-decryption flow as successful revocation.

## Encrypted collaboration shortlist

| Candidate | Why it deserves attention | Actual remaining work and next decision |
| --- | --- | --- |
| **Shelter / Chelonia** | Published `@chelonia/lib`2.0.0, encrypted contract state/events, ordered durable server log, bounded/revocable invites, key opcodes; reference app implements removal and active-member key redistribution | Best first small adoption test: browser persistent store/outbox, offline queue and reconnect rejection, household role contract and Expo import. Library's default raw-event store is lightweight/no-op or memory; persistence must be wired. Household policy/recovery is not turnkey. AGPL/commercial terms. [Source](https://github.com/okTurtles/libcheloniajs/tree/9c3afd2081d2fc216d7e8f713717b54079fbc6ac). |
| **p2panda auth/spaces** | Current main integrates causal signed logs, SQLite, offline strong-remove group authority and encryption; can carry Automerge changes | Best architectural challenger when offline authority matters. First qualify browser/mobile route and two isolated spaces. Current global repair spreads unrelated group authorization metadata; explicit secret UPDATE and high-level conditional capabilities are unfinished. Main is ahead of release0.7.1. Permissive dual license. [Source](https://github.com/p2panda/p2panda/tree/c99f5014836cb26ba96688baafad0d4cdb6e61d7). |
| **Evolu 8** | Actual encrypted SQL/CRDT database, owner scopes, replaceable relay, recovery secrets; current native package develops against our Expo57/RN0.86 generation | Strong platform/database match. SharedReadonlyOwner sync is explicitly TODO; owner/database deletion unfinished; administrator/member rekey lifecycle not qualified. Verify existing public APIs before planning missing group features. MIT. [Source](https://github.com/evoluhq/evolu/tree/f48a2580f44e74ee5362dd0bcb0ad86a675f4f3b). |
| **Anyproto any-sync + any-store** | Implemented encrypted spaces, roles, approval joins, revoke-invite-and-rotate and member-removal read-key rotation | Strong existing lifecycle. Browser any-store has OPFS/IDB WASM but exports no JS API; full any-sync browser networking and a tiny Go/native facade are the bounded feasibility question. Do not import restricted Anytype Heart unnoticed. Generic libraries MIT. [ACL source](https://github.com/anyproto/any-sync/blob/9c00aeeb97370712af8e99bde4a81c586651e903/commonspace/acl/aclclient/aclspaceclient.go). |
| **Keyhive / ARK / Subduction** | Most direct Automerge integration; causal permissions, encrypted documents and blind persistent peers; actively changing, substantive current fixes | Fresh current-graph probes still fail tampered-card admission, authorized-reader archive decryption and policy expectations. Recovery absent and integration refactor imminent. Keep upstream engagement/requalification, not current adoption. [Probe evidence](../research/distributed-databases/ark-current-security-matrix.json). |
| **Peergos** | Existing cryptographic read/write groups, removal/rekey, bounded secret links, durable encrypted storage; new functional Rust client | Larger adapter: prove offline writes/CAS with immutable Automerge-change files, multiple household admins and browser/Expo bridge. Current product's advertised offline path is cached reads. Stronger than a generic filesystem dismissal; secondary trial if first options fail. AGPL. [Source](https://github.com/Peergos/Peergos/tree/587e27288f7f59cf664ff870ac135ba2f17e4fea). |

This ranking favors a tractable next proof, not a claim that Chelonia's security is stronger than all alternatives. An encrypted contract framework brings serialized accepted actions; p2panda brings causal/offline authority with more platform work. Database-shaped fit alone does not settle implementation or maintenance cost.

## Database and server authorization shortlist

These are conditional alternatives, not a silent downgrade from E2EE.

| Candidate | Useful implemented path | Main qualification or tradeoff |
| --- | --- | --- |
| **PowerSync + Postgres/Supabase** | SQLite offline database, persistent write queue, browser/Expo SDKs, durable catch-up; current Sync Streams plus upload RLS/API | First practical baseline. Downloads and uploads need separate authorization; same-field recipe disagreements need a deliberate history/conflict model. Host sees plaintext. Apache SDKs; service FSL with later Apache conversion. [RLS integration](https://docs.powersync.com/integrations/supabase/rls-and-sync-streams). |
| **PouchDB + CouchDB** | Mature revision replication/conflict retention, DB-per-household read boundary, validated role-aware writes; active OP-SQLite native adapter | Best permissive independent comparator. App owns database provisioning and semantic conflicts; read filters are not security. Core Apache, adapter MIT. [Native adapter](https://github.com/craftzdog/pouchdb-adapter-react-native-sqlite/tree/0e99dfd0d72b97ed35a8d4da500c89e3e2e0ab76). |
| **Jazz 2** | Active relational local-first DB, accounts/recovery, group row policies and real persistent RN native route | Reopen current alpha, rather than default to Classic. Specific native code/release notes supersede stale scaffold README. Newer crypto adapters explicitly omit table/key lifecycle integration; published alpha.59 does not include them. Host-trusting ACL contender today. MIT. [Crypto boundary](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/crates/jazz/SPEC/E2EE_CRYPTO_FORMAT.md). |
| **Atomic Data / AtomicServer** | Active Loro database, browser OPFS, signed commits, resource hierarchy ACL, native Rust/Flutter, WS/Iroh/WebRTC | Good web-first contender. No maintained Expo adapter identified. Bulk snapshots deliberately trust an authorized writer rather than proving every historical author. Server-readable replicas. MIT code. [Source](https://github.com/ontola/atomic-server/tree/a803e305e2a668617ee99935783772a44419e552). |
| **Hyper Hyper Space v3** | Actual implemented causal capabilities/revocation, offline DAG types, SQLite/IDB relational projection and browser host | Strong authority/database challenger; current v3 deserves evaluation independently of discouraged v2. Reviewed encrypted peer sessions do not establish blind replicas/group rekey. Native adapter and irrevocable creator authority need qualification. MIT. [Source](https://github.com/hyperhyperspace/hhs3-ts/tree/f550595fe02ae7853ea02ce7e4cde1eba8e0e907). |
| **RxDB + Supabase** | Reactive document DB, browser/native stores, checkpointed replication and server membership RLS | Credible alternative if document model is preferred. Native premium storage terms, conflict handling and access-loss cleanup matter. Storage encryption is not automatically group E2EE. [Replication](https://rxdb.info/replication-supabase.html). |
| **Electric + TanStack DB** | Authenticated read shapes plus current persistent offline transactions and RN SQLite adapters | Worth a composition check; mutation API, idempotence, membership enforcement and reconciliation remain app work. PGlite browser WASM is not Hermes support. Permissive components. [Offline transactions](https://github.com/TanStack/db/blob/3a98e0062fda2084596d218c14609f30dbef365a/docs/guides/offline-transactions.md). |
| **Turso Sync** | Current SQLite offline writes/push/pull, browser and official RN packages, token-scoped permissions | Credible conditional baseline; qualify household scope, current service independence and conflict semantics. MIT core; source database/service distinctions matter. Acquisition announcement explicitly says development/platform continue. [RN source](https://github.com/tursodatabase/turso/blob/d808271a35472bd94d2f0efbc7bb69fab3be6b26/bindings/react-native/README.md). |

If trusted hosting is selected, start with database-native membership/RLS rather than a separate permissions server. **OpenFGA, SpiceDB and Ory Keto** are existing relationship engines for future complex share graphs; **Cedar, OPA and Casbin** are existing policy evaluators. They avoid inventing a generic ACL engine but do not distribute group encryption keys or make cached offline permissions authoritative. Their consistency/enforcement boundaries are covered in the supplemental review.

## Other options and why they have lower priority

| Family | Finding affecting priority |
| --- | --- |
| DXOS ECHO/HALO/MESH | Active Automerge database, causal credential graph, recovery and durable edge feed deserve a proof. Current sensitive-data warning is a production gate, not a reason to skip research. Complete edge-blind E2EE/rotation is not established by optional local feed encryption; native/storage and FSL fit remain. |
| NextGraph | Substantial encrypted graph architecture and real permission checks; six current membership/permission/capability-refresh verifier handlers return success without implementing the transition. Identify a working lifecycle elsewhere/upstream before app integration. Not a claim every authorization path is absent. |
| Willow / Meadowcap / UCAN | Real scoped/offline authority. Current Willow Rust has persistence; iroh-willow has a persistent confidential-sync implementation. Different implementations must not be conflated. None checked supplies a complete managed household content-key lifecycle/recovery stack. |
| Hypercore / Autobase / HyperDB | Actual native Expo/Bare route, durable logs/views, writer membership and blind peers. Household read-key rotation/admin roles/recovery and full browser path still need composition. |
| Loro / protocol | Actual RN binding and persisted encrypted document transport; protocol explicitly leaves key agreement to the app. Engine switch alone does not solve access control. |
| OrbitDB / Fireproof | Real replicated/encrypted database capabilities; verified group invitation/removal/recovery is weaker, and browser support is not automatic Expo qualification. OrbitDB's simple encryption example warns it is demonstration-only. |
| Yjs / Hocuspocus / Y-Sweet | Useful existing authorized durable collaboration backends; standard server-materialized paths trust the server, group-key lifecycle remains separate. Avoid switching CRDT merely to change equivalent transport glue. |
| CoMapeo / Awana | Deployed offline mobile framework, but mapping schemas/embedded Node/PWA adaptation are substantial; standard archive peer receives project encryption keys. |
| GUN / Holochain / AD4M / Freenet | Genuine active distributed frameworks. Specific authority models, large runtime adoption or missing authenticated group lifecycle increase the app-owned work. AD4M's link-server docs explicitly identify recipient-key authentication/admin-revocation gaps. |
| CryptPad / AppFlowy Collab / Fluree / WatermelonDB / Convex | Valuable existing products/libraries/policy databases. Their checked reuse paths either demand larger product/runtime extraction or leave more offline synchronization/backend work than leading candidates. Details and narrower limitations in supplemental review. |
| InstantDB / Triplit / localfirst-auth / secsync | Respectively announced cloud sunset, weak current maintenance evidence, archived middleware, or key exchange/rotation explicitly excluded. These concrete facts matter more than version labels. |
| SQLiteAI SQLite-Sync | Real CRDT/RLS/Expo/WASM candidate, but reviewed license restricts replacing its network layer even for OSS; database self-host quickstart still uses CloudSync. Poor first fit for independently replaceable transport. |
| Jazz Classic | Existing encrypted groups/native support remain relevant, but no long-term support guarantee established. Classic is not proved abandoned; do not select it merely because its mature features are missing from actively developed Jazz2. |

## Tachyon and the Matrix correction

The user's [Tachyon archive](https://github.com/0cwa/tachyon/tree/ebc0e03c26fbd9bb4f3fda3a3aa698e1f2711bc0) studies experimental client-owned room/state and DMLS epoch DAGs tunneled over Matrix to-device transport. It demonstrates useful synthetic encrypted exchanges and removal behavior. It does not supply exact custom Rust source/build provenance, general fork convergence, crash consistency or new-device recovery. Standard Matrix SDK support cannot be projected onto that custom fork.

Matrix can transport application data, but would still leave us the database, outbox, query/materialization and payload lifecycle. Existing database-shaped stacks deserve priority. **Matrix is now a fallback transport candidate; Tachyon is a relevant research reference.** Neither justifies writing our own DMLS or assuming a small adapter solves the integration.

## Fresh current ARK probe

The existing 12-test harness ran against ARK `390a148`, its frozen lockfile, KeyhiveWASM0.4.0-alpha.1 and AutomergeSubduction0.20.1: **8 pass, 4 fail**. The coordinating agent independently reran it with the same result. This uses genuine WASM membership/encryption and the actual JS policy, but directly supplies policy inputs; it is not a current Rust relay network test.

- Protected document creation, basic role checks, owner encryption and outsider denial work in the fixture.
- A tampered signed contact card is admitted at the tested graph API boundary.
- A separate authorized reader learns membership via archive but cannot decrypt the fixture's payload. Positive onboarding remains unqualified; subsequent read-denial observations cannot establish successful revocation.
- An ungranted forwarding requester is accepted when the supplied author is authorized. This fails our stricter test expectation, but forwarding signed bytes can be an intended policy. It is not proof of forged-author acceptance.
- Legacy zero-padded IDs admit fetch/put. This is namespace admission, not demonstrated protected-recipe decryption.

Current Rust Keyhive source separately contains a signed-revocation fix, and current Subduction source improves durable storage. Those facts do not establish that the published WASM graph includes every Rust fix or that old durability failures are resolved. [Reproduction and raw evidence](../research/distributed-databases/README.md).

## Remaining feasibility worklanes

Do not build twelve demos. Use a shared tiny fixture: two households, three roles, two clients whose online sessions do not overlap, a late device, one list item and one copied recipe. Keep production sharing disabled until a direction is selected and qualified.

| Lane | Small deliverable | Stop or decision condition |
| --- | --- | --- |
| **A Encrypted integration** | Chelonia published-package browser contract with persisted root/event/outbox state; reader/editor/admin policy, expiring/revoked invitation, queue offline actions then server-order removal/key redistribution on reconnect; smallest Expo import/foreground call | Stop if normal offline restart or role separation requires a new group-key protocol/full framework port. Existing contract policy and storage adapters are legitimate bounded work. |
| **B Offline-authority challenger** | p2panda pinned current-main native two-space/Automerge fixture; browser/network and mobile bridge feasibility; observe cross-space metadata and concurrent removal | Stop before porting an entire networking stack or fixing security semantics ourselves. Decide whether current source gaps are acceptable to wait for or bounded upstream contributions. |
| **C Practical baseline** | PowerSync/Postgres official SDK with membership-filtered downloads plus authorized uploads, persistent queue/rejection recovery, hard restart and portable SQL/domain export | Conditional trusted-host comparison, not production adoption. Use Pouch/Couch instead if permissive independent service ownership dominates. |
| **D Completeness checks** | Short existing-API checks for Evolu read-only/removal and Anyproto browser facade/network route; track fresh ARK failures against upstream fixes | These are explicit source/API gates, not full implementations. Do not spend a bake-off slot repeating a known TODO without a plausible existing path. |

For removal, record the effective server order or causal policy: distinguish legitimate earlier edits from concurrent/post-removal stale edits, and retain rejected work.

Across surviving lanes, run independent concurrent 4/6 edits followed by explicit 5 resolution, item check/delete conflicts, ordered recipe step edits, cross-household access denial, stale token/authority removal, durable service restart and one supported recovery path. Preserve original alternatives and author provenance if the product needs conflict review; never infer Automerge-equivalent history from a SQL API. Browser and available Android x86 execution can proceed; no ARM64 device runner is available, and iOS/native process-death qualification remains explicitly separate.

Choose on total app-owned code, privacy model, native maintenance, semantics, operational ownership, upstream trajectory and exit cost. Stable domain IDs, independent logical exports and original engine archives keep a later switch possible; a replacement engine starts a new replication epoch rather than pretending old CRDT history translates losslessly. Key recovery and data export are separate deliverables.

## Source reviews

- [Encrypted frameworks and group lifecycle](../research/distributed-databases/encrypted-frameworks.md)
- [Database-native and Anyproto DXOS NextGraph review](../research/distributed-databases/native-databases.md)
- [SQL and document sync databases](../research/distributed-databases/web-databases.md)
- [CRDT database ecosystems](../research/distributed-databases/crdt-databases.md)
- [Capabilities and current Keyhive ARK](../research/distributed-databases/capabilities.md)
- [Current Jazz2 implementation and release distinctions](../research/distributed-databases/jazz2.md)
- [Independent Atomic Data implementation review](../research/distributed-databases/atomic-data.md)
- [Tachyon supplemental databases and policy engines](../research/distributed-databases/supplemental-systems.md)

This revision changes research priority and records a fresh bounded probe. It introduces no application dependency, production key protocol, service, migration or deployment.
