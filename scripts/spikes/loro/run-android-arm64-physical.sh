#!/usr/bin/env bash
# Real ARM64 Android *physical device* qualification. Deliberately not a
# stand-in x86_64 emulator, transpiled JS fixture, or APK-compile assertion.
set -euo pipefail

OUT="${LORO_ANDROID_OUTPUT:-artifacts/loro/android-arm64-physical}"
PACKAGE="com.creativecooking.lorospike"
mkdir -p "$OUT"
command -v adb >/dev/null
command -v node >/dev/null
adb version > "$OUT/adb-version.txt"
adb devices -l | tee "$OUT/devices.txt"

# Fail closed rather than ambiguously reading frames from other Android devices.
if [[ -n "${LORO_ANDROID_SERIAL:-}" ]]; then
  SERIAL="$LORO_ANDROID_SERIAL"
else
  mapfile -t DEVICES < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')
  if [[ "${#DEVICES[@]}" -ne 1 ]]; then
    echo "Expected exactly one authorized ARM64 physical Android device, found ${#DEVICES[@]}" >&2
    exit 1
  fi
  SERIAL="${DEVICES[0]}"
fi
printf '%s\n' "$SERIAL" > "$OUT/device-serial.txt"
ADB=(adb -s "$SERIAL")
ABI=$("${ADB[@]}" shell getprop ro.product.cpu.abi | tr -d '\r')
API=$("${ADB[@]}" shell getprop ro.build.version.sdk | tr -d '\r')
EMULATOR=$("${ADB[@]}" shell getprop ro.kernel.qemu | tr -d '\r')
printf '%s\n' "$ABI" > "$OUT/device-abi.txt"
printf '%s\n' "$API" > "$OUT/device-api.txt"
printf 'ro.kernel.qemu=%s\n' "$EMULATOR" > "$OUT/physical-device-gate.txt"
if [[ "$ABI" != "arm64-v8a" || ! "$API" =~ ^[0-9]+$ || "$API" -lt 26 ]]; then
  echo "Genuine ARM64 native ABI/API gate failed: ABI=$ABI API=$API" >&2
  exit 1
fi
if [[ "$EMULATOR" == "1" || "$SERIAL" == emulator-* ]]; then
  echo "Android VM is not accepted as physical-device runtime evidence" >&2
  exit 1
fi

APK="${LORO_ANDROID_APK:-android/app/build/outputs/apk/debug/app-debug.apk}"
if [[ ! -f "$APK" ]]; then
  echo "Missing test APK: $APK" >&2
  exit 1
fi
unzip -l "$APK" > "$OUT/apk-file-list.txt"
grep -q 'lib/arm64-v8a/libloro-react-native.so' "$OUT/apk-file-list.txt" || {
  echo "Real ARM64 Loro JNI/Rust native library absent in APK" >&2
  exit 1
}
sha256sum "$APK" | tee "$OUT/apk-sha256.txt"
stat -c '%s' "$APK" > "$OUT/apk-bytes.txt"

METRO_PID=''
cleanup() {
  if [[ -n "$METRO_PID" ]]; then kill "$METRO_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
CI=1 EXPO_PUBLIC_LORO_NATIVE_LABEL=loro-react-native@1.10.3 \
  npx expo start --localhost --port 8081 > "$OUT/metro.log" 2>&1 &
METRO_PID="$!"
sleep 8
"${ADB[@]}" reverse tcp:8081 tcp:8081
"${ADB[@]}" install -r "$APK" | tee "$OUT/install.txt"

# Parse complete result V2 frames, not merely the presence of a frame prefix.
# The existing fail-closed parser must exit successfully. Never replace it
# with a permissive grep or replay of checked-in fixture JSON.
capture_native_result() {
  local raw="$1" result="$2" allow="$3"
  local timeout_seconds=240
  local start=$SECONDS
  while (( SECONDS - start < timeout_seconds )); do
    "${ADB[@]}" logcat -d > "$raw"
    if [[ "$allow" == "first" ]]; then
      if node scripts/spikes/loro/parse-native-log.mjs \
        "$raw" "$result" --allow-partial > "$OUT/parse-first.log" 2>&1; then
        return 0
      fi
    else
      if node scripts/spikes/loro/parse-native-log.mjs \
        "$raw" "$result" > "$OUT/parse-restart.log" 2>&1; then
        return 0
      fi
    fi
    sleep 4
  done
  echo "Timed out before a complete native V2 result: $result" >&2
  cat "$OUT/parse-first.log" "$OUT/parse-restart.log" 2>/dev/null || true
  return 1
}

"${ADB[@]}" shell am force-stop "$PACKAGE" || true
"${ADB[@]}" logcat -c
"${ADB[@]}" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 | tee "$OUT/first-launch.txt"
capture_native_result "$OUT/first-runtime.log" "$OUT/first-result.json" first
node --input-type=module - "$OUT/first-result.json" <<'NODE'
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(process.argv[2]));
if (r.ok !== true || r.status !== 'PARTIAL'
    || r.checks?.processRestart !== 'PARTIAL'
    || !r.runId || r.platform !== 'android') {
  throw new Error('First OS process did not produce actual PARTIAL startup evidence');
}
NODE
"${ADB[@]}" shell dumpsys meminfo "$PACKAGE" > "$OUT/meminfo-first.txt" 2>&1 || true
FIRST_PID=$("${ADB[@]}" shell pidof "$PACKAGE" | tr -d '\r' || true)
printf '%s\n' "$FIRST_PID" > "$OUT/first-pid.txt"
if [[ -z "$FIRST_PID" ]]; then echo "First native process PID missing" >&2; exit 1; fi

# Force-kill the process, verify that Android no longer reports it, then
# relaunch so AsyncStorage actually crosses an OS process boundary.
"${ADB[@]}" shell am force-stop "$PACKAGE"
sleep 2
if [[ -n "$("${ADB[@]}" shell pidof "$PACKAGE" | tr -d '\r' || true)" ]]; then
  echo "Android process still alive after am force-stop" >&2
  exit 1
fi
printf '%s\n' 'PID absent after OS am force-stop' > "$OUT/process-stop-proof.txt"
"${ADB[@]}" logcat -c
"${ADB[@]}" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 | tee "$OUT/restart-launch.txt"
capture_native_result "$OUT/runtime.log" "$OUT/result.json" restart
SECOND_PID=$("${ADB[@]}" shell pidof "$PACKAGE" | tr -d '\r' || true)
printf '%s\n' "$SECOND_PID" > "$OUT/restart-pid.txt"
if [[ -z "$SECOND_PID" || "$SECOND_PID" == "$FIRST_PID" ]]; then
  echo "Second Android process PID not independently established" >&2
  exit 1
fi
"${ADB[@]}" shell dumpsys meminfo "$PACKAGE" > "$OUT/meminfo-restart.txt" 2>&1 || true
node --input-type=module - "$OUT/first-result.json" "$OUT/result.json" <<'NODE'
import { readFileSync } from 'node:fs';
const first = JSON.parse(readFileSync(process.argv[2]));
const second = JSON.parse(readFileSync(process.argv[3]));
if (!second.ok || second.status !== 'PASS'
    || second.platform !== 'android'
    || second.checks?.processRestart !== 'PASS'
    || second.processRestart?.previousRunId !== first.runId
    || second.runId === first.runId) {
  throw new Error('Second native Android process did not prove persisted OS restart');
}
NODE

echo 'Real physical Android ARM64 native harness and separate process restart: PASS.'
