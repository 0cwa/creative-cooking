import assert from 'node:assert/strict';
import fs from 'node:fs';

const engine = process.argv[2];
assert.ok(['control','automerge','loro'].includes(engine));
const shared = `import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
const fixed = (ok: boolean, detail: string) => ({ ok, detail });
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, n => String.fromCharCode(n)).join(''));
const decode = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
`;
const auto = `import * as A from '@automerge/automerge/slim';
const KEY = 'parity-automerge-v1';
const actors = { seed: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', phone: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  laptop: 'cccccccccccccccccccccccccccccccc', tablet: 'dddddddddddddddddddddddddddddddd' };
async function engineRun() {
  await A.initializeWasm('/creative-cooking/_expo/static/js/web/automerge.wasm');
  let seed = A.init({ actor: actors.seed });
  seed = A.change(seed, { message: 'web seed' }, d => {
    d.recipe = { id: 'recipe-0000', title: 'Kitchen supper', revision: 0 };
    d.pantry = { id: 'pantry-0000', preference: 3 };
  });
  const old = localStorage.getItem(KEY);
  const base = old ? A.load(decode(old), { actor: actors.seed }) : seed;
  const prior = base.recipe.revision;
  let a = A.clone(base, { actor: actors.phone }), b = A.clone(base, { actor: actors.laptop });
  a = A.change(a, d => { d.recipe.revision += 1; });
  b = A.change(b, d => { d.pantry.preference = base.pantry.preference === 4 ? 5 : 4; });
  const ab = A.getChanges(base, a), ba = A.getChanges(base, b);
  a = A.applyChanges(a, ba)[0]; b = A.applyChanges(b, ab)[0];
  b = A.applyChanges(b, ab)[0]; // idempotent duplicate
  if (a.recipe.revision !== prior + 1 || b.recipe.revision !== prior + 1) throw Error('incremental recipe failed');
  if (a.pantry.preference !== b.pantry.preference) throw Error('incremental pantry failed');
  const bytes = A.save(a);
  const reloaded = A.load(bytes, { actor: actors.tablet });
  if (reloaded.recipe.revision !== prior + 1) throw Error('snapshot reload failed');
  localStorage.setItem(KEY, encode(bytes));
  (window as any).__parityOffline = () => {
    let d = A.load(decode(localStorage.getItem(KEY)!), { actor: actors.tablet });
    d = A.change(d, next => { next.recipe.revision += 1; });
    localStorage.setItem(KEY, encode(A.save(d)));
    return { offline: true, revision: d.recipe.revision, bytes: A.save(d).byteLength };
  };
  return { engine: 'automerge', prior, revision: reloaded.recipe.revision, bytes: bytes.byteLength,
    incrementalBytes: ab.reduce((n,x)=>n+x.byteLength,0)+ba.reduce((n,x)=>n+x.byteLength,0),
    snapshotLoaded: true, duplicateSafe: true };
}`;
const loro = `const KEY = 'parity-loro-v1';
async function engineRun() {
  // Client-only import: Loro's WASM/ESM module must not be evaluated by Expo
  // static prerendering, where it prevents a Suspense boundary finishing (#419).
  const { LoroDoc } = await import('loro-crdt');
  function make(peer: string) { const d = new LoroDoc(); d.setPeerId(peer); return d; }
  const seed = make('900');
  seed.getMap('recipe').set('id', 'recipe-0000');
  seed.getMap('recipe').set('title', 'Kitchen supper');
  seed.getMap('recipe').set('revision', 0);
  seed.getMap('pantry').set('id','pantry-0000');
  seed.getMap('pantry').set('preference', 3);
  seed.commit({ message: 'web seed' });
  const old = localStorage.getItem(KEY);
  const base = old ? make('900') : seed;
  if (old) base.import(decode(old));
  const prior = base.getMap('recipe').get('revision') as number;
  const a = base.fork(); a.setPeerId('101');
  const b = base.fork(); b.setPeerId('202');
  a.getMap('recipe').set('revision', prior + 1); a.commit({ message: 'browser edit A' });
  b.getMap('pantry').set('preference', base.getMap('pantry').get('preference') === 4 ? 5 : 4);
  b.commit({ message: 'browser edit B' });
  const ab = a.export({ mode: 'update', from: b.oplogVersion() });
  const ba = b.export({ mode: 'update', from: a.oplogVersion() });
  b.import(ab); a.import(ba); b.import(ab);
  if (a.getMap('recipe').get('revision') !== prior + 1 ||
      b.getMap('recipe').get('revision') !== prior + 1) throw Error('incremental recipe failed');
  if (a.getMap('pantry').get('preference') !== b.getMap('pantry').get('preference')) throw Error('pantry divergence');
  const bytes = a.export({ mode: 'snapshot' });
  const reloaded = make('303'); reloaded.import(bytes);
  if (reloaded.getMap('recipe').get('revision') !== prior + 1) throw Error('snapshot reload failed');
  localStorage.setItem(KEY, encode(bytes));
  (window as any).__parityOffline = () => {
    const d = make('303'); d.import(decode(localStorage.getItem(KEY)!));
    d.getMap('recipe').set('revision', (d.getMap('recipe').get('revision') as number) + 1);
    d.commit({ message: 'offline edit' });
    const saved = d.export({ mode: 'snapshot' });
    localStorage.setItem(KEY, encode(saved));
    return { offline: true, revision: d.getMap('recipe').get('revision'), bytes: saved.byteLength };
  };
  return { engine: 'loro', prior, revision: reloaded.getMap('recipe').get('revision'),
    bytes: bytes.byteLength, incrementalBytes: ab.byteLength + ba.byteLength,
    snapshotLoaded: true, duplicateSafe: true };
}`;
const control = `function engineRun() {
  return { engine: 'control', message: 'No CRDT imported into baseline route' };
}`;
const component = `
export default function BenchmarkParityWeb() {
  const [result, setResult] = useState<{ ok: boolean; detail: string }>(fixed(false,'pending'));
  useEffect(() => {
    Promise.resolve().then(() => engineRun()).then(output => {
      (window as any).__parityResult = output;
      setResult(fixed(true, JSON.stringify(output)));
    }).catch(err => {
      (window as any).__parityError = String(err);
      setResult(fixed(false, String(err instanceof Error ? err.stack : err)));
    });
  }, []);
  return <View style={{ padding: 24 }}><Text testID="parity-marker">{result.ok ? 'PARITY PASS' : 'PARITY ' + (result.detail === 'pending' ? 'PENDING' : 'FAIL')}</Text>
    <Text testID="parity-detail">{result.detail}</Text></View>;
}
`;
fs.writeFileSync('app/benchmark-parity.tsx', shared + (engine === 'automerge' ? auto : engine === 'loro' ? loro : control) + component);
console.log('Materialized temporary Expo static test route: ' + engine);
