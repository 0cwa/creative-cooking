// Isolated fixture setup. Production native builds call prepare-native.mjs directly.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareNative} from '../../../src/loro/native/prepare-native.mjs';
const projectRoot=process.env.LORO_PROJECT_ROOT??path.dirname(fileURLToPath(import.meta.url));
if(process.env.LORO_SKIP_NPM_CI!=='1'){
 const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['ci','--prefer-offline'],{cwd:projectRoot,stdio:'inherit'});if(result.error)throw result.error;assert.equal(result.status,0,'npm ci failed');
}
await prepareNative(projectRoot);
// Fixture-only restriction. Production preparation preserves all packaged ABIs.
const target=path.join(projectRoot,'node_modules/react-native-libsodium/android/build.gradle'),before='abiFilters "x86", "x86_64", "armeabi-v7a", "arm64-v8a"',after='abiFilters "x86_64"',original=await readFile(target,'utf8');
if(!original.includes(after)){assert.equal(original.split(before).length,2,'unexpected fixture ABI source');await writeFile(target,original.replace(before,after));}
