import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {indexedDBPersistence} from '../indexeddb.mjs';
import {repository,scalar} from '../index.mjs';
test('IndexedDB transaction completes before publish and fresh connection restarts',async()=>{
 const options={indexedDB,databaseName:`test-${Date.now()}`};
 const store=await indexedDBPersistence(options);
 const scope={householdId:'home',replicationEpoch:1};
 let published=false;
 const common={scope,authority:{verify:async()=>true}};
 const a=repository({...common,persistence:store,publish:async()=>{assert.ok(await store.read(a.storageKey));published=true;}});
 await a.change(d=>{d.requirements.diet=scalar('vegan');},{});
 assert.equal(published,true);store.close();
 const reopened=await indexedDBPersistence(options);
 const b=repository({...common,persistence:reopened,snapshot:await reopened.read(a.storageKey)});
 assert.equal(b.projection().requirements.diet,'vegan');
 assert.equal(await reopened.read('household/other/epoch/1'),undefined);reopened.close();
});
