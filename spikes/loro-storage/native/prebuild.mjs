import {readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit'}); if(r.error) throw r.error; assert.equal(r.status,0,`${cmd} failed`);};
run('npx',['expo','prebuild','--platform','android','--no-install']);
async function replace(path,from,to) { const s=await readFile(path,'utf8'); if(s.split('\n').includes(to)) return; assert.equal(s.split(from).length,2,`unexpected ${path}`); await writeFile(path,s.replace(from,to)); }
await replace('node_modules/react-native/gradle/libs.versions.toml','ndkVersion = "27.1.12297006"','ndkVersion = "28.0.13004108"');
await replace('android/gradle.properties','reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64','reactNativeArchitectures=x86_64');
await writeFile('android/local.properties',`sdk.dir=${process.env.ANDROID_SDK_ROOT || '/home/x/Android/Sdk'}\ncmake.dir=${process.env.LORO_CMAKE_ROOT || '/home/linuxbrew/.linuxbrew/Cellar/cmake/4.5.0'}\n`);
