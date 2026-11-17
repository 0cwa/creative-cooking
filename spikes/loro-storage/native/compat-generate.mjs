// Generate public compatibility data with the exact web version under test.
import {LoroDoc, decodeImportBlobMeta} from 'loro-crdt/nodejs';
import {writeFileSync} from 'node:fs';
const doc = new LoroDoc(); doc.setPeerId('42');
doc.getMap('recipe').set('title','soup'); doc.commit();
const before = doc.oplogVersion(); const frontier = doc.frontiers();
doc.getMap('recipe').set('title','stew'); doc.getMap('recipe').set('visible',false); doc.commit();
const update=doc.export({mode:'update',from:before}), snapshot=doc.export({mode:'snapshot'});
const m=decodeImportBlobMeta(update,true);
const fixture={update:Array.from(update),snapshot:Array.from(snapshot),frontier,changes:doc.exportJsonUpdates(before,undefined,false),meta:{mode:m.mode,startFrontiers:m.startFrontiers,start:[...m.partialStartVersionVector.toJSON()],end:[...m.partialEndVersionVector.toJSON()]}};
writeFileSync('compat-fixture.json',JSON.stringify(fixture,null,2)+'\n');
