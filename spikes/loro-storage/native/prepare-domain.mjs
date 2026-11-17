// Copy the current app domain implementation into the isolated Metro fixture.
import {mkdir,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const source=process.argv[2] ?? '../../../src/loro/domain';
await mkdir('compat-domain',{recursive:true});
for(const name of ['registry.mjs','personal-codec.mjs']) await copyFile(resolve(source,name),resolve('compat-domain',name));

const cryptoSource=process.argv[3] ?? '../../../src/loro/crypto';
for(const name of ['candidate.mjs','test-provider.mjs']) await copyFile(resolve(cryptoSource,name),resolve('compat-domain',name));

const storageSource=process.argv[4] ?? '../../../src/loro/storage';
await copyFile(resolve(storageSource,'local-keys.ts'),resolve('compat-domain','local-keys.ts'));
