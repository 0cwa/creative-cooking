import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
const base = 'artifacts/benchmark-parity';
fs.mkdirSync(base,{recursive:true});
function analyze(dir) {
  const entries = [];
  function walk(folder) {
    for (const e of fs.readdirSync(folder,{withFileTypes:true})) {
      const f = path.join(folder,e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        const bytes = fs.readFileSync(f), relative = path.relative(dir,f);
        const compressible = /\.(?:html|js|css|json|wasm|svg)$/u.test(f);
        entries.push({ path:relative, rawBytes:bytes.length,
          gzipBytes:compressible ? gzipSync(bytes).length : bytes.length,
          brotliBytes:compressible ? brotliCompressSync(bytes).length : bytes.length,
          kind:f.endsWith('.wasm')?'wasm':f.endsWith('.js')?'js':'other' });
      }
    }
  }
  walk(dir);
  const sum = field => entries.reduce((x,e)=>x+e[field],0);
  return { files: entries.length, rawBytes:sum('rawBytes'), gzipBytes:sum('gzipBytes'),
    brotliBytes:sum('brotliBytes'), entries };
}
const builds = Object.fromEntries(['control','automerge','loro'].map(e=>[e,analyze('dist-'+e)]));
const delta = Object.fromEntries(['automerge','loro'].map(engine => [engine,
  Object.fromEntries(['rawBytes','gzipBytes','brotliBytes'].map(k=>[k,builds[engine][k]-builds.control[k]]))]));
const result = { measuredAt:new Date().toISOString(), basePath:'/creative-cooking/',
  note:'All static assets in the real Expo export including production app shell and isolated benchmark route; compressed sizes are offline recompression, not measured HTTP transfers. Installed npm size is excluded.',
  builds, deltaVsControl:delta,
  lazyLoadAnalysis:'See emitted entry/static JS and WASM entries; this probe does not prove lazy loading without a production implementation.' };
fs.writeFileSync(base+'/static-cost.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ totals:Object.fromEntries(Object.entries(builds).map(([k,v])=>[k,{
  rawBytes:v.rawBytes,gzipBytes:v.gzipBytes,brotliBytes:v.brotliBytes
}])), delta }, null, 2));
