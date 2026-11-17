import {LoroDoc, Frontiers, VersionVector, decodeImportBlobMeta} from 'loro-react-native';
import fixture from './compat-fixture.json';
import {LoroDoc as Adapter, decodeImportBlobMeta as decodeAdapter} from './native-adapter';
import {apply, validateOperations} from './compat-domain/registry.mjs';
const bytes = xs => Uint8Array.from(xs).buffer;
const ids = f => f.toVec().map(x => ({peer:String(x.peer),counter:x.counter}));
const vector = v => [...v.toHashmap()].map(([p,n])=>[String(p),n]);
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
const equal = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function compatibility() {
 const checks = {}; const details = {}; const test = (name, fn) => {try {checks[name] = fn() === false ? 'FAIL assertion' : 'PASS';} catch (e) {checks[name] = 'FAIL '+String(e);}};
 let doc, old, metadata, nativeSnapshot, nativeUpdate;
 test('hermes',()=>!!global.HermesInternal);
 test('web_snapshot_import',()=>{doc=new LoroDoc();doc.import_(bytes(fixture.snapshot));return equal(doc.toJSON(),{recipe:{title:'stew',visible:false}})});
 test('web_update_metadata',()=>{metadata=decodeImportBlobMeta(bytes(fixture.update),true);details.metadata={mode:metadata.mode,startFrontiers:ids(metadata.startFrontiers),start:vector(metadata.partialStartVv),end:vector(metadata.partialEndVv)};return metadata.mode===fixture.meta.mode && equal(ids(metadata.startFrontiers),fixture.meta.startFrontiers) && equal(vector(metadata.partialStartVv),fixture.meta.start) && equal(vector(metadata.partialEndVv),fixture.meta.end)});
 test('fork_at',()=>{const frontier=Frontiers.fromIds(fixture.frontier.map(x=>({peer:BigInt(x.peer),counter:x.counter})));old=doc.forkAt(frontier);return equal(old.toJSON(),{recipe:{title:'soup'}})});
 test('update_import',()=>{const status=old.import_(bytes(fixture.update));details.update={pending:status.pending?.size||0,actual:old.toJSON(),expected:doc.toJSON()};return !status.pending?.size && equal(old.toJSON(),doc.toJSON())});
 test('oplog_version',()=>equal(vector(doc.oplogVersion()),[['42',3]]));
 test('json_operations',()=>{const start=new VersionVector();start.setEnd({peer:42n,counter:1});const json=JSON.parse(doc.exportJsonUpdatesWithoutPeerCompression(start,doc.oplogVersion()));details.operations=json;return equal(json,fixture.changes)});
 test('native_export',()=>{const d=new LoroDoc();d.setPeerId(99n); const v=d.oplogVersion();d.getMap('recipe').set('title','native');d.getMap('recipe').set('visible',false);d.commit();nativeSnapshot=Array.from(new Uint8Array(d.exportSnapshot()));nativeUpdate=Array.from(new Uint8Array(d.exportUpdates(v)));return nativeSnapshot.length>0 && nativeUpdate.length>0});
 test('adapter_history_and_rejection',()=>{const d=new Adapter();d.import(Uint8Array.from(fixture.snapshot));const prior=d.forkAt(fixture.frontier);if(prior.getMap('recipe').get('title')!=='soup')return false;try {d.forkAt([{peer:'987654',counter:0}]);return false}catch{} const m=decodeAdapter(Uint8Array.from(fixture.update),true);return equal([...m.partialEndVersionVector.toJSON()],fixture.meta.end)});
 test('domain_validation',()=>{const d=new Adapter();d.setPeerId('7');const before=d.oplogVersion();const c={version:1,kind:'purchase',commandId:'c-a',effectId:'a',dependencyEffectIds:[],data:{id:'a',listId:'list',purchaseCycleId:'cycle',itemIds:['item'],pantryItemIds:[],purchasedAt:'2026-11-17T00:00:00Z',author:'a'}};apply(d,c);const changes=d.exportJsonUpdates(before,undefined,false).changes;validateOperations(c,changes);try {validateOperations({...c,data:{...c.data,author:'forged'}},changes);return false}catch{} return d.getMap('purchases').get('a')!==undefined;});
 test('domain_recipe_concurrent',()=>{const a=new Adapter(),b=new Adapter();a.setPeerId('1');b.setPeerId('2');const cmd=(id,field,value)=>({version:1,kind:'recipe-ingredient-field',commandId:'cmd-'+id,effectId:id,dependencyEffectIds:[],data:{recipeId:'r',ingredientId:'i',field,value,author:'a',at:'2026-01-01T00:00:00Z'}});for(const [d,c] of [[a,cmd('x','name','Carrot')],[b,cmd('y','amount','2')]]){const before=d.oplogVersion();apply(d,c);validateOperations(c,d.exportJsonUpdates(before,undefined,false).changes)}a.import(b.export({mode:'snapshot'}));return Object.keys(a.getMap('recipe-intentions:r').toJSON()).length===2});
 test('adapter_map_and_binary',()=>{const d=new Adapter();d.setPeerId('314');const initial=d.oplogVersion();const map=d.getMap('fixture');const value={nested:['soup',false,null,3,{unicode:'räksoppa'}]};map.set('entry',value);d.commit();if(!equal(map.get('entry'),value)||!equal(map.toJSON(),{entry:value}))return false;const update=d.export({mode:'update',from:initial});const restored=new Adapter();restored.import(update);if(!equal(restored.getMap('fixture').get('entry'),value))return false;const copy=new Adapter();copy.import(d.export({mode:'snapshot'}));return equal(copy.toJSON(),d.toJSON())});
 test('checksum_rejected',()=>{const corrupted=Uint8Array.from(fixture.update);corrupted[corrupted.length-1]^=1;try{decodeAdapter(corrupted,true);return false}catch{return true}});
 test('bad_blob_rejected',()=>{try {decodeImportBlobMeta(bytes([1,2,3]),true);return false}catch{return true}});
 return {checks,details,nativeSnapshot,nativeUpdate};
}
