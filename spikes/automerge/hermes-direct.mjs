import * as Automerge from '@automerge/automerge';

const doc = Automerge.from({ probe: 'automerge-on-hermes' });
globalThis.print(JSON.stringify({
  webAssembly: typeof globalThis.WebAssembly,
  automergeLoaded: doc.probe === 'automerge-on-hermes'
}));
