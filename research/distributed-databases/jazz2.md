# Current Jazz 2 reassessment — 15 October 2026

**Jazz 2 deserves a bounded integrated-database feasibility lane. Do not reject it because it is alpha, and do not substitute Classic Jazz's E2EE capabilities for Jazz 2's.** It is actively developed and has substantially more React Native implementation than its stale top-level scaffold warning suggests. Its current documented group permissions are server-enforced relational ACLs, while new main-branch crypto adapters explicitly do not yet supply encrypted table writes or group-key lifecycle. Therefore it is a credible contender if a trusted database host is acceptable; it is not established as an integrated host-blind household-sync stack.

This review is read-only primary-source inspection, not an independently executed Jazz security or runtime experiment. No code, public issue, PR, deployment or production dependency was changed.

## Provenance and release boundary

- Repository inspected at main **`8ce3c39628757eb82917a822838422b007a65d4f`**, commit timestamp 14 October 17:00 Pacific / 15 October UTC. The active repository identifies itself as Jazz 2 with an entirely new API. [Pinned source](https://github.com/garden-co/jazz/tree/8ce3c39628757eb82917a822838422b007a65d4f).
- Latest ordinary release returned by GitHub releases is [**v2.0.0-alpha.59**, 4 October](https://github.com/garden-co/jazz/releases/tag/v2.0.0-alpha.59); alpha.58 is 30 September. Release notes show actual native, permission, transaction and persistence work. This supports active development, not an abandonment inference.
- New standalone `src/e2ee` adapters and `E2EE_CRYPTO_FORMAT.md` exist at inspected main but **are absent from the alpha.59 Git tree**. Do not attribute them to the published alpha release.
- Classic has separate documentation and different architecture. Nothing inspected establishes that Classic is abandoned, nor that its permission/E2EE model applies to Jazz 2. The user's preference for an actively developed alpha is compatible with shortlisting current Jazz 2.

## Capability assessment

| Area | Implemented/source evidence | What remains unproved for Creative Cooking |
| --- | --- | --- |
| Local-first relational database | Schema/table/query APIs, persistent browser driver, offline optimistic edits, sync and authoritative server settlement; alpha.59 fixes pending writes and exclusive transaction replay across restart | Real app fixture, complete offline web/PWA restart behavior and chosen native runtime; adapter migration cost |
| Accountless identity | A local 32-byte root derives Ed25519 self-signed identity and deterministic app-scoped account; create/restore local-first account; server validates signature/audience/subject | Device enrollment UX, key custody, loss/recovery and identity-revocation policy under app threat model |
| Recovery | 24-word BIP39 encoding of signing root; same root restores identity/account; Expo SecureStore adapter and recovery tests exist | Recovery of data requires retained local/server data; recovery of a signing identity is not recovery of absent database bytes or future E2EE group keys |
| Group permissions | Real workspace/member relational recipe, reader/writer/contributor/admin roles, explicit allowRead/Insert/Update/Delete; omitted grants deny server access | This is host-enforced ACL, not host-blind cryptographic group authorization. Revoked clients may retain previously obtained data. Need one adversarial role/reconnect smoke |
| E2EE crypto building blocks | On unreleased main: context-bound cell encryption, envelopes, signatures, equality tokens, streaming cipher, browser/libsodium and native Node/NAPI adapters; cross-implementation vectors and rejection-test source | Encrypted table integration, group invitations, epoch/key lifecycle, device key distribution/revocation/recovery, authenticated persisted household workflow and independent audit |
| Expo/RN | Current and alpha.59 native README describe JSI/C ABI persistent SQLite route, account-handle client, New Architecture autolinking and device acceptance workflow sources | Exact published artifacts must execute on app's Expo version. Expo Go unsupported. Two physical JSI-runtime communication receipt explicitly pending; one-process aliases and Node bridge tests are not multi-device qualification |

### E2EE: crucial distinction

The [pinned crypto spec](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/crates/jazz/SPEC/E2EE_CRYPTO_FORMAT.md) says:

> “Table writes and lifecycle records are not part of this layer.”

and:

> “Persistent application writes require separate key lifecycle and table integration; neither is supplied by these adapters.”

These are explicit source limitations, not a speculative concern based on the alpha label. The source contains concrete crypto implementations and tests, so describing all E2EE work as merely planned would also be wrong. The integration needed by this app is missing/unqualified. The `native` crypto factory imports `node:module` and `jazz-napi`: **native here means Node/NAPI, not evidence of Expo/Hermes E2EE**. [Pinned factory](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/packages/jazz-tools/src/e2ee/native.ts).

The group recipe is an ordinary permissioned workspace database. [Pinned implementation](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/examples/docs/todo-client-localfirst-react/src/group-permissions-snippets.tsx) and [permission docs](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/docs/content/docs/auth/permissions.mdx) explicitly state server-side checks and filtered reads. It provides a useful integrated role model if the server is trusted. It does not demonstrate that a server lacks recipe decryption keys. The authorization spec still lists encrypted columns and key-loss/revocation interactions as an open integration question.

### Identity, recovery and offline semantics

[Local-first identity internals](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/docs/content/docs/reference/local-first-auth-internals.mdx) specify self-signed JWT identity and permanent identity→account registry assignments; linking an external provider needs two proofs and cannot merge already assigned accounts. External login/linking needs the core; local-first account creation does not. A recovery phrase gives its possessor authority as that identity. Logout does not erase local database/signing roots or revoke identity at core. [Lifecycle](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/docs/content/docs/auth/lifecycle.mdx).

Offline writes are optimistic until server authority accepts/rejects them. Group-membership revocation therefore requires testing stale offline edits and reconnection; a locally displayed successful edit is not proof of accepted server authorization. Alpha.58 notes a revoked-invite exclusive-transaction compatibility hazard with older clients, addressed by coordinated upgrade guidance; alpha.59 improves exclusive replay after restart. Version pinning and upgrade semantics matter more than a generic alpha warning.

## Expo: correct the previous rejection, preserve validation boundaries

The top-level README still calls Expo a scaffold without persistent runtime. The more specific [native README](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/crates/jazz-rn/README.md), [installation docs](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/docs/content/docs/install/client.mdx), real native source and published alpha.59 release notes supersede a blanket scaffold-only claim. Alpha.59 explicitly fixes foreground ticks during native reconnection; alpha.58 changes the native ABI, requiring a new binary rather than JavaScript-only OTA.

Use exact matched `jazz-tools`, `jazz-rn` and platform payloads, New Architecture, Expo config plugin, prebuild and a native development/release binary. Expo Go cannot load it. Source/package/prebuild checks do not equal a device run. The RN Node harness calls the genuine C ABI through a bridge but expressly does not prove mobile installation. Upstream describes Android-emulator/iOS-simulator installed-device receipts, but I have not independently downloaded their run artifacts or qualified current published payloads on Creative Cooking's Expo version.

There are stale implementation-ledger/ABI statements even inside current native docs, so source/release-specific evidence must decide. Do not commission a full bridge port before one matched-version foreground/restart smoke.

## Fit, reversibility and minimum bake-off

Jazz 2 is an integrated database/auth/ACL/sync candidate, not simply another byte transport under Automerge or Loro. It could remove custom assembly work if its trust model and app-facing history semantics fit. Its core orders/settles writes, plain authored cells merge by accepted sequence and immutable history is retained; do not infer Automerge-equivalent conflict-alternative APIs. [History/merge spec](https://github.com/garden-co/jazz/blob/8ce3c39628757eb82917a822838422b007a65d4f/crates/jazz/SPEC/4_history_merging.md). Demonstrate two offline 4/6 edits, retained alternatives/provenance, explicit 5 resolution and delete/edit/order behavior rather than translating CRDT assumptions into SQL-shaped API claims.

Recommended bounded lane, **if trusted hosting is an acceptable candidate**:

1. Pin alpha.59 (or one deliberately chosen newer published release) and matched native payloads. Implement only pantry + one recipe with stable ingredient/step IDs, private conversation exclusion and portable logical export. Keep existing production app untouched.
2. Browser + Android x86 emulator: offline edit, hard process restart, late catch-up, two-account reader/editor/outside roles, stale offline writer after membership removal. Use the existing no-ARM-runner constraint; stop if published x86/native payload unavailable rather than building a platform port. One iOS simulator run is needed before claiming all-platform adoption.
3. Test disagreeing 4/6 values and preserved history/evidence, then causal/application resolution to 5 and source export. Add one ordered-step move+edit case. Retain original full database/history archive plus independent review ledger; a logical migration to another engine starts a new replication epoch.
4. Measure only initial visible recipe readiness and web asset cost if functionally viable. Alpha.59 release reports 6.4 MB gzipped WASM: this is an upstream release claim, not a measured Creative Cooking app delta, but justifies one actual exported/PWA asset check.

Stop after those gates; no full cooking UI, custom crypto lifecycle, background sync, load campaign or rewrite. If host-blind E2EE is mandatory, **park full Jazz2 household selection now**, keep it on the active roadmap, and reopen when one maintained integrated encrypted-table/group-key path exists. Do not turn these adapters into a home-grown security product merely to obtain a favorable feasibility result.

Overall: strong evidence of active development and a real integrated local-first/ACL platform; source-backed but independently unverified current native support; E2EE components present only on newer main with explicit table/lifecycle gaps. This merits a conditional shortlist and can reverse an earlier scaffold-only exclusion, while preserving the security requirement rather than silently weakening it.
