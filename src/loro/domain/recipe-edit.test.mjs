import {test} from 'node:test';import assert from 'node:assert/strict';
import {LoroDoc} from 'loro-crdt/nodejs';
import {apply,validateOperations} from './registry.mjs';
const command=(kind,effectId,data)=>({version:1,kind,commandId:'cmd-'+effectId,effectId,dependencyEffectIds:[],data:{recipeId:'r',author:'a',at:'2026-01-01T00:00:00Z',...data}});
test('stable ingredient and step edits preserve concurrent field intentions',()=>{
 const a=new LoroDoc();a.setPeerId('1');const b=new LoroDoc();b.setPeerId('2');
 const x=command('recipe-ingredient-field','x',{ingredientId:'i',field:'name',value:'Carrot'}),y=command('recipe-ingredient-field','y',{ingredientId:'i',field:'amount',value:'2'}),z=command('recipe-step-field','z',{stepId:'s',field:'text',value:'Chop'});
 const before=a.oplogVersion();apply(a,x);validateOperations(x,a.exportJsonUpdates(before,undefined,false).changes);apply(a,z);apply(b,y);a.import(b.export({mode:'snapshot'}));
 assert.equal(Object.keys(a.getMap('recipe-intentions:r').toJSON()).length,3);
 const restored=new LoroDoc();restored.import(a.export({mode:'snapshot'}));assert.equal(Object.keys(restored.getMap('recipe-intentions:r').toJSON()).length,3);
});
test('recipe creation and member additions require their causal identities',async()=>{
 const {checkPreconditions}=await import('./registry.mjs'),doc=new LoroDoc(),at='2026-01-01T00:00:00Z';
 const create={version:1,kind:'recipe-create',commandId:'create',effectId:'create',dependencyEffectIds:[],data:{author:'a',at,recipe:{id:'r',title:'Soup',portions:2,ingredients:[{id:'i',name:'Carrot'}],steps:['Chop'],stepIds:['s'],createdAt:at,updatedAt:at}}};
 const add={version:1,kind:'recipe-step-add',commandId:'add',effectId:'add',dependencyEffectIds:['create'],data:{recipeId:'r',stepId:'s2',text:'Serve',position:1,author:'a',at}};
 assert.throws(()=>checkPreconditions(doc,add),/MISSING_DEPENDENCY/);checkPreconditions(doc,create);const before=doc.oplogVersion();apply(doc,create);validateOperations(create,doc.exportJsonUpdates(before,undefined,false).changes);
 assert.equal(doc.getMap('recipe:r').get('ingredients'),undefined);assert.equal(doc.getMap('recipe-ingredient-index:r').get('i'),'create');checkPreconditions(doc,add);apply(doc,add);
 const edit={version:1,kind:'recipe-step-field',commandId:'edit',effectId:'edit',dependencyEffectIds:['create','add'],data:{recipeId:'r',stepId:'s2',field:'text',value:'Serve hot',author:'a',at}};
 assert.throws(()=>checkPreconditions(doc,{...edit,dependencyEffectIds:['create']}),/MISSING_DEPENDENCY/);checkPreconditions(doc,edit);apply(doc,edit);assert.throws(()=>checkPreconditions(doc,add),/CONFLICT/);
});
