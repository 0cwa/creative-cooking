import {test} from 'node:test';import assert from 'node:assert/strict';import {LoroDoc} from 'loro-crdt/nodejs';import {replayCommandsFixtureOnly} from './replay.mjs';import {recipeIntentions,apply} from './registry.mjs';
const at='2026-01-01T00:00:00Z',record=(kind,id,data,dependencyEffectIds=[])=>({authorDevice:'a',command:{version:1,kind,commandId:'cmd-'+id,effectId:id,dependencyEffectIds,data}});
test('bounded replay holds excluded ancestors and dependent work while retaining independent intentions',()=>{
 const create=record('recipe-create','create',{author:'a',at,recipe:{id:'r',title:'Soup',portions:2,ingredients:[],steps:[],stepIds:[]}}),x=record('recipe-field','x',{recipeId:'r',field:'title',value:'Stew',author:'a',at},['create']),y=record('recipe-field','y',{recipeId:'r',field:'title',value:'Broth',author:'a',at},['create']),child=record('recipe-field','child',{recipeId:'r',field:'title',value:'Spicy stew',author:'a',at},['create','x']);
 const result=replayCommandsFixtureOnly({LoroDoc,checkpoint:new Uint8Array(),records:[child,y,x,create],excludedEffectIds:['x']});
 assert.deepEqual(result.applied.map(x=>x.command.effectId),['create','y']);assert.deepEqual(result.held.map(x=>[x.command.effectId,x.reason]),[['x','EXCLUDED'],['child','DEPENDENCY_EXCLUDED']]);assert.deepEqual(recipeIntentions(result.doc,'r').map(x=>x.effectId),['y']);
 assert.throws(()=>replayCommandsFixtureOnly({LoroDoc,checkpoint:new Uint8Array(),records:[x,x]}),/CONFLICT/);assert.throws(()=>replayCommandsFixtureOnly({LoroDoc,checkpoint:new Uint8Array(),records:[{...x,authorDevice:'b'}]}),/INVALID_AUTHORITY/);
});

test('replay keeps concurrent purchase when a later cycle is listed first',()=>{
 const list=record('shopping-list-create','list',{listId:'l',cycleId:'c',name:'Market',at}),item=record('shopping-item-put','item',{listId:'l',cycleId:'c',itemId:'i',name:'Carrot',checked:true,at},['list']),next=record('shopping-cycle-start','next',{listId:'l',previousCycleId:'c',cycleId:'next',at},['list']),buy=record('purchase','buy',{id:'buy',listId:'l',purchaseCycleId:'c',itemIds:['i'],pantryItemIds:[],purchasedAt:at,author:'a'},['list','item']);
 const result=replayCommandsFixtureOnly({LoroDoc,checkpoint:new Uint8Array(),records:[next,buy,item,list]});assert.equal(result.held.length,0);assert.equal(result.doc.getMap('purchases').get('buy').id,'buy');
});

test('replay rejects reuse of a checkpoint command identity',()=>{
 const first=record('pantry-create','first',{itemId:'i',name:'A',preference:3,at,author:'a'}),second=record('pantry-create','second',{itemId:'j',name:'B',preference:3,at,author:'a'});second.command.commandId=first.command.commandId;
 const d=new LoroDoc();apply(d,first.command);const checkpoint=d.export({mode:'snapshot'});assert.throws(()=>replayCommandsFixtureOnly({LoroDoc,checkpoint,records:[second]}),/CONFLICT/);
 const exact=replayCommandsFixtureOnly({LoroDoc,checkpoint,records:[first]});assert.equal(exact.applied.length,1);assert.equal(exact.doc.getMap('pantry-index').get('i'),'first');
 const legacy=new LoroDoc();legacy.getMap('domain-effects').set('legacy',{touches:['pantry'],dependencyEffectIds:[]});assert.throws(()=>replayCommandsFixtureOnly({LoroDoc,checkpoint:legacy.export({mode:'snapshot'}),records:[]}),/INVALID_CHECKPOINT/);
});
