import {test} from 'node:test'; import assert from 'node:assert/strict';
import {LoroDoc} from 'loro-crdt/nodejs';
import {checkPreconditions,apply} from './registry.mjs';
const mk=(kind,effectId,data,dependencyEffectIds=[])=>({version:1,kind,commandId:'cmd-'+effectId,effectId,dependencyEffectIds,data});
const run=(d,c)=>{checkPreconditions(d,c);apply(d,c)};
test('cycle guards, independent physical purchases and append-only correction',()=>{
 const a=new LoroDoc();a.setPeerId('1');const at='2026-01-01T00:00:00Z';
 run(a,mk('shopping-list-create','list',{listId:'l',cycleId:'c',name:'Market',at}));
 run(a,mk('shopping-item-put','item',{listId:'l',cycleId:'c',itemId:'i',name:'Flour',checked:true,at},['list']));
 const b=new LoroDoc();b.setPeerId('2');b.import(a.export({mode:'snapshot'}));
 const purchase=id=>{const pantryId=`shopping-purchase:${id}:i`;return mk('purchase',id,{id,listId:'l',purchaseCycleId:'c',itemIds:['i'],pantryItemIds:[pantryId],pantryItems:[{id:pantryId,itemId:'i',name:'Flour'}],purchasedAt:at,author:'a'},['list','item']);};
 run(a,purchase('p1'));run(b,purchase('p2'));a.import(b.export({mode:'snapshot'}));
 assert.deepEqual(Object.keys(a.getMap('purchases').toJSON()).sort(),['p1','p2']);assert.deepEqual(Object.keys(a.getMap('pantry-index').toJSON()).sort(),['shopping-purchase:p1:i','shopping-purchase:p2:i']);
 run(a,mk('purchase-correction','fix',{purchaseId:'p1',reason:'wrong quantity',at,author:'a'},['p1']));
 assert.equal(a.getMap('purchases').get('p1').id,'p1');assert.equal(a.getMap('purchase-corrections').get('fix').purchaseId,'p1');
 run(a,mk('shopping-cycle-start','new',{listId:'l',previousCycleId:'c',cycleId:'c2',at},['list']));
 assert.throws(()=>checkPreconditions(a,purchase('p3')),/STALE_CYCLE/);
});

test('purchase requires the current checked item and its current name',()=>{
 const d=new LoroDoc(),at='2026-01-01T00:00:00Z';
 run(d,mk('shopping-list-create','list',{listId:'l',cycleId:'c',name:'Market',at}));
 run(d,mk('shopping-item-put','checked',{listId:'l',cycleId:'c',itemId:'i',name:'Old',checked:true,at},['list']));
 run(d,mk('shopping-item-put','unchecked',{listId:'l',cycleId:'c',itemId:'i',name:'New',checked:false,at},['list','checked']));
 const buy=mk('purchase','buy',{id:'buy',listId:'l',purchaseCycleId:'c',itemIds:['i'],pantryItemIds:['shopping-purchase:buy:i'],pantryItems:[{id:'shopping-purchase:buy:i',itemId:'i',name:'Old'}],purchasedAt:at,author:'a'},['list','checked']);
 assert.throws(()=>checkPreconditions(d,buy),/MISSING_DEPENDENCY/);
});
