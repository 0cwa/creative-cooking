# Isolated Android JNI runtime, not Expo

This native Android test APK checks whether the p2panda Rust C/JNI probe **actually executes** on Android OS. CI builds an **x86_64 Android shared library** and runs in an accelerated x86_64 API 35 emulator; separately the existing mobile job builds an **aarch64** shared library. Unlike trivial arithmetic JNI, `P2pandaProbe.nativeProbe()` starts a genuine p2panda Node and tests a signed local operation.

The experimental app has no Expo, React Native, production app state or real credentials. Android emulator PASS (if achieved) is **not** an Expo Module or physical arm64 runtime PASS. Output is in isolated machine-readable JSON/logcat.
