import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const androidDirectory = path.join(projectRoot, 'android');
const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? '/var/home/x/Android/Sdk';
const cmakeRoot = process.env.LORO_CMAKE_ROOT ?? '/var/home/linuxbrew/.linuxbrew/Cellar/cmake/4.4.5';
const fmtLibraryDirectory = process.env.LORO_FMT_LIB_DIR ?? '/home/linuxbrew/.linuxbrew/Cellar/fmt/12.2.1/lib';

async function isExecutable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findNinja() {
  if (process.env.LORO_NINJA_BIN) {
    assert(await isExecutable(process.env.LORO_NINJA_BIN), `LORO_NINJA_BIN is not executable: ${process.env.LORO_NINJA_BIN}`);
    return process.env.LORO_NINJA_BIN;
  }

  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'ninja');
    if (await isExecutable(candidate)) return candidate;
  }

  const flatpakSdkRoot = '/home/x/.local/share/flatpak/runtime/org.freedesktop.Sdk/x86_64';
  let sdkVersions = [];
  try {
    sdkVersions = await readdir(flatpakSdkRoot);
  } catch {
    // Continue to the actionable missing-tool error below.
  }
  sdkVersions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const sdkVersion of sdkVersions) {
    const versionDirectory = path.join(flatpakSdkRoot, sdkVersion);
    const runtimeIds = await readdir(versionDirectory);
    for (const runtimeId of runtimeIds) {
      const candidate = path.join(versionDirectory, runtimeId, 'files/bin/ninja');
      if (await isExecutable(candidate)) return candidate;
    }
  }

  throw new Error('Ninja not found on PATH or in the installed Flatpak SDK runtime; set LORO_NINJA_BIN to an existing executable.');
}

const localProperties = await readFile(path.join(androidDirectory, 'local.properties'), 'utf8');
assert(localProperties.includes(`sdk.dir=${sdkRoot}`), 'Android local.properties does not select the expected installed SDK');
assert(localProperties.includes(`cmake.dir=${cmakeRoot}`), 'Android local.properties does not select the installed host CMake');
const gradleProperties = await readFile(path.join(androidDirectory, 'gradle.properties'), 'utf8');
assert.match(gradleProperties, /^reactNativeArchitectures=x86_64$/m, 'fixture must build x86_64 only');

const ninja = await findNinja();
const ninjaVersion = spawnSync(ninja, ['--version'], { encoding: 'utf8' });
if (ninjaVersion.error) throw ninjaVersion.error;
assert.equal(ninjaVersion.status, 0, `could not read Ninja version from ${ninja}`);
await access(path.join(fmtLibraryDirectory, 'libfmt.so.12'));

const ccache = path.join(path.dirname(ninja), 'ccache');
const ccacheEnvironment = {
  ...process.env,
  LD_LIBRARY_PATH: [fmtLibraryDirectory, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
};
if (await isExecutable(ccache)) {
  const ccacheVersion = spawnSync(ccache, ['--version'], { encoding: 'utf8', env: ccacheEnvironment });
  if (ccacheVersion.error) throw ccacheVersion.error;
  assert.equal(ccacheVersion.status, 0, `ccache from the installed SDK runtime cannot start: ${ccacheVersion.stderr}`);
}

const environment = {
  ...process.env,
  ANDROID_HOME: sdkRoot,
  ANDROID_SDK_ROOT: sdkRoot,
  LD_LIBRARY_PATH: ccacheEnvironment.LD_LIBRARY_PATH,
  PATH: `${path.dirname(ninja)}${path.delimiter}${process.env.PATH ?? ''}`,
};
console.log(JSON.stringify({
  command: './gradlew --offline --no-daemon --no-parallel --max-workers=2 :app:assembleDebug --console=plain',
  abi: 'x86_64 only',
  sdkRoot,
  cmakeRoot,
  ninja,
  ninjaVersion: ninjaVersion.stdout.trim(),
  fmtLibraryDirectory,
}, null, 2));

const result = spawnSync('./gradlew', ['--offline', '--no-daemon', '--no-parallel', '--max-workers=2', ':app:assembleDebug', '--console=plain'], {
  cwd: androidDirectory,
  env: environment,
  stdio: 'inherit',
});
if (result.error) throw result.error;
assert.equal(result.status, 0, `Android debug build failed with ${result.status}`);
