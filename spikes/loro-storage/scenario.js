import init, { LoroDoc } from './node_modules/loro-crdt/web/index.js';
await init();
import { openStorage } from './storage.js';
const assert = (v, message) => { if (!v) throw Error(message); };
const id = 's1-fixture-' + crypto.randomUUID();
const doc = () => new LoroDoc();
const value = d => d.getMap('recipe').get('title');
const restore = async s => { const d = doc(); const bytes = await s.read('documents','document'); if (bytes) d.import(bytes); return d; };
const commit = (d,e,o) => ({document:{documentId:'document',bytes:d.export({mode:'snapshot'})},commands:[{version:1, commandId:e,effectId:e,documentId:'document',kind:'fixture',payload:new Uint8Array([7]),dependencyEffectIds:[]}],outbound:[{object:{id:o,bytes:d.export({mode:'update'})},branchHead:'head',epochId:'epoch'}]});
try {
 let s = await openStorage(id), d = doc(); d.getMap('recipe').set('title','saved');
 const first = commit(d,'effect-1','object-1'); assert((await s.commitLocal(first)).ok,'initial commit');
 for (const boundary of ['document','effect','object','outbox']) {
   d.getMap('recipe').set('title','unsaved-'+boundary);
   assert(!(await s.commitLocal(commit(d,'failed-'+boundary,'object-'+boundary),boundary)).ok,'forced abort '+boundary);
   d = await restore(s); assert(value(d)==='saved','discard mutated document '+boundary);
   assert(!await s.read('effects','failed-'+boundary),'effect rollback '+boundary);
   assert(!await s.read('outbox','object-'+boundary),'outbox rollback '+boundary);
 }
 assert(!(await s.commitLocal(first)).ok,'duplicate must not overwrite');
 assert((await s.read('outbox','object-1')).object.id==='object-1','retry preserves outbox');
 s.close(); s=await openStorage(id); d=await restore(s);
 assert(value(d)==='saved','reopen snapshot'); assert(await s.read('effects','effect-1'),'reopen effect'); assert(await s.read('objects','object-1'),'reopen object');
 const remote=doc(); remote.getMap('recipe').set('title','remote'); const update=remote.export({mode:'update'});
 await s.stageInbox({object:{id:'incoming',bytes:update},source:'peer',cursor:'cursor-1'});
 assert(await s.read('inbox','incoming'),'staged bytes'); assert(await s.read('cursors','peer')==='cursor-1','staged cursor'); assert(!await s.read('applied','incoming'),'not applied on staging');
 d.import(update); const imported={documentId:'document',bytes:d.export({mode:'snapshot'})};
 try { await s.commitImport('incoming',imported,['remote-effect'],true); throw Error('expected abort'); } catch(e) { if(e.message==='expected abort') throw e; }
 assert(!await s.read('applied','incoming'),'import rollback'); d=await restore(s); assert(value(d)==='saved','import rollback document');
 d.import(update); await s.commitImport('incoming',{documentId:'document',bytes:d.export({mode:'snapshot'})},['remote-effect']);
 s.close(); s=await openStorage(id); assert(await s.read('applied','incoming'),'import persisted'); assert(await s.read('effects','remote-effect'),'import effect persisted'); s.close();
 indexedDB.deleteDatabase(id); document.querySelector('#result').textContent='PASS: commit, four rollback boundaries, duplicate, reopen, stage and import';
} catch(e) { document.querySelector('#result').textContent='FAIL: '+e.stack; }
