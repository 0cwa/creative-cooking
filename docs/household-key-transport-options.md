# Household keys and transport: bounded recommendation

12 October 2026. Automerge is the working CRDT choice; this decision does not depend on its wire format.

## Recommend now

Use a familiar **authenticated HTTPS durable ciphertext mailbox**, with WebSocket notifications as an optional latency improvement and pull/retry as the correctness path. Keep its API independent of Automerge. Clients retain pending updates until a receipt identifies durable stored bytes; a WebSocket send acknowledgement is not durability. Repeated delivery must be idempotent. Store-first/read-after-restart and explicit storage-failure behavior are initial acceptance criteria. Choose and record one operational owner for relay hosting, database backup/restore, monitoring, upgrades, storage quotas and incident handling.

For confidentiality, design for **separate per-device identity keys and per-household group-key epochs**, delivering a household's new keys only to authorized devices. That is a requirements/interface direction, **not approval to ship a homemade AES/signature/envelope protocol**. Select a maintained, reviewed group-security implementation that fits browser + Expo and has a coherent pairing, revocation and recovery story. The current pinned Keyhive/ARK and Spaces stacks remain excluded by the prior evidence. Do not restart their whole bake-off or mistake positive core-crypto tests for a ready product.

Until that key decision is made, finish the local household domain and transport interfaces; keep remote sharing disabled. A hosted ciphertext mailbox is a feasible direction, not yet a qualified service.

## Choices and tradeoffs

| Option | Benefit | Remaining cost / disposition |
| --- | --- | --- |
| HTTPS durable mailbox + optional WS | Standard web/Expo networking; simple operational owner; offline devices fetch later; independent of CRDT | Must implement authenticated ACL, durable receipt and retry contracts, ciphertext security, quota/fault/backup tests. **Preferred transport direction**. |
| Subduction | Prior browser + iOS transport interop is positive | Preview dependencies, native bridge maintenance, authorization failures in evaluated stack and sync-success update-loss evidence. **Park**. |
| p2panda/Iroh | Native peer transport and group ciphertext demonstrated | Browser gateway/mobile bridge burden; no qualified Expo iOS group stack, no proven ACL ingress; peer relay alone is not offline durable storage. **Park**. |
| Device identities + wrapped household epoch keys | Directly expresses small household sharing and independent groups; transport replaceable | Full invitation/key-verification/admin-ordering/revocation/recovery protocol must be supplied by maintained reviewed implementation. A primitive library alone does not provide it. **Architecture direction only**. |
| Maintained complete encrypted group stack | Reduces custom security-protocol ownership when pairing/recovery/ACL are included | Must qualify exact browser/Expo implementation, licensing, dependency graph, maintenance and operational fit. **Next narrow key-selection gate**. |
| Account ACL + TLS only | Fastest familiar service implementation | Operator can read recipes, lists and allergy profiles; this changes the privacy promise. **Only an explicit user-selected alternative**, not hidden fallback. |

Candidates for a narrow library discovery are maintained MLS implementations and established encrypted-room SDKs such as Matrix's ecosystem. These are **unqualified leads**, not interchangeable drop-ins: MLS does not by itself supply identity, account authorization or backups; an encrypted-room SDK may impose its own server, sync protocol and native bindings. Verify exact library, maintained platform adapters and security review scope before selecting. Do not widen this into another exhaustive survey.

## Scope and membership

One person/device may join multiple households. Each household has a separate key namespace, member/device authorization, shopping-list documents and shared recipe namespace. Private recipes, chat history, API credentials and individual health/preferences remain in personal documents and must not be swept into a household sync manifest. Explicitly copying a selected recipe into another household creates a new independently owned document with provenance; later edits and deletion do not silently propagate back. Live cross-household sharing, if later desired, needs a separately authorized share group rather than reusing either household's key.

Document permissions belong outside editable Automerge content. A title or user-editable `householdId` must not grant access or route private data. The transport accepts a narrowly allowlisted authenticated envelope with no plaintext document fields. The client checks trusted membership, author, protocol version and key epoch before import. Relay account authentication and end-to-end author verification are distinct concerns. Admin actions need an ordered policy authority/consensus model; “last write wins” membership changes are insufficient.

Revoking a device denies future epoch keys and future uploads/fetches. It cannot erase content already downloaded or keys already retained. Clients offline at revocation require a policy freshness rule before upload. Removed-member writes created offline must be handled explicitly: reject or quarantine them, rather than falsely promising seamless merging across a security boundary. Granting read-only access protects the relay's write path; if that member holds the shared decryption key, the client must also verify an allowed author signature before applying received changes.

Allergies and requirements belong to the household they constrain; optional individual profiles need consent and separate sharing. Support provenance, severity, hard exclusions versus preferences, and explicit unknowns. Recipe tagging is not proof of allergen safety; warnings must not silently disappear on merge. Only share the minimum household dietary data needed for household cooking.

## Identity custody and recovery

- Local/offline use needs no account. Sync can later link devices to an account using a standard maintained auth provider; account names are not cryptographic identities. Multiple device keys permit selective lost-device removal.
- PWA nonextractable WebCrypto keys in IndexedDB can reduce raw-key export, but same-origin injected code can still use them. Browser storage can be evicted or cleared. A web vault is not equivalent to an OS hardware keystore; XSS controls and tested recovery matter. Any passphrase vault requires a reviewed KDF/envelope format; do not improvise one.
- On native, use a vetted platform key-storage adapter. Expo SecureStore is useful for a small wrapping credential/key, not storing an entire large household-key history or backup archive. Store encrypted larger records elsewhere. Verify actual native library/key availability rather than assuming browser WebCrypto APIs exist in Expo.
- Adding a device needs a verifiable invitation, bounded expiration, authenticated joiner identity and device binding. A QR/code should authenticate the key/household, not merely deliver an unverified HTTP invitation. No account-only reset should secretly give the server old decryption keys.
- Choose recovery deliberately: approval from another enrolled device, or a user-controlled encrypted recovery package. A server account password reset restores the account, not automatically lost E2EE history. If all keys and recovery material are lost, protected history is lost. Historical epoch keys must be backed up if historical data should be restorable.
- Relay admins still see relationship and traffic metadata. E2EE does not supply availability, ciphertext retention/backups, secure device operation or protection from a compromised client. Keep plaintext and keys out of application logs, relay logs, analytics and crash reports.

## Small completed proof and the next gate

`spikes/household-security-options` contains five passing Node/WebCrypto tests with genuine signed ciphertext and a local synced-file mailbox. It proves the feasibility of separating byte storage, routing/membership checks, client decryption and epoch rotation. Its README gives exact limits. No durable native identity, invitations, distributed ACL, group-key envelopes, native/browser runtime, live server or production protocol is claimed.

The next spike should be **one exact maintained key implementation and one exact durable mailbox implementation**, not full features. First confirm browser + Expo platform bindings and maintenance/review status; fail fast if absent. Then use two devices and two households to prove verified invite/decrypt, independent group keys, server unable to decrypt, reader/writer limits, lost-device removal, offline stale-epoch rejection, stored-history access versus future-key denial, restart and one recovery path. Assert all negative cases alongside positive sharing. Mailbox must retain client pending updates on denied/storage-full responses and pass replay, crash/reopen and database restore checks. Native execution remains a gate even with no hardware runner; report unrun tests honestly.

Decisions for the user before adopting remote sharing: accept the hosted-mailbox operational model; confirm E2EE privacy goal versus explicit TLS/account-only alternative; choose recovery expectations (another device and/or encrypted recovery package), and who owns the server. Group-library selection is still an engineering qualification result, not a choice the user should make from names alone.
