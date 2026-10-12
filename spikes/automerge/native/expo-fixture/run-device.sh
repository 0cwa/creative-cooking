#!/usr/bin/env bash
# Independently runnable Android device/emulator harness; no result without logcat.
set -euo pipefail
cd "$(dirname "$0")"
OUTPUT="../../artifacts"
mkdir -p "$OUTPUT"
APK="android/app/build/outputs/apk/release/app-release.apk"
if printenv AUTOMERGE_EXPO_APK >/dev/null; then APK="$AUTOMERGE_EXPO_APK"; fi
test -s "$APK"
adb wait-for-device
adb shell getprop ro.build.version.sdk | tee "$OUTPUT/expo-device-api.txt"
adb shell getprop ro.product.cpu.abi | tee "$OUTPUT/expo-device-abi.txt"
adb install -r "$APK"
adb logcat -c
adb shell am force-stop creative.cooking.automerge.spike.expoapp || true
adb shell am start -n creative.cooking.automerge.spike.expoapp/.MainActivity
for attempt in $(seq 1 30); do
  adb logcat -d -s ReactNativeJS:I ReactNativeJS:E AndroidRuntime:E \
    > "$OUTPUT/expo-device-logcat.txt" || true
  if grep -q 'AUTOMERGE_EXPO_SPIKE_PASS' "$OUTPUT/expo-device-logcat.txt"; then
    printf '{"result":"PASS","runtime":"actual Android Expo 57 / RN 0.86.3 / Hermes"}\n' \
      | tee "$OUTPUT/expo-device-result.json"
    break
  fi
  if grep -q 'AUTOMERGE_EXPO_SPIKE_FAIL\|FATAL EXCEPTION' "$OUTPUT/expo-device-logcat.txt"; then
    tail -n 120 "$OUTPUT/expo-device-logcat.txt"
    exit 1
  fi
  sleep 2
done
test -s "$OUTPUT/expo-device-result.json" || { tail -n 100 "$OUTPUT/expo-device-logcat.txt"; exit 1; }
# Real browser-equivalent JS binding to actual Android Rust JNI exchange.
# Run while the release Expo Activity is foreground to retain receiver state.
( cd ../.. && node android-device-sync.mjs | tee artifacts/android-device-sync.log )
if [ -f android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk ]; then
  adb install -r android/app/build/outputs/apk/debug/app-debug.apk
  adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
  adb shell am instrument -w creative.cooking.automerge.spike.expoapp.test/androidx.test.runner.AndroidJUnitRunner \
    | tee "$OUTPUT/expo-androidtest-output.txt"
  grep -q '^OK (' "$OUTPUT/expo-androidtest-output.txt"
fi
