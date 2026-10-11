#!/usr/bin/env bash
# Isolated repeatable Expo 57 / RN 0.86.3 Android release and instrumented build.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
BRIDGE="$ROOT/native/rust-jni"
MODULE="$ROOT/native/expo-module"
OUTPUT="$ROOT/artifacts"
mkdir -p "$OUTPUT" "$MODULE/android/src/main/jniLibs/arm64-v8a" \
  "$MODULE/android/src/main/jniLibs/x86_64"
cp "$BRIDGE/target/aarch64-linux-android/release/libcreative_cooking_automerge_jni.so" \
  "$MODULE/android/src/main/jniLibs/arm64-v8a/"
cp "$BRIDGE/target/x86_64-linux-android/release/libcreative_cooking_automerge_jni.so" \
  "$MODULE/android/src/main/jniLibs/x86_64/"
node --version | tee "$OUTPUT/expo-build-versions.log"
npm --version | tee -a "$OUTPUT/expo-build-versions.log"
java -version 2>&1 | tee -a "$OUTPUT/expo-build-versions.log"
rustc +1.90.0 --version | tee -a "$OUTPUT/expo-build-versions.log"
printf 'ANDROID_HOME=%s\n' "$ANDROID_HOME" | tee -a "$OUTPUT/expo-build-versions.log"
ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | tee -a "$OUTPUT/expo-build-versions.log" || true
npm install --no-audit --no-fund
npm run prebuild:android
printf '\nandroid.minSdkVersion=26\n' >> android/gradle.properties
# Inject *experimental* tests into generated fixture, never the product app.
mkdir -p android/app/src/androidTest/java/creative/cooking/automerge/spike
mkdir -p android/app/src/androidTest/assets
cp android-tests/AutomergeBridgeInstrumentedTest.java \
  android/app/src/androidTest/java/creative/cooking/automerge/spike/
cp "$OUTPUT/android-bridge-web-seed.am" android/app/src/androidTest/assets/web-seed.am
cp "$OUTPUT/android-bridge-conflicted.am" android/app/src/androidTest/assets/conflicted.am
cat >> android/app/build.gradle <<'GRADLE'

android {
  defaultConfig {
    testInstrumentationRunner 'androidx.test.runner.AndroidJUnitRunner'
  }
}
dependencies {
  androidTestImplementation 'androidx.test.ext:junit:1.3.0'
  androidTestImplementation 'androidx.test:runner:1.7.0'
}
GRADLE
./android/gradlew -p android --no-daemon :app:assembleRelease :app:assembleDebugAndroidTest \
  > "$OUTPUT/expo-gradle-build.log" 2>&1 || {
    tail -n 220 "$OUTPUT/expo-gradle-build.log"; exit 1;
  }
grep -R --include='*.java' --include='*.kt' 'AutomergeSpikeModule' \
  android/app/build/generated android/build/generated > "$OUTPUT/expo-module-registered.log" 2>/dev/null || {
  echo 'Expo autolinking did not generate AutomergeSpikeModule registration' >&2; exit 1;
}
APK="android/app/build/outputs/apk/release/app-release.apk"
test -s "$APK"
if command -v aapt >/dev/null; then aapt dump badging "$APK" > "$OUTPUT/expo-apk-badging.log"; fi
if command -v unzip >/dev/null; then
  unzip -l "$APK" | grep 'libcreative_cooking_automerge_jni.so' \
    > "$OUTPUT/expo-packaged-jni.log"
fi
APK_BYTES=$(wc -c < "$APK" | tr -d ' ')
ARM_BYTES=$(wc -c < "$MODULE/android/src/main/jniLibs/arm64-v8a/libcreative_cooking_automerge_jni.so" | tr -d ' ')
X86_BYTES=$(wc -c < "$MODULE/android/src/main/jniLibs/x86_64/libcreative_cooking_automerge_jni.so" | tr -d ' ')
printf '{"result":"PASS","evidence":"Expo 57 / RN 0.86.3 release + AndroidTest APK COMPILE only","androidApi":26,"abis":["arm64-v8a","x86_64"],"apkBytes":%s,"rustArmSoBytes":%s,"rustX86SoBytes":%s}\n' \
  "$APK_BYTES" "$ARM_BYTES" "$X86_BYTES" | tee "$OUTPUT/expo-build-result.json"
