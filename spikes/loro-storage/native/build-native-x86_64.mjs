import assert from 'node:assert/strict';
import { closeSync, openSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.LORO_PROJECT_ROOT ?? scriptDirectory;
const bindingDirectory = path.join(scriptDirectory, 'native-binding');
const packageDirectory = path.join(projectRoot, 'node_modules/loro-react-native');
const target = 'x86_64-linux-android';
const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? '/home/x/Android/Sdk';
const ndkCandidates = [
  process.env.ANDROID_NDK_HOME,
  process.env.ANDROID_NDK_ROOT,
  path.join(sdkRoot, 'ndk/28.0.13004108'),
  path.join(sdkRoot, 'ndk/27.1.12297006'),
].filter(Boolean);
let ndkRoot;
for (const candidate of ndkCandidates) {
  if (!candidate || !path.isAbsolute(candidate)) continue;
  try {
    await access(path.join(candidate, 'toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android26-clang'));
    ndkRoot = candidate;
    break;
  } catch {
    // Try the next installed NDK location.
  }
}
assert(ndkRoot, 'set ANDROID_NDK_HOME to an installed Android NDK with the x86_64 clang wrapper');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    encoding: options.encoding === null ? null : (options.encoding ?? 'utf8'),
    stdio: options.stdio ?? 'pipe',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed with ${result.status}\n${result.stderr ?? ''}`);
  return result;
}

const rnPackage = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
assert.equal(rnPackage.version, '1.10.3', 'review this build script before changing the upstream binding version');
const cargoManifest = await readFile(path.join(bindingDirectory, 'Cargo.toml'), 'utf8');
const cargoLock = await readFile(path.join(bindingDirectory, 'Cargo.lock'), 'utf8');
assert.match(cargoManifest, /name = "loro-rs"\s+version = "1\.10\.3"/);
assert.match(cargoManifest, /loro-ffi = \{ version = "1\.10\.3" \}/);
assert.match(cargoLock, /name = "loro"\s+version = "1\.10\.3"/);
assert.match(cargoLock, /name = "loro-internal"\s+version = "1\.10\.3"/);

const toolchainBin = path.join(ndkRoot, 'toolchains/llvm/prebuilt/linux-x86_64/bin');
const clang = path.join(toolchainBin, 'x86_64-linux-android26-clang');
const llvmAr = path.join(toolchainBin, 'llvm-ar');
const llvmReadelf = path.join(toolchainBin, 'llvm-readelf');
for (const tool of [clang, llvmAr, llvmReadelf]) {
  await access(tool).catch(() => { throw new Error(`missing installed NDK tool: ${tool}`); });
}

const rustc = run('rustup', ['which', 'rustc']).stdout.trim();
const installedTargets = run('rustup', ['target', 'list', '--installed']).stdout.split(/\s+/);
assert(installedTargets.includes(target), `Rust target ${target} is not installed`);
const buildDirectory = process.env.LORO_NATIVE_BUILD_DIR ?? path.join(scriptDirectory, 'build/android-rust');
const targetDirectory = path.join(buildDirectory, 'target');
await mkdir(buildDirectory, { recursive: true });

const buildEnv = {
  ...process.env,
  ANDROID_NDK_HOME: ndkRoot,
  ANDROID_NDK_ROOT: ndkRoot,
  CARGO_TARGET_DIR: targetDirectory,
  CARGO_BUILD_JOBS: '8',
  CARGO_INCREMENTAL: '0',
  CARGO_PROFILE_RELEASE_DEBUG: '0',
  CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER: clang,
  CC_x86_64_linux_android: clang,
  'CC_x86_64-linux-android': clang,
  AR_x86_64_linux_android: llvmAr,
  'AR_x86_64-linux-android': llvmAr,
  RUSTC: rustc,
  RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C debuginfo=0`.trim(),
};

console.log(JSON.stringify({
  upstream: 'loro-dev/loro-react-native@509d436255fe21e89ba36bd1ee5fb5873a7e7ae0',
  rnPackage: rnPackage.version,
  rustTarget: target,
  ndk: ndkRoot,
  rustc,
  buildDirectory,
}, null, 2));

run('cargo', [
  'build', '--locked', '--release', '--target', target,
  '--manifest-path', path.join(bindingDirectory, 'Cargo.toml'),
  '--jobs', '8',
], { cwd: bindingDirectory, env: buildEnv, stdio: 'inherit' });

const archive = path.join(targetDirectory, target, 'release/libloro_rs.a');
const archiveStat = await stat(archive);
assert(archiveStat.size > 0, 'Rust produced an empty static library');
const members = run(llvmAr, ['t', archive]).stdout.split(/\r?\n/).filter(Boolean);
assert(members.length > 0, 'Rust static library has no members');
const objectPath = path.join(buildDirectory, 'verify-android-archive.o');
const objectFd = openSync(objectPath, 'w');
try {
  const extracted = spawnSync(llvmAr, ['p', archive, members[0]], { stdio: ['ignore', objectFd, 'inherit'] });
  if (extracted.error) throw extracted.error;
  assert.equal(extracted.status, 0, `could not extract ${members[0]} from the Rust archive`);
} finally {
  closeSync(objectFd);
}
const objectHeader = run(llvmReadelf, ['-h', objectPath]).stdout;
assert.match(objectHeader, /Machine:\s+Advanced Micro Devices X86-64/);

const abiFilterPath = path.join(packageDirectory, 'android/build.gradle');
const gradleSource = await readFile(abiFilterPath, 'utf8');
const upstreamAbi = 'abiFilters "arm64-v8a", "armeabi-v7a"';
const patchedAbi = 'abiFilters "arm64-v8a", "armeabi-v7a", "x86_64"';
if (!gradleSource.includes(patchedAbi)) {
  assert.equal(gradleSource.split(upstreamAbi).length - 1, 1, 'unexpected upstream ABI filter; refusing a fuzzy patch');
  await writeFile(abiFilterPath, gradleSource.replace(upstreamAbi, patchedAbi));
}

const x86JniDirectory = path.join(packageDirectory, 'android/src/main/jniLibs/x86_64');
await mkdir(x86JniDirectory, { recursive: true });
const installedArchive = path.join(x86JniDirectory, 'libloro_rs.a');
await copyFile(archive, installedArchive);
const installedStat = await stat(installedArchive);
assert.equal(installedStat.size, archiveStat.size);

console.log(JSON.stringify({
  result: 'local x86_64 test binding built',
  upstreamArmArchives: 'untouched',
  gradleAbiFilter: 'x86_64 added only in node_modules/loro-react-native/android/build.gradle',
  staticLibrary: installedArchive,
  archiveBytes: installedStat.size,
  archiveMembers: members.length,
  verifiedObjectMachine: 'x86_64',
}, null, 2));
