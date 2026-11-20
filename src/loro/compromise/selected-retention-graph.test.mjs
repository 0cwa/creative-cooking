import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedRetentionGraph} from './selected-retention-graph.mjs';

const entry=(effectId,deps=[],options={})=>({documentId:options.documentId??'root',recipeId:options.recipeId??null,evidence:{objectId:options.objectId??`object-${effectId}`,authorDevice:options.author??'honest',command:{effectId,commandId:options.commandId??`command-${effectId}`,dependencyEffectIds:deps,data:options.source?{recipeSource:options.source}:{}}}});
const rows=(evidence,selection)=>new Map(selectedRetentionGraph(evidence,selection,'suspect').map(row=>[row.objectId,row]));

test('retention propagates exclusions and missing dependencies while ordering unrelated work',()=>{
 const evidence=[entry('a',[],{author:'suspect'}),entry('b',['a']),entry('c',['b']),entry('d',['absent']),entry('e',['d']),entry('f'),entry('g',['f'])];
 const plan=rows(evidence,['b','c','d','e','f','g']);
 assert.equal(plan.get('object-a').status,'excluded');
 assert.equal(plan.get('object-a').authorship,'suspect');
 assert.equal(plan.get('object-b').reason,'EXCLUDED_DEPENDENCY');
 assert.equal(plan.get('object-b').authorship,'other');
 assert.equal(plan.get('object-c').reason,'HELD_DEPENDENCY');
 assert.equal(plan.get('object-d').reason,'MISSING_DEPENDENCY');
 assert.equal(plan.get('object-e').reason,'HELD_DEPENDENCY');
 assert.equal(plan.get('object-f').order,0);
 assert.equal(plan.get('object-g').order,1);
});

test('duplicate effect or command identities and their dependents are held',()=>{
 const evidence=[entry('a',[],{objectId:'one'}),entry('a',[],{objectId:'two'}),entry('b',['a']),entry('c',[],{commandId:'duplicate'}),entry('d',[],{commandId:'duplicate'}),entry('e',['c'])];
 const plan=rows(evidence,['a','b','c','d','e']);
 for(const id of ['one','two','object-c','object-d'])assert.equal(plan.get(id).reason,'AMBIGUOUS_ID');
 for(const id of ['object-b','object-e'])assert.equal(plan.get(id).reason,'HELD_DEPENDENCY');
});

test('cycles and their dependents are held and cross-document source routes are checked',()=>{
 const evidence=[entry('a',['b']),entry('b',['a']),entry('c',['a']),entry('x',[],{documentId:'other'}),entry('y',['x'],{source:{documentId:'recipe',effectIds:['x']}})];
 const plan=rows(evidence,['a','b','c','x','y']);
 assert.equal(plan.get('object-a').reason,'DEPENDENCY_CYCLE');
 assert.equal(plan.get('object-b').reason,'DEPENDENCY_CYCLE');
 assert.equal(plan.get('object-c').reason,'HELD_DEPENDENCY');
 assert.equal(plan.get('object-y').reason,'AMBIGUOUS_SOURCE');
 assert.equal(plan.get('object-x').status,'retained');
});

test('verified seed dependencies require unique identities and the same document route',()=>{
 const seeds=[{documentId:'child',identities:[{effectId:'seed',commandId:'seed-command'}]}];
 const evidence=[entry('ok',['seed'],{documentId:'child'}),entry('wrong',['seed']),entry('missing',['absent'],{documentId:'child'}),entry('collision',[],{commandId:'seed-command',documentId:'child'}),entry('dependent',['collision'],{documentId:'child'})];
 let plan=new Map(selectedRetentionGraph(evidence,evidence.map(x=>x.evidence.command.effectId),'suspect',undefined,seeds).map(row=>[row.effectId,row]));
 assert.equal(plan.get('collision').reason,'AMBIGUOUS_ID');assert.equal(plan.get('dependent').reason,'HELD_DEPENDENCY');
 assert.equal(plan.get('ok').reason,'MISSING_DEPENDENCY');assert.equal(plan.get('wrong').reason,'MISSING_DEPENDENCY');assert.equal(plan.get('missing').reason,'MISSING_DEPENDENCY');
 plan=new Map(selectedRetentionGraph(evidence.slice(0,3),['ok','wrong','missing'],'suspect',undefined,seeds).map(row=>[row.effectId,row]));
 assert.equal(plan.get('ok').status,'retained');assert.equal(plan.get('wrong').reason,'MISSING_DEPENDENCY');
 const collision=[entry('seed',[],{documentId:'child'}),entry('lookalike',['seed'],{documentId:'child'})];
 plan=new Map(selectedRetentionGraph(collision,['seed','lookalike'],'suspect',undefined,seeds).map(row=>[row.effectId,row]));
 assert.equal(plan.get('seed').reason,'AMBIGUOUS_ID');assert.equal(plan.get('lookalike').reason,'HELD_DEPENDENCY');
});

test('a shopping copy can depend on a seed only in the pinned recipe document',()=>{
 const seeds=[{documentId:'child',identities:[{effectId:'seed',commandId:'seed-command'}]}];
 const copy=entry('copy',['seed'],{source:{documentId:'child',effectIds:['seed']}});
 copy.evidence.command.data.recipeId='recipe';
 assert.equal(selectedRetentionGraph([copy],['copy'],'suspect',new Map([['recipe','child']]),seeds)[0].status,'retained');
 assert.equal(selectedRetentionGraph([copy],['copy'],'suspect',new Map([['recipe','sibling']]),seeds)[0].reason,'AMBIGUOUS_SOURCE');
});
