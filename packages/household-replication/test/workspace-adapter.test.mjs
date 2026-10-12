import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repository,memoryPersistence,scalar} from '../index.mjs';
import {bootstrapWorkspace,exportWorkspace} from '../workspace-adapter.mjs';
const now='2026-10-12T18:00:00.000Z';
function workspace(){return {id:'home',name:'Home',createdAt:now,updatedAt:now,shoppingList:[{id:'milk',name:'Milk',checked:false,amount:'1',pantryPreference:3,createdAt:now,updatedAt:now}],recipes:[{id:'copy',sourceRecipeId:'personal',addedAt:now,recipe:{id:'personal',title:'Soup',portions:2,ingredients:[{name:'Carrot',amount:'2'}],steps:['Chop','Boil'],notes:'private',needsShopping:true,createdAt:now,updatedAt:now}}],requirements:{allergies:['Nuts'],diet:'vegan'},apiKey:'private'};}
function repo(snapshot){return repository({scope:{householdId:'home',replicationEpoch:1},persistence:memoryPersistence(),authority:{verify:async()=>true},snapshot});}
const args=sidecar=>({sidecar,targetHouseholdId:'home',replicationEpoch:1,now});
test('bootstrap maps explicit household arrays once, exports safely and preserves IDs across restart',async()=>{
 const a=repo(),source=workspace();const sidecar=await bootstrapWorkspace(a,source,{});
 assert.equal(String(a.document.shoppingLists.default.items.milk.id),'milk');
 assert.deepEqual(a.projection().recipes[0].steps.map(step=>step.id),['copy_step_0','copy_step_1']);
 assert.equal(JSON.stringify(a.projection()).includes('private'),false);
 source.recipes[0].recipe.title='Source changed';
 const b=repo(a.snapshot());
 await b.change(d=>{d.shoppingLists.default.items.milk.checked=true;d.recipes.copy.steps.copy_step_0.text=scalar('Finely chop');},{});
 const exported=exportWorkspace(b.document,args(sidecar));
 assert.equal(exported.shoppingList[0].checked,true);assert.equal(exported.shoppingList[0].pantryPreference,3);
 assert.equal(exported.recipes[0].recipe.title,'Soup');assert.deepEqual(exported.recipes[0].recipe.steps,['Finely chop','Boil']);
 assert.equal(exported.recipes[0].recipe.notes,undefined);assert.equal(exported.recipes[0].recipe.needsShopping,undefined);
 assert.deepEqual(exported.requirements,{allergies:['Nuts'],diet:'vegan'});
 await assert.rejects(bootstrapWorkspace(b,source,{}),/empty document/);
});
test('export rejects household and epoch mismatch and never flattens additional lists',async()=>{
 const a=repo();const sidecar=await bootstrapWorkspace(a,workspace(),{});
 assert.throws(()=>exportWorkspace(a.document,{...args(sidecar),targetHouseholdId:'other'}),/mismatch/);
 assert.throws(()=>exportWorkspace(a.document,{...args(sidecar),replicationEpoch:2}),/mismatch/);
 assert.throws(()=>exportWorkspace(a.document,args({...sidecar,householdId:'other'})),/mismatch/);
 await a.change(d=>{d.shoppingLists.extra={id:scalar('extra'),title:scalar('Extra'),items:{},deletedItems:{}};},{});
 assert.throws(()=>exportWorkspace(a.document,args(sidecar)),/multiple lists/);
});
