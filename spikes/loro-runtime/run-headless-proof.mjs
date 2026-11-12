import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const layoutPath = path.join(projectRoot, 'app/_layout.tsx');
const packageName = 'dev.creativecooking.loro.runtime';
const serial = process.env.ANDROID_SERIAL ?? 'emulator-5580';
const adb = process.env.LORO_ADB ?? '/home/x/Android/Sdk/platform-tools/adb';
const nativeLogPath = process.env.LORO_NATIVE_LOG_PATH
  ?? '/home/x/agent-scratch/creative-cooking/sync-implementation/loro-native-update.log';
const routeUrl = 'creative-cooking:///loro-runtime-spike';
const originalLayout = await readFile(layoutPath, 'utf8');
assert(originalLayout.includes('AppStateProvider'), 'app root layout changed; review before using the isolated runtime fixture');

const minimalLayout = `import { Stack } from 'expo-router';

export default function RuntimeFixtureLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
`;

function adbRun(args, { allowFailure = false } = {}) {
  const result = spawnSync(adb, ['-s', serial, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure) assert.equal(result.status, 0, `adb ${args.join(' ')} failed\n${result.stderr}`);
  return result;
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function launchAndCheck(label, expectRestore) {
  adbRun(['logcat', '-c']);
  adbRun(['shell', 'am', 'force-stop', packageName]);
  adbRun(['shell', 'am', 'start', '-W', '-n', `${packageName}/.MainActivity`, '-a', 'android.intent.action.VIEW', '-d', routeUrl]);

  const startedAt = Date.now();
  const deadline = startedAt + 20_000;
  let jsLog = '';
  let summary;
  let missingProcessSince = 0;
  while (Date.now() < deadline) {
    await pause(1500);
    jsLog = adbRun(['logcat', '-d', '-s', 'ReactNativeJS:V', 'libc:F', 'DEBUG:F']).stdout;
    const match = [...jsLog.matchAll(/LORO_RUNTIME_RESULT=(\{[^\r\n]+\})/g)].at(-1);
    if (match) {
      summary = JSON.parse(match[1]);
      break;
    }
    if (jsLog.includes('LORO_RUNTIME_ERROR=')) break;
    if (/(Fatal signal|JNI DETECTED ERROR|Abort message)/.test(jsLog)) break;
    const processStatus = adbRun(['shell', 'pidof', packageName], { allowFailure: true });
    if (!processStatus.stdout.trim()) {
      missingProcessSince ||= Date.now();
      if (Date.now() - missingProcessSince > 5_000) break;
    } else {
      missingProcessSince = 0;
    }
  }

  if (!summary) {
    const usefulLines = jsLog.split('\n')
      .filter((line) => !line.includes('LORO_NATIVE_UPDATE_BASE64=')
        && /(Fatal signal|JNI DETECTED|SIGSEGV|SIGABRT|FATAL EXCEPTION|Abort message|ReactNativeJS|LORO_RUNTIME_ERROR)/.test(line))
      .slice(-30);
    adbRun(['shell', 'uiautomator', 'dump', '/sdcard/loro-runtime-failure.xml'], { allowFailure: true });
    const uiXml = adbRun(['shell', 'cat', '/sdcard/loro-runtime-failure.xml'], { allowFailure: true }).stdout;
    throw new Error(`${label}: no Loro result marker after ${Date.now() - startedAt} ms\n${usefulLines.join('\n')}\nUI: ${uiXml.replace(/\s+/g, ' ').slice(0, 2000)}`);
  }

  const nativeUpdateLines = jsLog.split('\n').filter((line) => line.includes('LORO_NATIVE_UPDATE_BASE64='));
  assert(nativeUpdateLines.length > 0, `${label}: runtime report appeared without the native update payload`);
  await mkdir(path.dirname(nativeLogPath), { recursive: true });
  await writeFile(nativeLogPath, `${nativeUpdateLines.at(-1)}\n`);

  await pause(1500);
  adbRun(['shell', 'uiautomator', 'dump', '/sdcard/loro-runtime-ui.xml']);
  const uiXml = adbRun(['shell', 'cat', '/sdcard/loro-runtime-ui.xml']).stdout;
  assert(uiXml.includes(packageName), `${label}: fixture app is not visible in the emulator UI`);
  assert(uiXml.includes('adapter=loro-react-native'), `${label}: visible screen does not identify the real native adapter`);
  assert(uiXml.includes('PASS'), `${label}: visible screen does not show PASS`);
  assert.equal(summary.adapter, 'loro-react-native');
  assert.equal(summary.reopenedPreviousSnapshot, expectRestore, `${label}: persisted document restore state differed`);
  for (const key of [
    'removedIngredientRetainedEdit',
    'stableRowIdsPreserved',
    'webUpdateImported',
    'differentOrdersConverged',
    'portableRoundTrip',
  ]) assert.equal(summary[key], true, `${label}: ${key} was false`);
  assert(summary.startupMs >= 0 && summary.snapshotBytes > 0 && summary.localUpdateBytes > 0);

  return { label, ...summary, fixtureVisible: true, passVisible: true };
}

try {
  await writeFile(layoutPath, minimalLayout);
  adbRun(['shell', 'pm', 'clear', packageName]);
  const firstRun = await launchAndCheck('first launch', false);
  adbRun(['shell', 'am', 'force-stop', packageName]);
  await pause(1000);
  const restart = await launchAndCheck('restart', true);
  console.log(JSON.stringify({
    device: serial,
    runtime: 'Hermes + loro-react-native 1.10.3',
    results: [firstRun, restart],
    webExchangeLog: nativeLogPath,
  }, null, 2));
} finally {
  await writeFile(layoutPath, originalLayout);
  adbRun(['shell', 'am', 'force-stop', packageName], { allowFailure: true });
}
