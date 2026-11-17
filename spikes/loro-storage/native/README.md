# Native storage fixture

This isolated Expo app uses `loro-react-native` 1.10.3, op-sqlite 18.2.5, Expo 57.0.17, React Native 0.86.3 and Hermes. Its test data is opaque, unencrypted fixture data. The generated x86_64 archive is a local test build, not a supported ARM release. It derives from the historical runtime spike at `df6bee3fec983c115047627962b28d086a6ed7fe`; the Rust lockfile pins Loro core 1.10.3. The dependency patch script verifies exact source text before changing UniFFI byte conversion, TS6 types, the false-value conversion and the RN 0.86 JNI adapter. The x86 build script adds the ABI and builds the pinned Rust sources. Generated dependencies and Android/build outputs are ignored.

On a host with the installed Android SDK, NDK, Rust Android target, CMake and Ninja, from this directory:

```sh
agent-disk-check
agent-heavy -- node patch-dependencies.mjs
agent-heavy -- node build-native-x86_64.mjs
agent-heavy -- node prebuild.mjs
agent-heavy --mem 8G -- node build-android.mjs
```

`patch-dependencies.mjs` performs `npm ci --prefer-offline`. The defaults use Android SDK `/home/x/Android/Sdk`, NDK 28.0.13004108, and CMake 4.5.0; adjust the environment variables in the scripts for other installations. The app ID is `dev.creativecooking.loro.storagefixture`, and its private SQLite database is `s1-storage-fixture.sqlite`. No existing app data needs clearing. The first run checks atomic commit, four injected transaction failures, discarded working documents, duplicate effects, separate inbound staging, failed and successful imports, and database reopen. It records a completion marker only with the successful import. A process relaunch then checks the saved state and that the failed effect is absent. Existing fixture data makes subsequent launches run the restore check.

A debug build needs a Metro server and an Android device. Use a device-specific agent-device session for launching and inspection, and an ADB reverse port only for connecting Metro. The app output is an assertion report; a launch alone is not a pass. This does not validate production cryptography, a production storage implementation, ARM binaries, or iOS.

A supplemental host test exercises the same scenario against Node's SQLite and `loro-crdt` 1.17.1. Install the parent `spikes/loro-storage` dependencies first, then set a disposable path under task scratch:

```sh
S1_SQLITE_PATH=/path/to/task-scratch/s1.sqlite agent-heavy -- npm run test:node
```

This host test is not evidence of Hermes or op-sqlite behavior. The device fixture must still be inspected on first launch and after `agent-device open dev.creativecooking.loro.storagefixture --relaunch`; `--relaunch` terminates the app process before launch. Use a separate agent-device session and never clear unrelated data.

## Combined Android compatibility and key-catalog candidate

The combined fixture uses native Loro 1.10.3 and libsodium 1.7.0 against Loro 1.17.1 and libsodium-wrappers 0.7.15. The committed browser packet contains public test keys and is not suitable for real data. `compat-generate.mjs` regenerates the public Loro 1.17.1 input. Before starting Metro, copy the current root implementation into ignored fixture directories:

```sh
agent-heavy -- node patch-dependencies.mjs
agent-heavy -- node build-native-x86_64.mjs
agent-heavy -- node prebuild.mjs
agent-heavy -- node prepare-domain.mjs
agent-heavy -- node prepare-root.mjs
agent-heavy --mem 8G -- node build-android.mjs
```

Run `agent-disk-check` before a potentially large build and use the project disk budget. Start Metro and install the APK on a newly reserved isolated Android target. Launch and relaunch through that target's bound agent-device command. Read `COMPAT_RESULT`, `S1_RESULT`, `ROOT_STORAGE_RESULT`, `MASTER_RESULT`, `LOCAL_KEYS_RESULT`, `BOOTSTRAP_RESULT`, and `EXCHANGE_RESULT`; a build or launch is not a pass. The root SQLite fixture uses actual `openSQLiteStorage`, tests injected local and import failures and reopens a signed and encrypted Loro update after termination. The remaining older S1 schema is a separate storage probe.

For a fresh cross-runtime exchange, bundle and serve this directory from an isolated browser profile:

```sh
agent-heavy -- ./node_modules/.bin/esbuild exchange-browser.mjs --bundle --format=esm --outfile=exchange-browser-bundle.js
agent-heavy --mem 512M -- python3 -m http.server 18767 --bind 127.0.0.1
```

Open `exchange-browser.html`; evaluate `JSON.stringify(await exchange.generate())` and save that public test packet as `browser-packet.json` before launching the native app. Extract the `native` object from `EXCHANGE_RESULT` and evaluate `await exchange.verify(nativePacket)` in the browser. Both runtimes must reject altered ciphertext, scope, and version, and import the decrypted Loro update. To test native binary exports separately, save the JSON object emitted by `COMPAT_RESULT` and run `agent-heavy -- node compat-check-native.mjs /path/to/result.json`. Browser fixtures do not need personal identities, persistent storage, clipboard or an external service.

The adapter covers the operations exercised by this fixture; this is not proof of every root-used Loro behavior or a version selection. Native 1.10.3 `forkAt` unwraps errors, so the candidate uses the error-returning snapshot-at operation instead. The libsodium bridge accepts only byte sequences that round-trip as UTF-8 associated data. The Android master is an experimental Keystore AES-GCM key, with a file lock for key creation and no exported master bytes; the local-key catalog stores wrapped material. `BOOTSTRAP_RESULT` covers only key-catalog initialization, not a complete workspace bootstrap. The emulator reported software security level 0, not hardware-backed storage. Physical device protection, multi-process stress, backup and key invalidation recovery, iOS, release builds, direct transport and integration into the app remain unverified.

## Workspace candidate proof

`workspace-proof.js` executes the actual native bootstrap candidate, root `OfflineRuntime` and `executeAction`; it is not the app UI. It creates signed personal and household authority, accepts a test-only policy, verifies incomplete lineage, saves a rich recipe and a v4 shopping purchase with pantry updates, verifies a projected v4 seed, and reopens after process restart. To prepare this proof in a disposable copy of this fixture, run `prepare-root.mjs` against the current checkout's `src/loro` and `src/domain`, copy `workspace-entry.js` to `App.js`, copy `metro-workspace.config.cjs` to `metro.config.cjs`, and add `./compat-root/native/with-loro-master.cjs` to the copied Expo config's plugin list. The copied fixture also needs the root's pinned `shamir-secret-sharing` and `@types/react` dependencies. After `patch-dependencies.mjs` and before building, run `agent-heavy -- node compat-root/native/patch-sodium.cjs node_modules/react-native-libsodium`. Then use the normal x86_64 build, device installation and bound agent-device launch instructions above. Inspect both `WORKSPACE_RESULT` messages after first launch and process relaunch.

The current candidate remains incomplete: the shared application entry, binding dependencies, Metro configuration, recovery/guardian/pairing capabilities and native file/direct transport wiring require integration and review. The native bridge's additional scalar-multiplication call is verified by the RFC 7748 public vector in this proof; it is not a general audit of the binding.

For the file roundtrip proof, the disposable fixture also needs the root's pinned `expo-file-system`, `expo-document-picker` and `expo-sharing` packages installed and autolinked. The proof writes and reopens an authenticated encrypted object and rejects a mismatched object identifier. It does not drive the system picker or share sheet. The native master on the Android emulator reports software-backed protection; no hardware-backed security is implied.
