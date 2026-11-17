import {cp,rm} from 'node:fs/promises';
const source=process.argv[2] ?? '../../../src/loro';
await rm('compat-root',{recursive:true,force:true});
await cp(source,'compat-root',{recursive:true,filter:source=>!source.includes('node_modules')&&!/\.test\.[cm]?[jt]sx?$/.test(source)});
