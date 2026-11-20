import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {projectCooking} from './app-projection.mjs';
const require=createRequire(import.meta.url);
const {LoroDoc}=require('loro-crdt');
const {apply}=await import('./registry.mjs');
const at='2026-01-01T00:00:00Z';
const command=(kind,id,data,deps=[])=>({version:1,kind,commandId:id,effectId:id,dependencyEffectIds:deps,data});
test('projects current recipe, pantry and independent purchases after snapshot reopen',()=>{
 const doc=new LoroDoc();doc.setPeerId('1');
 apply(doc,command('recipe-create','r1',{recipe:{id:'r',title:'Soup',portions:2,ingredients:[{id:'i',name:'Carrot'}],steps:['Chop'],stepIds:['s']},author:'a',at}));
 apply(doc,command('recipe-ingredient-field','r2',{recipeId:'r',ingredientId:'i',field:'amount',value:'2',author:'a',at},['r1']));
 apply(doc,command('shopping-list-create','l1',{listId:'l',cycleId:'c',name:'Market',at}));
 apply(doc,command('shopping-item-put','i1',{listId:'l',cycleId:'c',itemId:'i',name:'Carrot',checked:true,at},['l1']));
 for(const id of ['p1','p2'])apply(doc,command('purchase',id,{id,listId:'l',purchaseCycleId:'c',itemIds:['i'],pantryItemIds:[],purchasedAt:at,author:'a'},['l1','i1']));
 const reopened=new LoroDoc();reopened.import(doc.export({mode:'snapshot'}));const result=projectCooking(reopened);
 assert.equal(result.recipes[0].ingredients[0].amount,'2');assert.deepEqual(result.recipes[0].stepIds,['s']);assert.equal(result.shopping.items[0].checked,true);assert.deepEqual(result.shopping.purchases.map(p=>p.id),['p1','p2']);
});
