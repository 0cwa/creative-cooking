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
