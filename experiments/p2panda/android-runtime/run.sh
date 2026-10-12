#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$dir"
mkdir -p ../artifacts
adb wait-for-device
adb shell getprop ro.product.cpu.abi
adb shell getprop ro.build.version.sdk
adb logcat -c
apk="$(find build/outputs/apk/debug -maxdepth 1 -type f -name '*-debug.apk' | head -n 1)"
test -s "$apk"
adb install -r "$apk"
adb shell am start -n org.creativecooking.spike/.MainActivity
result="NOT_OBSERVED"
for attempt in $(seq 1 100); do
  adb logcat -d -s CCPANDA:I '*:S' > ../artifacts/android-emulator-log.txt || true
  if grep -q 'CC_P2PANDA_ANDROID_NATIVE_RUNTIME=PASS' ../artifacts/android-emulator-log.txt; then
    result="PASS"; break
  fi
  if grep -q 'CC_P2PANDA_ANDROID_NATIVE_RUNTIME=FAIL' ../artifacts/android-emulator-log.txt; then
    result="FAIL"; break
  fi
  sleep 2
done
node -e 'const fs=require("fs");fs.writeFileSync("../artifacts/android-emulator-result.json",JSON.stringify({status:process.argv[1],nativeJNIExecution:process.argv[1]==="PASS",platform:"Android emulator x86_64",isExpoApp:false,physicalArm64:false,source:"real p2panda Node local stream probe"},null,2))' "$result"
echo "CC_ANDROID_EMULATOR_RESULT=$result"
test "$result" = "PASS"
