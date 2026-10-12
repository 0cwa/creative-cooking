# Household development goal and remaining work

Automerge is the working engine choice. The goal is opt-in collaboration on household shopping lists and selected recipes while preserving accountless offline cooking and private personal data. The local foundation builds on the existing Shopping work in [PR #33](https://github.com/0cwa/creative-cooking/pull/33); it does not merge that PR or the research branches.

## Completed in this slice

- Local household creation and switching, one shopping list per household, and a separate personal list. Pantry remains personal; purchasing from a household list can explicitly add those items to personal Pantry.
- Explicit recipe snapshots copied independently into selected households. Source edits/deletion do not propagate, and private notes and shopping flags are excluded. Copies show their ingredients and steps.
- Household allergies and none/vegetarian/vegan requirements. Chef uses the selected household only and combines its allergies with personal allergies locally. Personal allergies are not written into the household. Requirements are disclosed as Chef-request context; diet instructions do not certify ingredient safety.
- Backward-compatible local-state and JSON backup handling, including all household scopes and the underlying personal shopping list even while another household is selected.
- Isolated actual Automerge 3.5.0 repository: stable entity IDs, original conflict alternatives, ordered recipe steps, monotonic deletion tombstones, scoped epochs, trusted external permission boundary, serialized changes and persistence before publication.
- One-time local workspace bootstrap and same-scope snapshot projection, retaining personal metadata in a sidecar. This is an explicit baseline import, not an array-overwrite synchronization loop.
- Binary IndexedDB adapter with transaction-complete writes and real browser reload verification; Node tests cover engine snapshot/reload, actor identity, convergence and rejected ingress.

The app currently saves local household arrays through its ordinary local storage. The Automerge package is **not yet imported into the production Expo runtime**, and there are no remote invitations, accounts, network synchronization or new cryptographic dependencies. The UI says “On this device.”

## Next worklanes in dependency order

| Lane | Remaining concrete work | Done when |
| --- | --- | --- |
| Local engine adoption | Route household domain commands through the engine adapter; store binary history and review evidence; create a durable outbox alongside committed changes; preserve existing JSON recovery as a view export. | Web add/check/remove/copy edits survive restart and transport failure without lost outbox changes or history. No personal scope enters household payloads. |
| Keys and transport decision | Select one maintained group-security implementation that fits browser and Expo; qualify an authenticated HTTPS ciphertext mailbox and durable receipts. Current Keyhive/ARK/Spaces/Subduction shipping paths remain parked. | Exact pinned implementation proves verified device invitation, two households, read/write/admin authority, future-key revocation, stale offline writer handling and one recovery path. See the separate key/transport recommendation. |
| Native Automerge | Diagnose the Android release-launch timeout; qualify actual Expo/Hermes calls and real process death/relaunch; build the small Expo iOS Swift bridge. | Actual binary exchange and conflict/order/restart evidence comes from required runtimes, not compilation or in-memory handle reload. No ARM64 device runner is available currently. |
| Household sharing integration | Connect authenticated ciphertext transport to the outbox/import boundary; explicit household joins, reader/editor/admin roles, reconnect, leave/remove and selected recipe copies. | Two devices edit offline and converge later through durable storage; outsiders and removed devices fail negative tests; local cooking stays available without service access. |
| Recovery and release | Encrypted key recovery plus scoped full-history backups; schema/epoch migration and late old-peer policy; installed-PWA WASM cache upgrades; native key custody; real crash/storage-full recovery and operational owner. | Device-loss restore and removal work on supported platforms; the documentation accurately describes what a removed member can retain. |

Remote keys and transport are a decision gate requested by the user. Continue local engine work independently, but do not enable household network sharing before the user chooses the recommended direction and that exact implementation passes its tests. Replicated membership fields must never become permission authority; Automerge actor IDs are not authenticated identities.

## Product priorities

Keep shopping immediate and simple: short item names, checkoff, visible household scope and retained deletion evidence. Resolve ordinary compatible merges quietly; expose genuine conflicting edits when useful. Let a person participate in multiple households without silently combining lists or copying personal chats. An optionally combined errands view can come later and must keep each item's household and route edits back to that scope.

Next likely needs are invitation/recovery, changing phones, read-only guests, undo/recent removals and explicit recipe refresh. These are hypotheses to validate, not claims of universal demand. Meal calendars, inventory quantities, expiry tracking, budgets, nutrition and shared Pantry remain optional later features. Individual allergy attribution needs consent; anonymous household exclusions are the initial model.

Recipe copies are independent. A genuinely jointly edited list across households needs a separate collaboration space and its own explicit audience, rather than granting either household access to the other's full document. Live cross-household recipe links are likewise a future permission model, not the current copy operation.

## Validation and limits

The application unit/type checks and static PWA export pass locally. Three household browser journeys cover switching, reload, recipe privacy, requirements, creation and backup; the binary storage journey exercises actual IndexedDB. The environment's bundled Chromium 140 could not type even into a blank HTML input; system Chromium 154 executes the journeys normally. Hosted normal CI retains the project's existing pinned test setup.

The engine contract and disposable mailbox proof are separate packages. Tests of cryptographic primitives and a trusted in-memory permission registry do not qualify distributed group security. Full browser crash, native execution, atomic outbox, ongoing app-to-engine command integration and a chosen group-key implementation remain explicit gates. No research server or key protocol is deployed.
