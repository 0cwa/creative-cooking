# Local x86_64 Android binding fixture

This directory contains the Rust wrapper crate copied from `loro-dev/loro-react-native` release commit `509d436255fe21e89ba36bd1ee5fb5873a7e7ae0`, which published `loro-react-native` 1.10.3. The upstream manifest declares `loro-rs` 1.10.3 and depends on `loro-ffi` 1.10.3; the committed lock pins the Loro core and internal crates to 1.10.3. The four Cargo files are kept here so the local ABI build uses the upstream source and lock unchanged.

From the project root, install the fixture dependencies and automatically apply the checked TS6 patch:

```sh
node spikes/loro-runtime/install-fixture.mjs
```

That command performs `npm ci --prefer-offline`, applies the narrow `uniffi-bindgen-react-native@0.28.3-5` TypeScript 6 and byte-buffer fixes, fixes `loro-react-native@1.10.3`'s false-to-null value conversion, applies the React Native 0.86 JNI compatibility patch, creates the web update fixture with `loro-crdt@1.17.1`, and runs `npm run typecheck`. Each patch checks the expected upstream source and pinned package version before changing it.

Build the local x86_64 archive with the already installed Android NDK and Rust target:

```sh
node spikes/loro-runtime/build-native-x86_64.mjs
```

The script builds the upstream `loro-rs` crate for `x86_64-linux-android` into the single `spikes/loro-runtime/build/android-rust/target` directory. It adds `x86_64` to the `ndk.abiFilters` line in the installed package's `node_modules/loro-react-native/android/build.gradle` and copies the archive to that package's `android/src/main/jniLibs/x86_64/libloro_rs.a`. The upstream ARM archives remain unchanged. Both adjustments are local fixture build inputs and are recreated by these commands after a clean install.

This archive is a local x86_64 test build. The NPM package still ships only its upstream ARM binaries; the local archive does not establish upstream x86_64 support or ARM/iOS runtime validation.
