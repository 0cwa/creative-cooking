import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as A from '@automerge/automerge';
import {repository,create,save,scalar,memoryPersistence,copySelectedRecipe,originalConflicts} from '../index.mjs';
const scope={householdId:'home-a',replicationEpoch:1};
const authority={verify:async ({sender})=>sender==='allowed'};
const credentials={sender:'allowed'};
function repo(options={}){return repository({scope,persistence:memoryPersistence(),authority,...options});}
function item(id,name,checked=false){return {id:scalar(id),name:scalar(name),checked};}
async function seeded(){const a=repo();await a.change(d=>{d.shoppingLists.week={id:scalar('week'),title:scalar('Groceries'),items:{milk:item('milk','Milk')},deletedItems:{}};},credentials);return a;}
function fork(a){return repo({snapshot:a.snapshot()});}
async function converge(a,b){assert.equal((await a.receive(b.allChanges(),credentials)).accepted,true);assert.equal((await b.receive(a.allChanges(),credentials)).accepted,true);assert.deepEqual(a.projection(),b.projection());}
test('two households and replication epochs isolate documents and authority cannot be forged',async()=>{
 const a=await seeded(),b=repo({scope:{householdId:'home-b',replicationEpoch:1}});
 assert.equal((await b.receive(a.allChanges(),credentials)).accepted,false);
 const newer=repo({scope:{...scope,replicationEpoch:2}});
 assert.equal((await newer.receive(a.allChanges(),credentials)).accepted,false);
 await assert.rejects(a.change(d=>{d.requirements.diet=scalar('vegan');},{sender:'denied',action:'receive',householdId:'home-b'}),/denied/);
 assert.equal(a.projection().requirements.diet,'none');
});
test('offline add and check merge, duplicate and reordered deliveries converge',async()=>{
 const a=await seeded(),b=fork(a);
 const ea=await a.change(d=>{d.shoppingLists.week.items.bread=item('bread','Bread');},credentials);
 const eb=await b.change(d=>{d.shoppingLists.week.items.milk.checked=true;},credentials);
 await a.receive(eb,credentials);await a.receive(eb,credentials);await b.receive(ea,credentials);
 await converge(a,b);assert.equal(a.projection().shoppingLists[0].items.length,2);assert.equal(a.document.shoppingLists.week.items.milk.checked,true);
});
test('remove wins projection against concurrent edit and survives restart',async()=>{
 const a=await seeded(),b=fork(a);
 await a.change(d=>{d.shoppingLists.week.deletedItems.milk=true;},credentials);
 await b.change(d=>{d.shoppingLists.week.items.milk.name=scalar('Oat milk');},credentials);
 await converge(a,b);
 assert.deepEqual(a.projection().shoppingLists[0].items,[]);
 const restarted=fork(a);assert.deepEqual(restarted.projection().shoppingLists[0].items,[]);
 assert.equal(String(restarted.document.shoppingLists.week.items.milk.name),'Oat milk');
});
test('delivery 4 and 6 waits for causal 5, including snapshot/restart',async()=>{
 const a=await seeded(),b=fork(a);const batches=[];
 for(let n=2;n<=6;n++)batches.push(await a.change(d=>{d.shoppingLists.week.items[`n${n}`]=item(`n${n}`,`Item ${n}`);},credentials));
 // Deliver 2,3 then 4,6 and persist the causally pending 6.
 for(const i of [0,1,2,4])assert.equal((await b.receive(batches[i],credentials)).accepted,true);
 assert.equal(b.document.shoppingLists.week.items.n6,undefined);
 const restarted=fork(b);
 assert.equal((await restarted.receive(batches[3],credentials)).accepted,true);
 assert.equal(String(restarted.document.shoppingLists.week.items.n6.name),'Item 6');
 await converge(a,restarted);
});
test('concurrent scalar alternatives preserved as original values',async()=>{
 const a=await seeded(),b=fork(a);
 await a.change(d=>{d.shoppingLists.week.items.milk.name=scalar('Oat milk');},credentials);
 await b.change(d=>{d.shoppingLists.week.items.milk.name=scalar('Soy milk');},credentials);
 await converge(a,b);
 assert.deepEqual(Object.values(originalConflicts(a.document,['shoppingLists','week','items','milk'],'name')).sort(),['Oat milk','Soy milk']);
 assert.deepEqual(originalConflicts(fork(a).document,['shoppingLists','week','items','milk'],'name'),originalConflicts(a.document,['shoppingLists','week','items','milk'],'name'));
});
test('selected recipes are explicit safe copies, ordered move plus edit retains stable IDs',async()=>{
 const source={id:'personal',title:'Soup',portions:2,ingredients:[{name:'Carrot',amount:'2',apiKey:'excluded'}],steps:['Chop','Boil','Serve'],notes:'private',apiKey:'secret',needsShopping:true};
 const a=await seeded();await a.change(d=>copySelectedRecipe(d,{copyId:'copy',sourceRecipeId:'personal',recipe:source}),credentials);
 const b=fork(a);
 source.title='Changed source';source.steps[0]='Changed source step';
 await a.change(d=>{const order=d.recipes.copy.stepOrder;const moved=String(order[0]);order.deleteAt(0);order.push(scalar(moved));},credentials);
 await b.change(d=>{d.recipes.copy.steps.copy_step_0.text=scalar('Finely chop');},credentials);
 await converge(a,b);
 const recipe=a.projection().recipes[0];assert.equal(recipe.title,'Soup');assert.deepEqual(recipe.steps.map(s=>s.text),['Boil','Serve','Finely chop']);
 assert.equal(recipe.steps[2].id,'copy_step_0');assert.equal('notes' in recipe,false);assert.equal('apiKey' in recipe,false);assert.equal('apiKey' in recipe.ingredients[0],false);
});
test('durable write precedes publish; failed storage leaves document unpublished',async()=>{
 const events=[];const store=memoryPersistence();const a=repo({persistence:{write:async(...args)=>{events.push('persist');await store.write(...args);}},publish:async()=>{events.push('publish');}});
 await a.change(d=>{d.requirements.diet=scalar('vegan');},credentials);assert.deepEqual(events,['persist','publish']);
 const b=repo({persistence:{write:async()=>{throw new Error('disk full');}},publish:async()=>assert.fail('published without durability')});
 await assert.rejects(b.change(d=>{d.requirements.diet=scalar('vegan');},credentials),/disk full/);assert.equal(b.projection().requirements.diet,'none');
 const restarted=repo({snapshot:await store.read(a.storageKey)});assert.equal(restarted.projection().requirements.diet,'vegan');
});
test('quarantines denied, malformed, credential fields, hidden alternatives and namespace edits',async()=>{
 const a=await seeded();let malicious=A.change(A.clone(a.document),d=>{d.apiKey=scalar('secret');});
 assert.equal((await a.receive({...a.allChanges(),changes:A.getChanges(a.document,malicious)},credentials)).accepted,false);
 malicious=A.change(A.clone(a.document),d=>{d.members={allowed:true};});
 assert.equal((await a.receive({...a.allChanges(),changes:A.getChanges(a.document,malicious)},credentials)).accepted,false);
 malicious=A.change(A.clone(a.document),d=>{d.replicationEpoch=2;});
 assert.equal((await a.receive({...a.allChanges(),changes:A.getChanges(a.document,malicious)},credentials)).accepted,false);
 assert.equal((await a.receive(a.allChanges(),{sender:'denied'})).accepted,false);
 assert.equal((await a.receive({...a.allChanges(),changes:[new Uint8Array([1,2])]},credentials)).accepted,false);
 assert.equal(a.quarantine.length,5);assert.equal(a.document.replicationEpoch,1);assert.equal(a.document.apiKey,undefined);
});
test('serializes async durable concurrent local mutations without lost changes',async()=>{
 const a=await seeded();await Promise.all([a.change(d=>{d.shoppingLists.week.items.a=item('a','A');},credentials),a.change(d=>{d.shoppingLists.week.items.b=item('b','B');},credentials)]);
 assert.equal(a.projection().shoppingLists[0].items.length,3);
});
test('tombstones cannot be cleared locally or by a trusted malicious peer',async()=>{
 const a=await seeded();await a.change(d=>{d.shoppingLists.week.deletedItems.milk=true;},credentials);
 await assert.rejects(a.change(d=>{delete d.shoppingLists.week.deletedItems.milk;},credentials),/cannot be cleared/);
 const malicious=A.change(A.clone(a.document),d=>{delete d.shoppingLists.week.deletedItems.milk;});
 assert.equal((await a.receive({...a.allChanges(),changes:A.getChanges(a.document,malicious)},credentials)).accepted,false);
 assert.deepEqual(a.projection().shoppingLists[0].items,[]);
});
test('invalid scalar alternatives and structural ID collisions quarantine',async()=>{
 const a=await seeded();const valid=A.change(A.clone(a.document),d=>{d.shoppingLists.week.items.milk.name=scalar('Valid');});
 const invalid=A.change(A.clone(a.document),d=>{d.shoppingLists.week.items.milk.name=42;});
 const result=await a.receive({...a.allChanges(),changes:[...A.getChanges(a.document,valid),...A.getChanges(a.document,invalid)]},credentials);
 assert.equal(result.accepted,false);
 const first=A.change(A.clone(a.document),d=>{d.shoppingLists.week.items.collision=item('collision','First');});
 const second=A.change(A.clone(a.document),d=>{d.shoppingLists.week.items.collision=item('collision','Second');});
 assert.equal((await a.receive({...a.allChanges(),changes:[...A.getChanges(a.document,first),...A.getChanges(a.document,second)]},credentials)).accepted,false);
});
