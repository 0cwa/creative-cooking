import fs from 'node:fs';
import path from 'node:path';
import {
  LORO_VERSION,
  LoroDoc,
  LoroMap,
  LoroMovableList,
  LoroText,
  VersionVector
} from 'loro-crdt';

const artifactDir = path.resolve('artifacts/loro');
fs.mkdirSync(artifactDir, { recursive: true });

function methods(ctor) {
  return Object.getOwnPropertyNames(ctor.prototype).filter((name) => name !== 'constructor').sort();
}

const doc = new LoroDoc();
doc.setPeerId('101');
doc.getMap('probe').set('value', 1);
doc.commit({ message: 'device:iphone; probe' });

const result = {
  loroVersion: LORO_VERSION,
  constructors: {
    LoroDoc: methods(LoroDoc),
    LoroMap: methods(LoroMap),
    LoroMovableList: methods(LoroMovableList),
    LoroText: methods(LoroText),
    VersionVector: methods(VersionVector)
  },
  snapshotBytes: doc.export({ mode: 'snapshot' }).byteLength,
  json: doc.toJSON(),
  jsonUpdates: doc.exportJsonUpdates(undefined, undefined, false)
};

fs.writeFileSync(path.join(artifactDir, 'web-api-probe.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
