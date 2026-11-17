import {copyFile,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir='android/app/src/main/java/dev/creativecooking/loro/storagefixture/';
await copyFile('master-android/FixtureMasterPackage.kt',dir+'FixtureMasterPackage.kt');
const file=dir+'MainApplication.kt';let s=await readFile(file,'utf8');const before='// add(MyReactNativePackage())', after='add(FixtureMasterPackage())';
if(!s.includes(after)){assert.equal(s.split(before).length,2);s=s.replace(before,after);await writeFile(file,s);}
