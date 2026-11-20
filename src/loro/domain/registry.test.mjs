import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LoroDoc} from 'loro-crdt/nodejs';
import {apply,validateOperations,bytes} from './registry.mjs';
const command=(kind,id,data)=>({version:1,kind,commandId:`c-${id}`,effectId:id,dependencyEffectIds:[],data});
const purchase=id=>command('purchase',id,{id,listId:'list',purchaseCycleId:'cycle',itemIds:['item'],pantryItemIds:[],purchasedAt:'2026-11-17T00:00:00Z',author:id});
test('independent purchase events survive concurrent merge and snapshot reopen',()=>{
 const a=new LoroDoc(),b=new LoroDoc(); a.setPeerId('1'); b.setPeerId('2');
 for (const [doc,c] of [[a,purchase('a')],[b,purchase('b')]]) {const before=doc.oplogVersion();apply(doc,c);validateOperations(c,doc.exportJsonUpdates(before,undefined,false).changes);}
 a.import(b.export({mode:'update'})); b.import(a.export({mode:'update'}));
 const reopened=new LoroDoc();reopened.import(a.export({mode:'snapshot'}));
 assert.deepEqual(Object.keys(reopened.getMap('purchases').toJSON()).sort(),['a','b']);
 assert.deepEqual(a.getMap('purchases').toJSON(),b.getMap('purchases').toJSON());
});
test('competing recipe values keep both intentions and reject a forged operation',()=>{
 const a=new LoroDoc(),b=new LoroDoc();a.setPeerId('1');b.setPeerId('2');
 const make=(id,value)=>command('recipe-field',id,{recipeId:'r',field:'title',value,author:id,at:'2026-11-17T00:00:00Z'});
 for(const [doc,c] of [[a,make('a','Soup')],[b,make('b','Stew')]]) {const before=doc.oplogVersion();apply(doc,c);const changes=doc.exportJsonUpdates(before,undefined,false).changes;validateOperations(c,changes);assert.throws(()=>validateOperations(make('x','forged'),changes));}
 a.import(b.export({mode:'update'}));assert.equal(Object.keys(a.getMap('recipe-intentions:r').toJSON()).length,2);
 assert.deepEqual(bytes({b:2,a:1}),bytes({a:1,b:2}));
});
