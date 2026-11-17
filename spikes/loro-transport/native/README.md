# Native probe

This standalone Expo development-build app uses react-native-webrtc and manual SDP exchange with `iceServers: []`. It sends an ASCII representation of the C0 fixture; it does not yet exercise the browser chunk wire format or prove native binary support. The acknowledgement means only receipt in memory. Expo Go cannot load the native module.

From this directory, after native reservation, run `agent-heavy -- npm ci`, `agent-heavy -- npm run prebuild:android`, and `agent-heavy -- npm run assemble:android`. Install the debug APK using the project/device workflow, start Metro with `agent-heavy -- npm start`, and drive the app using a newly opened T3 device session. Share npm, SDK and Gradle caches. Build, installation and runtime have not been verified. The Expo config plugin and dependency versions require validation by that build.
