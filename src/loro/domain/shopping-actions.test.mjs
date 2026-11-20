import {projectCurrentSeed,verifyCurrentSeed} from '../compromise/current-seed.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {LoroDoc} from 'loro-crdt/nodejs';import {planShoppingAction} from '../app/shopping-actions.mjs';import {apply,checkPreconditions,checkShoppingCompatibility,validate} from './registry.mjs';import {projectCooking} from './app-projection.mjs';import {emptyShoppingState,createShoppingList,appendShoppingItems,updateShoppingItem,setShoppingItemChecked,startNewPurchaseCycle,applyShoppingPurchase,removeShoppingItem,removeShoppingList} from '../../domain/shopping.ts';
const at='2026-01-01T00:00:00.000Z',later='2026-01-02T00:00:00.000Z';
test('shopping field commands retain recipe links and atomically record purchase plus pantry',()=>{const doc=new LoroDoc();doc.setPeerId('17');apply(doc,{version:1,kind:'recipe-create',commandId:'recipe',effectId:'recipe',dependencyEffectIds:[],data:{recipe:{id:'recipe',title:'Soup',portions:1,ingredients:[{id:'ingredient',name:'Carrot'}],steps:[],stepIds:[]},author:'a',at}});let shopping=emptyShoppingState(),pantry=[],i=0;const save=(next,nextPantry=pantry)=>{const cmds=planShoppingAction({doc,before:shopping,after:next,pantryBefore:pantry,pantryAfter:nextPantry,actionId:`a${++i}`,author:'a',at:later});for(const c of cmds){checkPreconditions(doc,c);apply(doc,c)}shopping=next;pantry=nextPantry;return cmds};save(createShoppingList(shopping,{id:'list',cycleId:'cycle',name:'Market',at}));save(appendShoppingItems(shopping,'list',[{id:'item',name:'HIDDEN_ITEM_CANARY',recipeId:'recipe',ingredientId:'ingredient',displayQuantity:'2',displayUnit:'kg',at}]));let projected=projectCooking(doc);assert.equal(projected.shopping.items[0].recipeId,'recipe');assert.equal(projected.shopping.items[0].displayUnit,'kg');save(updateShoppingItem(shopping,'item',{name:'Golden carrot',displayQuantity:'3',displayUnit:'kg'},later));save(setShoppingItemChecked(shopping,'item','cycle',true,later));const purchase=applyShoppingPurchase(shopping,pantry,{id:'purchase',listId:'list',purchaseCycleId:'cycle',purchasedAt:later});const ops=save(purchase.shopping,purchase.pantry);assert.equal(ops.filter(c=>c.kind==='purchase').length,1);assert.equal(ops.find(c=>c.kind==='purchase').effectId,'purchase');projected=projectCooking(doc);assert.equal(projected.shopping.purchases[0].id,'purchase');assert.equal(projected.shopping.items[0].purchasedCycleId,'cycle');assert.equal(projected.pantry[0].name,'Golden carrot');const reopened=new LoroDoc();reopened.import(doc.export({mode:'snapshot'}));assert.deepEqual(projectCooking(reopened),projected);const source=doc.export({mode:'snapshot'});assert.throws(()=>projectCurrentSeed({LoroDoc,source,seedId:'s',peerId:'19'}),/UNSUPPORTED_SEED_SOURCE/);const seed=projectCurrentSeed({LoroDoc,source,seedId:'s',peerId:'19',schemaVersion:4});verifyCurrentSeed({LoroDoc,snapshot:seed.snapshot,seed,schemaVersion:4});assert.throws(()=>verifyCurrentSeed({LoroDoc,snapshot:seed.snapshot,seed}),/INVALID_SEED/);const seeded=new LoroDoc();seeded.import(seed.snapshot);assert.equal(JSON.stringify(seeded.exportJsonUpdates(undefined,undefined,false)).includes('HIDDEN_ITEM_CANARY'),false);const damagedState=seeded.toJSON(),nameHead=`field-head:${encodeURIComponent(JSON.stringify(['shopping-item','item','name']))}`;delete damagedState[nameHead];const forged=new LoroDoc();forged.setPeerId('18');for(const [container,fields] of Object.entries(damagedState))for(const [key,value] of Object.entries(fields))forged.getMap(container).set(key,value);assert.throws(()=>verifyCurrentSeed({LoroDoc,snapshot:forged.export({mode:'snapshot'}),seed,schemaVersion:4}),/INVALID_SEED/);const current=projectCooking(seeded);assert.equal(current.shopping.items[0].recipeId,'recipe');assert.equal(current.shopping.items[0].displayQuantity,'3');assert.equal(current.shopping.items[0].purchasedCycleId,'cycle');assert.equal(current.shopping.purchases[0].id,'purchase');assert.equal(current.shopping.items[0].createdAt,null);save(startNewPurchaseCycle(shopping,'list','cycle2',later));projected=projectCooking(doc);assert.equal(projected.shopping.items[0].purchaseCycleId,'cycle2');assert.equal(projected.shopping.items[0].checked,false);assert.equal(projected.shopping.items[0].purchasedCycleId,undefined);save(setShoppingItemChecked(shopping,'item','cycle2',true,later));const second=applyShoppingPurchase(shopping,pantry,{id:'purchase2',listId:'list',purchaseCycleId:'cycle2',purchasedAt:later});save(second.shopping,second.pantry);assert.deepEqual(projectCooking(doc).shopping.purchases.map(x=>x.id),['purchase','purchase2']);save(removeShoppingItem(shopping,'item',later));save(removeShoppingList(shopping,'list',later));projected=projectCooking(doc);assert.equal(projected.shopping.items[0].removedAt,later);assert.equal(projected.shopping.lists[0].removedAt,later);const removed=projectCurrentSeed({LoroDoc,source:doc.export({mode:'snapshot'}),seedId:'removed',peerId:'20',schemaVersion:4}),clean=new LoroDoc();clean.import(removed.snapshot);assert.deepEqual(projectCooking(clean).shopping.items,[]);assert.deepEqual(projectCooking(clean).shopping.lists,[])});
test('concurrent item name and quantity edits preserve both intentions',()=>{const first=new LoroDoc();first.setPeerId('21');const command=(kind,id,data,deps=[])=>({version:1,kind,commandId:id,effectId:id,dependencyEffectIds:deps,data});const list=command('shopping-list-create','list',{listId:'l',cycleId:'c',name:'Market',at}),item=command('shopping-item-create','item',{listId:'l',cycleId:'c',itemId:'i',name:'Rice',checked:false,recipeId:null,ingredientId:null,displayQuantity:'1',displayUnit:null,author:'a',at},['list']);for(const c of [list,item]){checkPreconditions(first,c);apply(first,c)}const second=first.fork();second.setPeerId('22');const name=command('shopping-item-field','name',{listId:'l',cycleId:'c',itemId:'i',field:'name',value:'Brown rice',author:'a',at},['list','item']),quantity=command('shopping-item-field','quantity',{listId:'l',cycleId:'c',itemId:'i',field:'displayQuantity',value:'2',author:'b',at},['list','item']);for(const [doc,c] of [[first,name],[second,quantity]]){checkPreconditions(doc,c);apply(doc,c)}first.import(second.export({mode:'snapshot'}));second.import(first.export({mode:'snapshot'}));for(const doc of [first,second]){const item=projectCooking(doc).shopping.items[0];assert.equal(item.name,'Brown rice');assert.equal(item.displayQuantity,'2')}});

test('actual planner timestamp commands allow disjoint peer edits through compatibility checks',()=>{
 const first=new LoroDoc();first.setPeerId('31');
 let shopping=createShoppingList(emptyShoppingState(),{id:'list',cycleId:'cycle',name:'Market',at});
 shopping=appendShoppingItems(shopping,'list',[{id:'item',name:'Rice',displayQuantity:'1',at}]);
 for(const c of planShoppingAction({doc:first,before:emptyShoppingState(),after:shopping,pantryBefore:[],pantryAfter:[],actionId:'setup',author:'a',at})){checkPreconditions(first,c);apply(first,c)}
 const second=first.fork();second.setPeerId('32');
 const left=planShoppingAction({doc:first,before:shopping,after:updateShoppingItem(shopping,'item',{name:'Brown rice',displayQuantity:'1'},later),pantryBefore:[],pantryAfter:[],actionId:'name',author:'a',at:later});
 const right=planShoppingAction({doc:second,before:shopping,after:updateShoppingItem(shopping,'item',{name:'Rice',displayQuantity:'2'},'2026-01-03T00:00:00.000Z'),pantryBefore:[],pantryAfter:[],actionId:'quantity',author:'b',at:later});
 assert.ok(left.some(c=>c.data.field==='updatedAt'));assert.ok(right.some(c=>c.data.field==='updatedAt'));
 const admit=(doc,commands)=>{const causal=doc.fork();for(const c of commands){checkPreconditions(causal,c);apply(causal,c)}return causal};
 const leftDoc=admit(first,left),rightDoc=admit(second,right);
 for(const [receiver,commands] of [[leftDoc,right],[rightDoc,left]])for(const c of commands)checkShoppingCompatibility(receiver,c);
 leftDoc.import(rightDoc.export({mode:'snapshot'}));rightDoc.import(leftDoc.export({mode:'snapshot'}));
 for(const doc of [leftDoc,rightDoc]){const row=projectCooking(doc).shopping.items[0];assert.equal(row.name,'Brown rice');assert.equal(row.displayQuantity,'2')}
});

test('shopping field commands cannot remove or replace creation-time recipe links',()=>{
 for(const [field,value] of [['recipeId',null],['recipeId','other'],['ingredientId',null],['ingredientId','other']]){
  const doc=new LoroDoc(),before=doc.export({mode:'snapshot'}),command={version:1,kind:'shopping-item-field',commandId:'change',effectId:'change',dependencyEffectIds:[],data:{listId:'list',cycleId:'cycle',itemId:'item',field,value,author:'a',at}};
  assert.throws(()=>validate(command),/MALFORMED/);
  assert.deepEqual(doc.export({mode:'snapshot'}),before);
 }
});

test('buy again moves a rated pantry item to shopping and a purchase restores the rating',async()=>{
 const {planPantryAction}=await import('../app/pantry-actions.mjs');
 const {projectLocalCooking}=await import('./app-projection.mjs');
 const {buyAgainFromPantry}=await import('../../domain/shopping.ts');
 const doc=new LoroDoc();doc.setPeerId('21');let i=0;
 const commit=cmds=>{for(const c of cmds){checkPreconditions(doc,c);apply(doc,c)}};
 const rated=[{id:'p1',name:'Smoked paprika',preference:5,createdAt:at,updatedAt:at}];
 commit(planPantryAction({doc,before:[],after:rated,actionId:`a${++i}`,author:'a',at}));
 let shopping=emptyShoppingState(),pantry=rated;
 const save=(next,nextPantry)=>{commit(planShoppingAction({doc,before:shopping,after:next,pantryBefore:pantry,pantryAfter:nextPantry,actionId:`a${++i}`,author:'a',at:later}));shopping=next;pantry=nextPantry};
 const moved=buyAgainFromPantry(shopping,pantry,{},{pantryItemId:'p1',itemId:'item',newList:{id:'list',cycleId:'cycle',name:'Shopping list',at:later},at:later});
 assert.equal(moved.listName,'Shopping list');assert.deepEqual(moved.memory,{'smoked paprika':5});
 save(moved.shopping,moved.pantry);
 let local=projectLocalCooking(doc);
 assert.deepEqual(local.pantry,[]);assert.deepEqual(local.shopping.items.map(x=>x.name),['Smoked paprika']);
 assert.deepEqual(local.rememberedPantryPreferences,{'smoked paprika':5});
 assert.equal('rememberedPantryPreferences' in projectCooking(doc),false);
 const again=buyAgainFromPantry(shopping,[{id:'p2',name:'smoked  paprika',preference:3,createdAt:at,updatedAt:at}],moved.memory,{pantryItemId:'p2',itemId:'dup',newList:{id:'unused',cycleId:'unused',name:'x',at:later},at:later});
 assert.equal(again.alreadyListed,true);assert.equal(again.shopping.items.length,1);assert.deepEqual(again.memory,{});
 save(setShoppingItemChecked(shopping,'item','cycle',true,later),pantry);
 const purchase=applyShoppingPurchase(shopping,pantry,{id:'buy',listId:'list',purchaseCycleId:'cycle',purchasedAt:later},local.rememberedPantryPreferences);
 assert.equal(purchase.pantry[0].preference,5);
 save(purchase.shopping,purchase.pantry);
 local=projectLocalCooking(doc);
 assert.deepEqual(local.pantry.map(x=>[x.name,x.preference]),[['Smoked paprika',5]]);
 const reopened=new LoroDoc();reopened.import(doc.export({mode:'snapshot'}));assert.deepEqual(projectLocalCooking(reopened),local);
 assert.throws(()=>planShoppingAction({doc,before:shopping,after:shopping,pantryBefore:pantry,pantryAfter:[{...pantry[0],name:'Paprika'}],actionId:'bad',author:'a',at:later}),/UNSUPPORTED_EDIT/);
});
