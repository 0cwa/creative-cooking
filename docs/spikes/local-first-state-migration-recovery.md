# Engine-neutral state migration, history and recovery feasibility

> **DRAFT / DO NOT MERGE / research only.** Related to [issue #36](https://github.com/0cwa/creative-cooking/issues/36). Branch began from main a1c8993c4f45e9bb8de2b18d4f644088df99845a. Owned paths are this report, spikes/state-migration-recovery/** and the one isolated experimental workflow. No production AppState, storage, credentials, backups, screens, deployment or CI changes. No winning CRDT or production integration is proposed.

## Sources and existing invariants

Read-only inspected: [domain types](../../src/domain/types.ts), [AppState](../../src/state/AppState.tsx), [v1 backup parser and serializer](../../src/storage/backupFormat.ts), [IndexedDB adapter](../../src/storage/appStorage.web.ts), native AsyncStorage, [credential vault](../../src/storage/credentialVault.ts), domain defaults, recipes and conversations; [Automerge #37](https://github.com/0cwa/creative-cooking/pull/37), [Loro #38](https://github.com/0cwa/creative-cooking/pull/38), [Merge Analyzer #41](https://github.com/0cwa/creative-cooking/pull/41) and [binary composability #43](https://github.com/0cwa/creative-cooking/pull/43).

Production currently stores ordinary state under creative-cooking-state-v1 in IndexedDB on web (with idempotent prior localStorage migration) and AsyncStorage on native. Provider keys live separately in SecureStore on native / browser-local storage on web. Ordinary portable JSON is format creative-cooking-backup, version 1, and has a state field. The experiment **imports the real production parser and serializer as read-only**. It never changes that format. The UI must always work offline without an account; pantry inventory is optional simplicity: a name and 1–5 preference suffice; recipe scaling requires structured ingredients, portions and ordered steps.

## Field-by-field candidate sharing policy

These classifications are **proposed**, not product decisions. The default is private, explicit household sharing is per selected entity ID, and all undecided/unknown fields fail closed. Namespace labels by themselves do NOT enforce cryptographic authorization.

| Current domain/state field | Proposed classification | Candidate projection/limitation |
| --- | --- | --- |
| PersistedState.pantry[]; PantryItem.id, name, preference, createdAt, updatedAt | **Personal/private; explicitly shareable** individually | Stable entity identity independent of ingredient spelling, preserving separate preferences for duplicate names. Timestamps describe edits but are not conflict clocks. No mandatory quantity, expiry or tags. |
| PersistedState.recipes[]; Recipe.id, title, description, portions, createdAt, updatedAt | **Personal/private; explicitly shareable** individually | Structured recipe retained without forcing UI to expose the schema. |
| Recipe.ingredients[]; RecipeIngredient.name, optional amount | **Personal/private; explicitly shareable** with selected recipe | Stable v2 ingredient IDs and separate order; plain text or optional amount still valid; existing scaler/parser is unchanged. |
| RecipeIngredient.needsShopping | **Context-dependent; not yet safe to replicate** | Local shopping/pantry overlay; deliberately omitted in candidate v2. Legacy v1 backup still owns the original field. |
| Recipe.steps[] | **Personal/private; explicitly shareable** with selected recipe | Stable v2 step IDs and separate movable step order; concurrent move + content edit must both survive. |
| Recipe.notes[] | **Personal/private; not household shared by default** | Kept only in personal document; sharing notes needs separate consent. |
| PersistedState.chatMessages[]; ChatMessage.id, role, content, createdAt | **Personal/private** | Stable live conversation and message IDs; never shared with household by recipe/pantry selection. Free text may contain credentials and must be guarded. |
| ChatMessage.proposals[]; ChefToolProposal.id, toolName, arguments, status | **Context-dependent; unsafe by default** | OMIT: arbitrary action/JSON payload and pending/applied execution semantics are not safe to sync. Preserve in original v1 data, not replicated. |
| PersistedState.chatHistory[]; ChatConversation.id, title, messages, createdAt, updatedAt | **Personal/private** | Stable conversation and message identity/order, personal only. |
| PersistedState.activeConversationId | **Personal/private** | Refers only to personal conversation, never household. |
| PersistedState.mealContext.willingToShop, portions, cooks[] | **Personal/private session context** | No cross-user assumption about shopping, cooks or energy. Local overlay, not candidate v2. |
| settings.systemPrompt | **Personal/private and possibly secret** | Not in replicated document. |
| settings.allergies[] | **Sensitive personal/private** | Never copied into generic household recipe space; safety policy needs separate consent/UX. |
| settings.city, sendLocalTime | **Personal/private context** | Location and provider time disclosure remain local. |
| settings.providerId, model, dictationEngine | **Device-only configuration** | Providers, models, dictation capability depend on device, not household facts. |
| Provider API keys, OpenRouter bearer/share links, OAuth tokens | **Device-only credential** | Remain in separate vault and outside all replicated documents/envelopes/portable v2 history. |
| Device signing private keys and household group secret keys | **Device-only credential** | NEVER ordinary cooking-data backup. Only non-secret epoch/reference allowed; separately protected pairing/recovery required. |
| UiQuestion and runtime hydration/storage error states | **Ephemeral / device-only** | Not persisted domain data, not synced. |
| Any unknown root/nested fields, future optional metadata or new engine roots | **Context undecided: fail closed** | Strict typed field allowlist; explicitly build new schema version and tests before sharing. |

In particular do **not** replicate the whole existing PersistedState or blindly spread v1 JSON into a CRDT. The existing v1 serializer copies its state argument, and its settings parser spreads unknown settings fields for local compatibility. An intentional **negative control** injects synthetic credentials into a polluted v1 state and confirms its unmodified exporter includes those injected strings. This is an important limitation; it does NOT mean ordinary production keys are currently in state (the vault is separate). The candidate replicated projection deliberately excludes the injected fields. Pattern-based scanning cannot guarantee that all secrets hidden in arbitrary allowed free text are detected.

## Versioned candidate logical document

Each personal or household document has schemaVersion 2, an opaque space identity, deterministic namespace-qualified document ID, stable pantry/recipe/conversation maps, private activeConversationId, and migration receipts. Recipes hold ingredientsById / ingredientOrder and stepsById / stepOrder. Conversations hold messagesById / messageOrder. All entities have explicit deleted tombstones: concurrent delete/edit retains the edited object and deleted intention; the app-view hides tombstones without erasing history. Explicit household import requires confirmed lists of original pantry and recipe IDs. Household chat, personal meal context, settings and private notes are omitted.

Legacy IDs are hashed separately per entity type; display name is never an identity. Legacy v1 ingredients/steps have no IDs, so the first import assigns IDs using their parent recipe ID and original array position. Future CRDT moves preserve those identities. Another changed v1 backup cannot safely infer row matching after reorder; the importer quarantines collisions with existing v2 IDs rather than overwriting newer edits. Chat message order is preserved from the source arrays, rather than sorting by generated IDs. Message IDs are scoped to their containing stable conversation identity before being used as CRDT container names, so reused legacy message IDs in different conversations cannot alias. If an archived conversation and live conversation reuse a legacy ID, their divergent contents receive separate stable identities and the active reference is derived from the explicitly appended live record, not ambiguous legacy ID equality. Two same-name pantry items with different IDs/preferences are kept separate. Equal legacy ID+equal content duplicates are coalesced with explicit diagnostics; same ID+different contents receive deterministic collision identities; anonymous rows are given deterministic occurrence identities with documented weaker stability.

Receipts ignore v1 exportedAt, and hash **only the allowlisted candidate document for that space**, not original credential fields or unrelated private backup contents. Repeated import of identical projected content is a no-op. Changed legacy content sharing existing entity IDs is quarantined as potential lost update; it is not an LWW authorization to overwrite a replicated record.

**Known v2 gaps:** legacy pantry/recipe presentation ordering, shopping checkbox overlay, pending Chef proposals, migration of mutable live-chat versus archived states, bulk v1 reorder detection and forward schema transformation need a product choice and future implementation. This is a feasibility schema rather than a lossless production converter. The original v1 state and JSON backups remain the recovery fallback.

## Executable real binary harness and evidence artifacts

From repository root run:

~~~sh
cd spikes/state-migration-recovery
npm ci --no-audit --no-fund
npm run typecheck
npm test
~~~

[Isolated workflow](../../.github/workflows/state-migration-recovery-spike.yml) pins Node 22.13.0, Automerge JS 3.5.0, Loro JS 1.16.4, TypeScript 6.0.3; root app dependency/CI remains untouched. Both engines use **real exported/imported binary snapshots and incremental changes**, not fabricated merge results:

- Automerge: init, change, clone, merge, getConflicts, getChanges, applyChanges, save/load.
- Loro: setPeerId, fork, root maps and movable lists, move, commit, update/snapshot export, import, public retained operation history and causal frontier comparison.
- Product cases: deterministic v1 import, same/different backup IDs, duplicate names/preferences, concurrent compatible recipe properties, conflicting 4 vs 6 portions, conflicting title, causal 5 resolution, recipe step move plus distinct text edit, delete-vs-edit tombstone, repeated binary import, restart, private/household selection, wrong-space replay and injected rogue CRDT fields.
- Storage cases: staged durable WAL, acknowledgment loss, independent review checkpoint, full-history snapshots, interruptions, device loss, partial files, wrong schema/namespace and missing group key metadata.
- Safety cases: synthetic provider/OAuth/signing/group-key/unknown-field sentinels in deliberately polluted v1 state, strict allowlist and real engine binary, portable history backup, filesystem, app view, simulated network envelopes; expected detection in polluted original v1 backup is separate from zero-marker candidate output scans.

Machine JSON is generated by each test run (not hand-written verdicts) to spikes/state-migration-recovery/artifacts/ and uploaded by Actions even on failure:

| File | Evidence |
| --- | --- |
| scenario-results.json | Per-engine and policy PASS/FAIL, durations, real alternative operation IDs, binary and view assertions |
| migration-results.json | Source v1 identities/receipts, omitted field paths, deterministic/idempotent/quarantined imports |
| recovery-results.json | Failure stage behavior, cold device recovery, review-checkpoint digest validation and rollback consequences |
| activity-evidence.json | Real Automerge/Loro change-header activity with source identities, replay idempotency and restart parity |
| leak-scan-results.json | Known synthetic marker scan across v1 negative control, binary snapshots, filesystem, frames and portable bundle |
| storage-invariants.json | Proposed fail-closed storage/retention invariants and honest unproven properties |

The proposed [TypeScript backend contract](../../spikes/state-migration-recovery/contract.ts) exposes open/getView, validated mutations, pendingUpdates/receive, reviewEvents, checkpoint, restore and importLegacyV1 behind an engine-neutral facade. No new mandatory pantry fields enter the screens. Provider keys/LLM adapter preferences remain local-only.

## Durable storage and interrupted writes

The Node DiskStore is an **executable reference state machine, not IndexedDB or AsyncStorage code**. It writes a real engine binary seed to a content-addressed file, flushes it and atomically activates the manifest *last*. Each actual binary update has an engine/space/doc/version/digest envelope; a cloned engine preflight checks the incoming schema allowlist, before durable write. Adversarial unknown-field binary updates are rejected **before** WAL admission, and tests assert the rejected WAL remains empty. An immutable WAL record contains the actual bytes plus integrity-checked envelope metadata, is fsynced and atomically renamed before logical import and acknowledgment. Restart loads real binary document history, reapplies WAL idempotently and validates the resulting projection. SHA-256 detects accidental corruption; it is **not message authentication**.

Failure injections for **each** engine:

1. Before update persistence: no update or acknowledgment; sender retries.
2. After durable update bytes, before authoritative import: cold restart finds WAL and recovers.
3. After import, before acknowledgment: retry is idempotent.
4. After review checkpoint, before acknowledgment: checkpoint remains durable and not automatically resolved.
5. During migration before atomic activation: orphan binary bytes never become active until safe retry.
6. During restore before activation: partial target does not become an active document.

Unresolved disagreements must be independently checkpointed with original values/source frontier **before** any destructive compaction, and checkpoint durability verified before marking a review resolved. The reference always refuses destructive pruning (including if unresolved) because it has not qualified a safe engine/platform compactor. Ordinary full-history snapshots are allowed. #41 proved Loro shallow compaction can erase losing alternatives; disappearance of a conflict after pruning is *never* consent or causal resolution. Device-local dismissals must not silently propagate to others.

## Portable recovery, rollback and key boundaries

A **research-only**, nonproduction v2 history bundle includes version, space/doc identity, actual full binary engine history with digest, actual update frames, derived app view, durable review checkpoint and non-secret key epoch reference. Tests restore on a separate simulated device and reject truncated/tampered snapshots, wrong space/engine, future schema and partial activation. A household key requirement is enforced from namespace policy and **cannot be downgraded by untrusted backup metadata**. Missing group keys block recovery, requiring separately protected key retrieval or re-pair. This fixture has **no live E2EE at all**: a Boolean representing group-key availability does not decrypt anything and proves no authorization, revocation or authentication.

The existing **v1 JSON backup stays recoverable** using its original parser and exporter. Rolling back rich v2 state to a v1 app view loses CRDT causality, conflicting alternatives, tombstones, review history and stable ingredient/step IDs. Keep a separate protected binary sidecar rather than deleting it after a v1 restore. Actual device-loss UX, merge checkpoint atomicity on Android/iOS/Web, key recovery and rollback safety remain product/platform hard gates.

## Explicit nonclaims / remaining verification

Node/WASM engine binary behavior does not prove Expo iOS/Android parity, native binding ABI/version support or live browser-to-native interoperability. A POSIX/fsync/rename reference does not prove IndexedDB transaction semantics, browser quota handling, native SQLite/AsyncStorage durability or power-loss behavior. Synthetic scans do not prove absence of arbitrary embedded credentials or encrypted transport. Namespace tags/digests do not protect traffic against malicious peers: real authenticated device identities, E2EE/ACLs, replay protection, role delegation, revocation and secure key recovery remain **UNPROVEN**. Other draft PRs are read-only evidence, not merged dependencies.

**Completion gate:** use actual GitHub Actions job status and downloadable machine JSON before claiming PASS; confirm separate normal app CI green. Do not merge this research, change production formats or choose an engine in this worklane.
