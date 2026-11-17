import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = scriptDirectory;
const uniffiDirectory = path.join(projectRoot, 'node_modules/uniffi-bindgen-react-native');
const loroAndroidDirectory = path.join(projectRoot, 'node_modules/loro-react-native/android');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed with ${result.status}`);
}

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--prefer-offline']);

const uniffiPackage = JSON.parse(await readFile(path.join(uniffiDirectory, 'package.json'), 'utf8'));
assert.equal(uniffiPackage.version, '0.28.3-5', 'review the TS6 patch before using a new UniFFI version');
const loroPackage = JSON.parse(await readFile(path.join(projectRoot, 'node_modules/loro-react-native/package.json'), 'utf8'));
assert.equal(loroPackage.version, '1.10.3', 'review the native bridge patch before using a new Loro release');

async function replaceFileOnce(targetPath, before, after, description = targetPath) {
  const original = await readFile(targetPath, 'utf8');
  if (original.includes(after)) return;
  assert.equal(original.split(before).length - 1, 1, `unexpected source in ${description}; patch needs review`);
  await writeFile(targetPath, original.replace(before, after));
}

async function replaceOnce(relativePath, before, after) {
  await replaceFileOnce(path.join(uniffiDirectory, relativePath), before, after, relativePath);
}

await replaceOnce(
  'typescript/src/ffi-converters.ts',
  `    if (ArrayBuffer.isView(value)) {
      const ab = value.buffer;
      const start = value.byteOffset;
      const length = value.byteLength;
      if (start === 0 && ab.byteLength === length) {
        return ab;
      }
      const end = start + length;
      return ab.slice(start, end);
    }`,
  `    if (ArrayBuffer.isView(value)) {
      const view = value as unknown as ArrayBufferView<ArrayBufferLike>;
      const ab = view.buffer;
      const start = view.byteOffset;
      const length = view.byteLength;
      if (ab instanceof ArrayBuffer && start === 0 && ab.byteLength === length) {
        return ab;
      }
      const copy = new ArrayBuffer(length);
      const source = new Uint8Array(ab, start, length);
      const target = new Uint8Array(copy);
      for (let index = 0; index < length; index += 1) {
        target[index] = source[index]!;
      }
      return copy;
    }`,
);

await replaceOnce(
  'typescript/src/ffi-types.ts',
  `  static fromByteArray(buf: UniffiByteArray): RustBuffer {
    return new RustBuffer(buf.buffer);
  }`,
  `  static fromByteArray(buf: UniffiByteArray): RustBuffer {
    const value = buf as unknown as {
      buffer?: ArrayBufferLike;
      byteOffset?: number;
      byteLength?: number;
    };
    const sourceBuffer = value.buffer ?? (buf as unknown as ArrayBufferLike);
    const sourceOffset = value.buffer === undefined ? 0 : (value.byteOffset ?? 0);
    const sourceLength = value.byteLength ?? (sourceBuffer.byteLength - sourceOffset);
    const source = new Uint8Array(sourceBuffer, sourceOffset, sourceLength);
    const arrayBuffer = new ArrayBuffer(sourceLength);
    new Uint8Array(arrayBuffer).set(source);
    return new RustBuffer(arrayBuffer);
  }`,
);

await replaceOnce(
  'typescript/src/ffi-types.ts',
  '  readArrayBuffer(numBytes: number): ArrayBufferLike {',
  '  readArrayBuffer(numBytes: number): ArrayBuffer {',
);

await replaceFileOnce(
  path.join(projectRoot, 'node_modules/loro-react-native/src/extension.ts'),
  `    if (!value) {
        return new LoroValue.Null();
    }`,
  `    if (value === undefined || value === null) {
        return new LoroValue.Null();
    }`,
  'loro-react-native 1.10.3 false boolean conversion',
);
await replaceFileOnce(
  path.join(projectRoot, 'node_modules/loro-react-native/lib/module/extension.js'),
  `const jsValueToLoroValue = value => {
  if (!value) {
    return new LoroValue.Null();
  }`,
  `const jsValueToLoroValue = value => {
  if (value === undefined || value === null) {
    return new LoroValue.Null();
  }`,
  'loro-react-native 1.10.3 compiled false boolean conversion',
);

await replaceFileOnce(
  path.join(loroAndroidDirectory, 'cpp-adapter.cpp'),
  `    // 1. Get the Java object referred to by the mHybridData field of the Java holder object
    auto callInvokerHolderClass = env->GetObjectClass(callInvokerHolderJavaObj);
    auto hybridDataField = env->GetFieldID(callInvokerHolderClass, "mHybridData", "Lcom/facebook/jni/HybridData;");
    auto hybridDataObj = env->GetObjectField(callInvokerHolderJavaObj, hybridDataField);

    // 2. Get the destructor Java object referred to by the mDestructor field from the myHybridData Java object
    auto hybridDataClass = env->FindClass("com/facebook/jni/HybridData");
    auto destructorField =
        env->GetFieldID(hybridDataClass, "mDestructor", "Lcom/facebook/jni/HybridData$Destructor;");
    auto destructorObj = env->GetObjectField(hybridDataObj, destructorField);

    // 3. Get the mNativePointer field from the mDestructor Java object
    auto destructorClass = env->FindClass("com/facebook/jni/HybridData$Destructor");
    auto nativePointerField = env->GetFieldID(destructorClass, "mNativePointer", "J");
    auto nativePointerValue = env->GetLongField(destructorObj, nativePointerField);

    // 4. Cast the mNativePointer back to its C++ type
    auto nativePointer = reinterpret_cast<facebook::react::CallInvokerHolder*>(nativePointerValue);
    auto jsCallInvoker = nativePointer->getCallInvoker();`,
  `    // React Native 0.86 uses FBJNI's HybridClassBase; read the native pointer
    // through its supported wrapper API instead of assuming a Java mHybridData field.
    auto holderObject = reinterpret_cast<react::CallInvokerHolder::javaobject>(callInvokerHolderJavaObj);
    facebook::jni::alias_ref<react::CallInvokerHolder::javaobject> holder(holderObject);
    auto jsCallInvoker = holder->cthis()->getCallInvoker();`,
  'loro-react-native Android JNI adapter',
);

console.log(`Applied UniFFI ${uniffiPackage.version} TypeScript 6 and native byte-buffer patches plus Loro ${loroPackage.version} false-boolean and RN 0.86 JNI compatibility patches.`);

// The isolated x86_64 harness builds libsodium with the locally installed CMake 4.
const sodiumDirectory = path.join(projectRoot, 'node_modules/react-native-libsodium');
const sodiumPackage = JSON.parse(await readFile(path.join(sodiumDirectory, 'package.json'), 'utf8'));
assert.equal(sodiumPackage.version, '1.7.0');
run('tar', ['--warning=no-unknown-keyword', '-xzf', path.join(sodiumDirectory, 'libsodium/build.tgz'), '-C', path.join(sodiumDirectory, 'libsodium')]);
await replaceFileOnce(path.join(sodiumDirectory, 'android/CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.4.1)', 'cmake_minimum_required(VERSION 3.5)', 'libsodium CMake version');
await replaceFileOnce(path.join(sodiumDirectory, 'android/build.gradle'), 'abiFilters "x86", "x86_64", "armeabi-v7a", "arm64-v8a"', 'abiFilters "x86_64"', 'libsodium fixture ABI');
