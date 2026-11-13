# Content sync, recovery, and support limits

PowerSync is the app's provisional content engine. Domain commands and the account/workspace subscription seam live in `src/content/`; there is no interchangeable engine adapter. A local-only install remains usable without an account or service URL. Account and shared-workspace content is saved in a profile-scoped PowerSync database. A local database commit means **saved on this device**; the app reports synced only after the service confirms the upload/download queue and there are no pending mutations or recovery issues.

## Where data lives

- Pantry, recipes, shopping lists, purchase cycles, and purchase ledgers belong to the selected personal or household workspace.
- Chats and proposals, allergies, system prompt, city, and meal context belong to the account's personal workspace, even while a household is selected.
- Provider/model selection, dictation engine, local-time preference, active conversation selection, provider credentials, model caches, API URL, PowerSync Service URL, and session material remain device-local. Provider credentials are excluded from sync operations and backups.
- Web content uses PowerSync Web 2.7 with IndexedDB and `IDBBatchAtomicVFS`. Native content uses PowerSync React Native 2.4.1 with `op-sqlite` 18.2.5. Web account sessions use IndexedDB; native sessions use Expo SecureStore. API and Service URLs use device settings storage.

The API uses cross-origin bearer requests without cookies. Current membership is checked by the server for every content mutation and Service stream; cached offline workspace choices do not grant authority. The backend is server-readable; end-to-end encryption is not implemented.

## Edits, adoption, and recovery

Content commands are written with their outbox record in the same local transaction. Retries keep the mutation identity and body. Shopping purchases use stable purchase identities and cycle identities; replaying an accepted purchase does not repeat its pantry effect, and an old-cycle check is rejected. Historical purchase imports retain ordered `itemIds` and `pantryItemIds` snapshots even when live rows are absent. History imports do not replay pantry effects.

Guest adoption keeps a source archive and an incomplete receipt until every local and server batch, including shopping history, is accepted. Account switching and sign-out preserve account databases and archives. Membership removal preserves pending work for export, but an old session cannot write until current membership is confirmed again. A new invitation restores rows the server still authorizes; old pending edits are not silently resubmitted.

The workspace recovery export includes current workspace state, pending and blocked outbox rows, unresolved issues, conflicts, archives, and Chef proposal-action links. Export it before clearing browser data or leaving a device when changes need recovery. A mutation that received an ambiguous response is retried only with its exact stable body. Do not infer server acceptance from the local UI alone.

If a browser write is interrupted, the UI may remain at **Saving locally** rather than show a terminal failure. An injected IndexedDB transaction failure was verified to remain unsaved, appear in the backup export, disappear after reload, and persist after an explicit retry. Browser quota eviction and exhaustion remain browser-dependent; the tested Chromium quota override changed `navigator.storage.estimate()` but did not enforce a write limit for this VFS.

## Web schema and updates

PowerSync local schema **V1** is the first app `AppSchema` baseline, introduced by `21f6345` (`Integrate transactional PowerSync content workspaces`). No earlier app PowerSync schema exists to migrate. An additive V1-to-V2 fixture upgrade using the real PowerSync Web SDK reopened the same IndexedDB database and preserved pending outbox, guest archive, ordered purchase history snapshots, personal conversation/message, and Chef action rows while adding a table. Destructive rename/removal/data-conversion migrations have not been proven; treat schema changes as additive until an explicit migration and populated-database test exists.

The PWA worker is scoped to `/creative-cooking/`, caches the shell and visited same-origin assets, uses network-first navigation, and activates with `skipWaiting()`/`clients.claim()`. The previous and current built PWA entries were loaded in one browser profile with populated records and an unsent outbox edit; all exported rows survived the switch. The worker file was byte-identical in both builds (`creative-cooking-v1`), so this verifies the app-bundle update under the current worker, not replacement of one worker script by another.

Web multi-tab PowerSync is disabled (`enableMultiTabs: false`). Cross-tab editing and coordination are unsupported and have not been tested. Use one active app tab per browser profile; separate browser contexts in acceptance tests have separate storage.

## Local setup

For local-only cooking, run the app without configuring an account API or PowerSync Service URL. For account and household sync, use the pinned local PostgreSQL/API/PowerSync setup and environment instructions in [`server/README.md`](../server/README.md). Build the GitHub Pages PWA with:

```sh
EXPO_PUBLIC_BASE_URL=/creative-cooking npm run build:web
```

The account API and PowerSync Service URLs are configured separately in Settings. Do not use production credentials or endpoints for local fixtures.

## Native verification limits

The full Expo app root has not been launched on an emulator/device in the integrated client session. Native AsyncStorage-to-PowerSync migration, full-root persistence, SecureStore session restoration, and native household transfer remain unverified. An isolated Android x86 PowerSync runtime fixture passed, but it does not prove the full app root. ARM Android and iOS have not been tested. Agent device access was disabled in the prior session; enable **Settings → Integrations → Devices** and start a new session before the native acceptance run.
