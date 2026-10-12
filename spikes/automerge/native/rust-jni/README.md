# Current-core Android JNI feasibility probe

Research-only JNI functions for binary save/load, mutation, full-document merge,
and inspecting unresolved scalar conflicts. Uses the exact pinned Automerge
3.5.0 Rust core (0.12.0), not the older core embedded in official Java 0.0.9.

CI exercises actual Java/JNI calls on the Linux host and verifies web-created
Automerge binary interchange and concurrent scalar conflicts in BOTH runtimes.
The same Rust JNI implementation is then cross-compiled for Android ARM64 API 26.

A host JNI PASS + Android .so compile PASS is NOT Android runtime proof. We still
need an Android APK/instrumentation test loading the .so, a small Expo-compatible
module, platform lifecycle/ownership tests, and real web/Android SyncState wire
exchange. Do not promote this experiment to production or merge the spike PR.


## Experimental follow-up: persistent handles, Expo module and device qualification

The additional src/bridge.rs and CurrentCoreBridge.java implement the minimum
typed API over Automerge Rust 0.12.0, already pinned at the exact Automerge
3.5.0 release commit in the workflow. No CRDT is reimplemented in Java/Kotlin.

Rust owns documents and per-peer SyncState instances in a Mutex-protected
handle registry. Java/Kotlin holds monotonically allocated opaque integer IDs
rather than raw pointers; create/open must be paired with dispose and
newSession must be paired with endSession. Invalid/double-free handles throw.
Every binary result is copied into a Java-owned byte[] and is then freeable by
the VM. Failed apply/receive operates on a fork and only replaces live state
after success. No provider credentials or production state are accessed.

The persistent Java CLI peer NativeCli.java and native-bridge-interop.mjs
exercise real web 3.5 binary interchange, incremental updates, concurrent
value alternatives, provenance, and live two- and three-peer SyncState
sessions. These tests run on a Linux JVM: a host PASS is not an Android PASS.

The Expo Module in ../expo-module uses small typed asynchronous methods over
this same JNI facade; base64 only encodes binary update/sync payloads across
Expo's Kotlin/JS boundary. It does not send JSON document snapshots with
every operation. The standalone ../expo-fixture exercises the real Expo 57 /
React Native 0.86.3 build and Hermes path without changing the main app.
Run the reproducible build and on-device harnesses:

    rustup toolchain install 1.90.0
    rustup target add --toolchain 1.90.0 aarch64-linux-android x86_64-linux-android
    cargo +1.90.0 install cargo-ndk --locked
    cargo +1.90.0 ndk -t arm64-v8a -P 26 build --manifest-path native/rust-jni/Cargo.toml --release
    cargo +1.90.0 ndk -t x86_64 -P 26 build --manifest-path native/rust-jni/Cargo.toml --release
    bash native/expo-fixture/build-ci.sh
    bash native/expo-fixture/run-device.sh

Execute from spikes/automerge with Android SDK/NDK, Java 21 and Node 22.
The build script expects host test-generated real binary fixtures under the
spike artifacts directory and injects them only into the generated fixture.

CI uploads separate build APKs, host JNI evidence, and device logs. A build
without a successful device log tagged AUTOMERGE_EXPO_SPIKE_PASS and an
instrumentation run is explicitly BUILD-ONLY, never a runtime pass.

Production costs still to qualify: this boundary's base64 conversion and
Promise overhead vs ByteBuffer/JSI, Gradle/Rust/NDK build maintenance and
code generation strategy, bridge-level schema migrations, complete list/text
operation support, Android/JS e2e peer handshake on actual hardware, and
native/background threading under sustained load.
