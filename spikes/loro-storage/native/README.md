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
