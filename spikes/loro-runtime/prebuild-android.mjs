import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const configPath = path.join(projectRoot, 'app.config.ts');
const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? '/var/home/x/Android/Sdk';
const cmakeRoot = process.env.LORO_CMAKE_ROOT ?? '/var/home/linuxbrew/.linuxbrew/Cellar/cmake/4.4.5';
const originalConfig = await readFile(configPath, 'utf8');
const packagePath = path.join(projectRoot, 'package.json');
const originalPackage = await readFile(packagePath, 'utf8');
const anchor = "  version: '0.1.0',";
const fixturePackage = 'dev.creativecooking.loro.runtime';
assert.equal(originalConfig.split(anchor).length - 1, 1, 'app.config.ts changed; review the temporary package insertion');
assert(!originalConfig.includes(fixturePackage), 'fixture package already exists in app.config.ts');
await access(path.join(cmakeRoot, 'bin/cmake'));

const temporaryConfig = originalConfig.replace(
  anchor,
  `${anchor}\n  android: { package: '${fixturePackage}' },`,
);
try {
  await writeFile(configPath, temporaryConfig);
  const result = spawnSync('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Expo Android prebuild failed with ${result.status}`);

  const reactNativePackage = JSON.parse(await readFile(path.join(projectRoot, 'node_modules/react-native/package.json'), 'utf8'));
  assert.equal(reactNativePackage.version, '0.86.3', 'review the installed NDK patch before changing React Native');
  const versionCatalogPath = path.join(projectRoot, 'node_modules/react-native/gradle/libs.versions.toml');
  const versionCatalog = await readFile(versionCatalogPath, 'utf8');
  const upstreamNdk = 'ndkVersion = "27.1.12297006"';
  const installedNdk = 'ndkVersion = "28.0.13004108"';
  if (!versionCatalog.includes(installedNdk)) {
    assert.equal(versionCatalog.split(upstreamNdk).length - 1, 1, 'unexpected React Native NDK version catalog; refusing a fuzzy patch');
    await writeFile(versionCatalogPath, versionCatalog.replace(upstreamNdk, installedNdk));
  }

  const gradlePropertiesPath = path.join(projectRoot, 'android/gradle.properties');
  const gradleProperties = await readFile(gradlePropertiesPath, 'utf8');
  const upstreamAbis = 'reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64';
  const fixtureAbi = 'reactNativeArchitectures=x86_64';
  if (!/^reactNativeArchitectures=x86_64$/m.test(gradleProperties)) {
    assert.equal(gradleProperties.split(upstreamAbis).length - 1, 1, 'unexpected Expo ABI list; refusing a fuzzy patch');
    await writeFile(gradlePropertiesPath, gradleProperties.replace(upstreamAbis, fixtureAbi));
  }

  await writeFile(
    path.join(projectRoot, 'android/local.properties'),
    `sdk.dir=${sdkRoot}\ncmake.dir=${cmakeRoot}\n`,
  );
} finally {
  await writeFile(configPath, originalConfig);
  await writeFile(packagePath, originalPackage);
}

console.log(JSON.stringify({
  result: 'Expo Android fixture prebuilt',
  fixturePackage,
  ndk: '28.0.13004108',
  reactNativeArchitectures: 'x86_64',
  sdkRoot,
  cmakeRoot,
  restored: ['app.config.ts', 'package.json'],
}, null, 2));
