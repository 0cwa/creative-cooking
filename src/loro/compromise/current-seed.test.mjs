import {test} from 'node:test';import assert from 'node:assert/strict';import {LoroDoc} from 'loro-crdt/nodejs';import {apply} from '../domain/registry.mjs';import {projectCurrentSeed,verifyCurrentSeed} from './current-seed.mjs';
const at='2026-01-01T00:00:00Z',cmd=(kind,effectId,data,dependencyEffectIds=[])=>({version:1,kind,commandId:effectId,effectId,dependencyEffectIds,data});
test('current seed contains only live schema and reserves current purchase identities',()=>{const source=new LoroDoc();source.setPeerId('1');apply(source,cmd('recipe-create','recipe',{recipe:{id:'r',title:'SOUP_CANARY',portions:2,ingredients:[{id:'i',name:'REMOVED_INGREDIENT'}],steps:['REMOVED_STEP'],stepIds:['s']},author:'a',at}));apply(source,cmd('recipe-field','title',{recipeId:'r',field:'title',value:'Stew',author:'a',at},['recipe']));apply(source,cmd('recipe-ingredient-field','remove-i',{recipeId:'r',ingredientId:'i',field:'removed',value:true,author:'a',at},['recipe']));apply(source,cmd('recipe-step-field','remove-s',{recipeId:'r',stepId:'s',field:'removed',value:true,author:'a',at},['recipe']));apply(source,cmd('recipe-ingredient-add','live-i',{recipeId:'r',ingredientId:'i2',name:'Carrot',amount:'2',needsShopping:true,position:0,author:'a',at},['recipe']));apply(source,cmd('pantry-create','pantry-old',{itemId:'old',name:'REMOVED_PANTRY',preference:3,at,author:'a'}));apply(source,cmd('pantry-field','pantry-remove',{itemId:'old',field:'removedAt',value:at,at,author:'a'},['pantry-old']));apply(source,cmd('pantry-create','pantry-live',{itemId:'live',name:'Rice',preference:3,at,author:'a'}));apply(source,cmd('shopping-list-create','list',{listId:'l',cycleId:'old-cycle',name:'Market',at}));apply(source,cmd('shopping-cycle-start','cycle',{listId:'l',previousCycleId:'old-cycle',cycleId:'current-cycle',at},['list']));apply(source,cmd('shopping-item-put','item',{listId:'l',cycleId:'current-cycle',itemId:'item',name:'Carrot',checked:true,at},['cycle']));apply(source,cmd('purchase','buy',{id:'buy',listId:'l',purchaseCycleId:'current-cycle',itemIds:['item'],pantryItemIds:[],purchasedAt:at,author:'a'},['cycle','item']));apply(source,cmd('purchase','buy2',{id:'buy2',listId:'l',purchaseCycleId:'current-cycle',itemIds:['item'],pantryItemIds:[],purchasedAt:at,author:'b'},['cycle','item']));source.getMap('private').set('secret','PRIVATE_CANARY');source.getMap('private').set('oldKey','OLD_KEY_CANARY');const seed=projectCurrentSeed({LoroDoc,source:source.export({mode:'snapshot'}),seedId:'test',peerId:'999'}),fresh=new LoroDoc();fresh.import(seed.snapshot);verifyCurrentSeed({LoroDoc,snapshot:seed.snapshot,seed:{seedId:seed.seedId,identities:seed.identities}});const messageDoc=new LoroDoc();messageDoc.setPeerId('998');const seedState=fresh.toJSON();for(const name of Object.keys(seedState).sort())for(const key of Object.keys(seedState[name]).sort())messageDoc.getMap(name).set(key,seedState[name][key]);messageDoc.commit({message:'PRIVATE_CHANGE_MESSAGE_CANARY'});assert.ok(JSON.stringify(messageDoc.exportJsonUpdates(undefined,undefined,false)).includes('PRIVATE_CHANGE_MESSAGE_CANARY'));assert.throws(()=>verifyCurrentSeed({LoroDoc,snapshot:messageDoc.export({mode:'snapshot'}),seed:{seedId:seed.seedId,identities:seed.identities}}),/INVALID_SEED/);const forged=new LoroDoc();forged.import(seed.snapshot);forged.setPeerId('999');forged.getMap('recipe:r').set('title','HIDDEN_CANARY');forged.commit();forged.getMap('recipe:r').set('title','Stew');assert.throws(()=>verifyCurrentSeed({LoroDoc,snapshot:forged.export({mode:'snapshot'}),seed:{seedId:seed.seedId,identities:seed.identities}}),/INVALID_SEED/);assert.throws(()=>verifyCurrentSeed({LoroDoc,snapshot:seed.snapshot,seed:{seedId:seed.seedId,identities:[]}}),/INVALID_SEED/);assert.deepEqual(projectCurrentSeed({LoroDoc,source:source.export({mode:'snapshot'}),seedId:'test',peerId:'999'}).snapshot,seed.snapshot);const history=JSON.stringify(fresh.exportJsonUpdates(undefined,undefined,false));for(const canary of ['SOUP_CANARY','REMOVED_INGREDIENT','REMOVED_STEP','REMOVED_PANTRY','PRIVATE_CANARY','OLD_KEY_CANARY','old-cycle'])assert.equal(history.includes(canary),false,canary);assert.equal(fresh.getMap('recipe:r').get('title'),'Stew');assert.equal(fresh.getMap('recipe-ingredient:%5B%22r%22%2C%22i2%22%5D').get('name'),'Carrot');assert.equal(fresh.getMap('pantry:live').get('name'),'Rice');assert.equal(fresh.getMap('shopping-list:l').get('currentCycleId'),'current-cycle');assert.equal(fresh.getMap('purchases').get('buy').id,'buy');assert.equal(fresh.getMap('purchases').get('buy2').id,'buy2');assert.ok(seed.identities.some(x=>x.effectId==='buy'&&x.commandId==='buy'));const reseeded=projectCurrentSeed({LoroDoc,source:seed.snapshot,seedId:'second',peerId:'998'}),again=new LoroDoc();again.import(reseeded.snapshot);assert.equal(again.getMap('purchases').get('buy').id,'buy');assert.ok(reseeded.identities.some(x=>x.effectId==='buy'&&x.commandId==='buy'));verifyCurrentSeed({LoroDoc,snapshot:reseeded.snapshot,seed:{seedId:reseeded.seedId,identities:reseeded.identities}});assert.equal(fresh.oplogVersion().toJSON().has('1'),false)});

test('v4 seed rejects invalid values even with one insert per field', () => {
  const source = new LoroDoc();
  source.setPeerId('1');
  const recipe = {id:'r',title:'Stew',portions:2,notes:['Serve warm'],ingredients:[{id:'i',name:'Carrot'}],steps:['Chop'],stepIds:['s']};
  apply(source, cmd('recipe-create','recipe',{recipe,author:'a',at}));
  apply(source, cmd('shopping-list-create','list',{listId:'l',cycleId:'cycle',name:'Market',at}));
  apply(source, cmd('shopping-item-put','item',{listId:'l',cycleId:'cycle',itemId:'item',name:'Carrot',checked:true,at},['list']));
  const pantryId = 'shopping-purchase:buy:item';
  apply(source, cmd('purchase','buy',{
    id:'buy',listId:'l',purchaseCycleId:'cycle',itemIds:['item'],
    pantryItemIds:[pantryId],pantryItems:[{id:pantryId,itemId:'item',name:'Carrot'}],purchasedAt:at,author:'a',
  },['list','item']));

  const options = {LoroDoc,schemaVersion:4};
  const seed = projectCurrentSeed({...options,source:source.export({mode:'snapshot'}),seedId:'typed',peerId:'999'});
  verifyCurrentSeed({...options,seed,snapshot:seed.snapshot});
  const projected = new LoroDoc();
  projected.import(seed.snapshot);
  const state = projected.toJSON();
  assert.deepEqual(state.purchases.buy.pantryItemIds,[pantryId]);
  assert.equal(state.purchases.buy.pantryItems,undefined);

  const container = (prefix,id) => prefix + ':' + encodeURIComponent(id);
  const ingredient = container('recipe-ingredient',JSON.stringify(['r','i']));
  const step = container('recipe-step',JSON.stringify(['r','s']));
  const hidden = {old:'previous private value'};
  const item = state['shopping-item:item'].value;
  const malformed = [
    ['recipe title', s => { s['recipe:r'].title = hidden; }],
    ['recipe note', s => { s['recipe:r'].notes = [hidden]; }],
    ['ingredient name', s => { s[ingredient].name = hidden; }],
    ['step position', s => { s[step].position = hidden; }],
    ['pantry preference', s => { s[container('pantry',pantryId)].preference = hidden; }],
    ['shopping list name', s => { s['shopping-list:l'].name = hidden; }],
    ['shopping cycle date', s => { s['shopping-cycles'].cycle.startedAt = hidden; }],
    ['shopping item name', s => {
      s['shopping-item:item'].value.name = hidden;
      s['shopping-item-versions'][item.effectId].name = hidden;
    }],
    ['purchase pantry IDs', s => { s.purchases.buy.pantryItemIds = [hidden]; }],
    ['purchase author', s => { s.purchases.buy.author = hidden; }],
  ];
  for (const [label, change] of malformed) {
    const changed = structuredClone(state);
    change(changed);
    const forged = new LoroDoc();
    forged.setPeerId(seed.peerId);
    for (const [name, fields] of Object.entries(changed)) {
      for (const [key, value] of Object.entries(fields)) forged.getMap(name).set(key,value);
    }
    assert.throws(() => verifyCurrentSeed({...options,seed,snapshot:forged.export({mode:'snapshot'})}),
      {message:'INVALID_SEED'},label);
  }
});
