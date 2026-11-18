// Current-state seed codec. Old operation payloads never enter output.
import {validate} from '../domain/registry.mjs';

const own=(x,k)=>Object.hasOwn(x,k),isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):isObject(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const pick=(x,keys)=>Object.fromEntries(keys.filter(k=>own(x,k)).map(k=>[k,structuredClone(x[k])]));
const mapName=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
const validId=x=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=256;
const text=x=>typeof x==='string';
const nonemptyText=x=>text(x)&&x.trim().length>0;
const date=x=>text(x)&&Number.isFinite(Date.parse(x));
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const ids=x=>Array.isArray(x)&&x.every(nonemptyText)&&new Set(x).size===x.length;
const scalarMaps=[
 ['recipe:',{title:nonemptyText,description:text,portions:x=>integer(x)&&x>0,notes:x=>Array.isArray(x)&&x.every(text),createdAt:date,updatedAt:date}],
 ['recipe-ingredient:',{name:nonemptyText,amount:text,needsShopping:x=>typeof x==='boolean',position:integer}],
 ['recipe-step:',{text:nonemptyText,position:integer}],
 ['pantry:',{name:nonemptyText,preference:x=>integer(x)&&x>=1&&x<=5,createdAt:date,updatedAt:date}],
 ['shopping-list:',{name:nonemptyText,currentCycleId:nonemptyText}],
];
/** Input must be an authenticated local draft. Reject unknown schema rather than copying it. */
export function projectCurrentSeed({LoroDoc,source,seedId,peerId,includeLocalMapping=false,schemaVersion=1,omittedRecipeIds=[]}){
 if(typeof LoroDoc!=='function'||!(source instanceof Uint8Array)||source.length>1024*1024||!validId(seedId)||!/^([1-9][0-9]*)$/.test(peerId)||BigInt(peerId)>18446744073709551615n)throw Error('INVALID_SEED');
 if(![1,4].includes(schemaVersion))throw Error('UNSUPPORTED_VERSION');const old=new LoroDoc();old.import(source);if(old.oplogVersion().toJSON().has(peerId))throw Error('INVALID_SEED_PEER');const state=old.toJSON(),markers=old.getMap('domain-effects').toJSON(),ops=[],required=new Map(),purchaseIds=new Set(),live=new Set();
 const marker=(oldEffect,preserve=false)=>{if(!validId(oldEffect)||!markers[oldEffect])throw Error('MISSING_SEED_IDENTITY');let m=required.get(oldEffect);if(!m){const original=markers[oldEffect];const originalCommand=original.version===2&&original.command?.effectId===oldEffect?original.command.commandId:original.version===3&&original.effectId===oldEffect?original.commandId:null;if(!validId(originalCommand))throw Error('UNSUPPORTED_SEED_SOURCE');m={oldEffect,commandId:preserve?originalCommand:null,preserve};required.set(oldEffect,m)}else if(preserve){m.preserve=true;m.commandId=markers[oldEffect].version===2?markers[oldEffect].command.commandId:markers[oldEffect].commandId}return oldEffect};
 const put=(container,key,value)=>{if(!validId(container)||!validId(key)||value===undefined)throw Error('INVALID_SEED');ops.push({container,key,value:structuredClone(value)});if(ops.length>16384)throw Error('TOO_LARGE')};
 if(isObject(state.recipe)&&Object.keys(state.recipe).length)throw Error('UNSUPPORTED_SOURCE_SCHEMA');
 const recipeIndex=state['recipe-index']??{};if(!isObject(recipeIndex))throw Error('INVALID_SEED');for(const id of Object.keys(recipeIndex).sort()){const map=state[mapName('recipe',id)];if(!isObject(map))throw Error('INVALID_SEED_SOURCE');if(map.removed===true||map.removedAt)continue;live.add(JSON.stringify(['recipe',id]));put('recipe-index',id,{seedRef:marker(recipeIndex[id])});for(const [k,v]of Object.entries(pick(map,['title','description','portions','notes','createdAt','updatedAt'])))put(mapName('recipe',id),k,v);
  for(const [kind,fields] of [['ingredient',['name','amount','needsShopping','position']],['step',['text','position']]]){const indexName=mapName('recipe-'+kind+'-index',id),index=state[indexName]??{};if(!isObject(index))throw Error('INVALID_SEED');for(const memberId of Object.keys(index).sort()){const pair=JSON.stringify([id,memberId]),member=state[mapName('recipe-'+kind,pair)];if(!isObject(member))throw Error('INVALID_SEED_SOURCE');if(member.removed===true||member.removedAt)continue;live.add(JSON.stringify([kind,pair]));put(indexName,memberId,{seedRef:marker(index[memberId])});for(const [k,v]of Object.entries(pick(member,fields)))put(mapName('recipe-'+kind,pair),k,v)}}
 }
 const pantryIndex=state['pantry-index']??{};if(!isObject(pantryIndex))throw Error('INVALID_SEED');for(const id of Object.keys(pantryIndex).sort()){const p=state[mapName('pantry',id)];if(!isObject(p))throw Error('INVALID_SEED_SOURCE');if(p.removed===true||p.removedAt)continue;live.add(JSON.stringify(['pantry',id]));put('pantry-index',id,{seedRef:marker(pantryIndex[id])});for(const [k,v]of Object.entries(pick(p,['name','preference','createdAt','updatedAt'])))put(mapName('pantry',id),k,v)}
 for(const [name,value] of Object.entries(state)){if(!isObject(value)||Object.keys(value).length===0)continue;if(name.startsWith('recipe:')){let entity;try{entity=decodeURIComponent(name.slice(7))}catch{throw Error('INVALID_SEED_SOURCE')}if(!own(recipeIndex,entity))throw Error('INVALID_SEED_SOURCE')}if(name.startsWith('pantry:')){let entity;try{entity=decodeURIComponent(name.slice(7))}catch{throw Error('INVALID_SEED_SOURCE')}if(!own(pantryIndex,entity))throw Error('INVALID_SEED_SOURCE')}}
 if(schemaVersion<4&&Object.keys(state).some(name=>name.startsWith('shopping-item-fields:')&&Object.keys(state[name]??{}).length||name.startsWith('shopping-list:')&&Object.keys(state[name]??{}).some(k=>!['name','currentCycleId'].includes(k))))throw Error('UNSUPPORTED_SEED_SOURCE');const cycles=state['shopping-cycles']??{},currentCycles=new Set();if(!isObject(cycles))throw Error('INVALID_SEED');for(const name of Object.keys(state).sort())if(name.startsWith('shopping-list:')){const list=state[name];if(isObject(list)&&Object.keys(list).length===0)continue;if(!isObject(list)||!validId(list.currentCycleId)||typeof list.name!=='string')throw Error('INVALID_SEED_SOURCE');if(schemaVersion===4&&list.removedAt)continue;const cycle=cycles[list.currentCycleId];if(!isObject(cycle)||!validId(cycle.effectId))throw Error('INVALID_SEED');let listId;try{listId=decodeURIComponent(name.slice('shopping-list:'.length))}catch{throw Error('INVALID_SEED')}if(cycle.listId!==listId)throw Error('INVALID_SEED');if(schemaVersion===4)live.add(JSON.stringify(['shopping-list',listId]));currentCycles.add(list.currentCycleId);put(name,'name',list.name);put(name,'currentCycleId',list.currentCycleId);put('shopping-cycles',list.currentCycleId,{...pick(cycle,['listId','startedAt']),effectId:{seedRef:marker(cycle.effectId)}})}
 const omitted=new Set(omittedRecipeIds),projectedShoppingFields=new Map();
 for(const name of Object.keys(state).sort())if(name.startsWith('shopping-item:')){
  const v=state[name]?.value;
  if(!isObject(v))continue;
  const extra=state[mapName('shopping-item-fields',v.itemId)]??{},list=state[mapName('shopping-list',v.listId)];
  const cycle=schemaVersion===4?list?.currentCycleId:v.cycleId;
  if(!currentCycles.has(cycle)||schemaVersion===4&&extra.removedAt)continue;
  const copy=pick(v,['listId','cycleId','itemId','name','checked','at']);
  let baseEffect=v.effectId;
  if(schemaVersion===4){
   copy.cycleId=cycle;
   if(v.cycleId!==cycle)copy.checked=false;
   if(typeof extra.name==='string'){
    copy.name=extra.name;
    const head=state[mapName('field-head',JSON.stringify(['shopping-item',v.itemId,'name']))]?.effect;
    if(!head)throw Error('INVALID_SEED_SOURCE');
    baseEffect=head;
   }
   if(extra.checked?.cycleId===cycle)copy.checked=extra.checked.value;
   if(typeof extra.updatedAt==='string')copy.at=extra.updatedAt;
   live.add(JSON.stringify(['shopping-item',v.itemId]));
   const fields=pick(extra,['name','checked','recipeId','ingredientId','displayQuantity','displayUnit','updatedAt']);
   if(fields.checked?.cycleId!==cycle)delete fields.checked;
   if(validId(fields.recipeId)&&(omitted.has(fields.recipeId)||own(recipeIndex,fields.recipeId)&&!live.has(JSON.stringify(['recipe',fields.recipeId])))){
    delete fields.recipeId;
    delete fields.ingredientId;
   }
   projectedShoppingFields.set(v.itemId,fields);
   for(const [field,value] of Object.entries(fields))put(mapName('shopping-item-fields',v.itemId),field,value);
  }
  copy.effectId={seedRef:marker(baseEffect)};
  put(name,'value',copy);
  put('shopping-item-versions',baseEffect,{...copy,oldKey:baseEffect});
 }
 const purchases=state.purchases??{};if(!isObject(purchases))throw Error('INVALID_SEED');for(const id of Object.keys(purchases).sort()){const p=purchases[id];if(!isObject(p)||p.id!==id||!validId(p.purchaseCycleId))throw Error('INVALID_SEED_SOURCE');if(!currentCycles.has(p.purchaseCycleId))continue;purchaseIds.add(id);marker(id,true);const currentPurchase=pick(p,['id','listId','purchaseCycleId','itemIds','pantryItemIds','purchasedAt','author']);if(Array.isArray(currentPurchase.pantryItemIds))currentPurchase.pantryItemIds=currentPurchase.pantryItemIds.filter(pantryId=>live.has(JSON.stringify(['pantry',pantryId])));put('purchases',id,currentPurchase)}
 for(const name of Object.keys(state).sort())if(name.startsWith('field-head:')){
  let tuple;try{tuple=JSON.parse(decodeURIComponent(name.slice('field-head:'.length)))}catch{throw Error('INVALID_SEED')}
  if(!Array.isArray(tuple)||tuple.length!==3||!live.has(JSON.stringify(tuple.slice(0,2))))continue;
  const [kind,id,field]=tuple;
  if(schemaVersion===4&&(kind==='shopping-list'||kind==='shopping-item'&&!own(projectedShoppingFields.get(id)??{},field)))continue;
  const effect=state[name]?.effect;
  if(effect)put(name,'effect',{seedRef:marker(effect)});
 }
 if(required.size>256)throw Error('TOO_LARGE');
 const sorted=[...required.values()].sort((a,b)=>includeLocalMapping?(a.oldEffect<b.oldEffect?-1:a.oldEffect>b.oldEffect?1:0):a.oldEffect.localeCompare(b.oldEffect)),ids=new Map(),reserved=[];for(let i=0;i<sorted.length;i++){const m=sorted[i],effectId=m.preserve?m.oldEffect:`seed:${seedId}:${i}`,commandId=m.preserve?m.commandId:`seed-command:${seedId}:${i}`;if(!validId(effectId)||!validId(commandId))throw Error('INVALID_SEED');ids.set(m.oldEffect,effectId);reserved.push({effectId,commandId})}
 if(new Set(reserved.map(x=>x.effectId)).size!==reserved.length||new Set(reserved.map(x=>x.commandId)).size!==reserved.length)throw Error('SEED_ID_CONFLICT');
 const rewrite=x=>Array.isArray(x)?x.map(rewrite):isObject(x)?(Object.keys(x).length===1&&own(x,'seedRef')?ids.get(x.seedRef):Object.fromEntries(Object.entries(x).map(([k,v])=>[k,rewrite(v)]))):x;
 const doc=new LoroDoc();doc.setPeerId(peerId);for(const o of ops.sort((a,b)=>includeLocalMapping?((a.container<b.container?-1:a.container>b.container?1:0)||(a.key<b.key?-1:a.key>b.key?1:0)):(a.container.localeCompare(b.container)||a.key.localeCompare(b.key)))){const key=o.container==='shopping-item-versions'?ids.get(o.value.oldKey):o.key,value=rewrite(o.value);if(o.container==='shopping-item-versions')delete value.oldKey;doc.getMap(o.container).set(key,canonical(value))}for(const x of reserved)doc.getMap('domain-effects').set(x.effectId,{version:3,seedId,commandId:x.commandId,effectId:x.effectId});
 const snapshot=doc.export({mode:'snapshot'});if(snapshot.length>1024*1024)throw Error('TOO_LARGE');return {version:1,seedId,peerId,snapshot,identities:reserved,purchaseIds:[...purchaseIds].sort(),...(includeLocalMapping?{localMapping:sorted.map(m=>({oldEffectId:m.oldEffect,effectId:ids.get(m.oldEffect)}))}:{})};
}
/** Verify a stored seed has exactly one insert per visible field and no hidden history. */
export function verifyCurrentSeed({LoroDoc,snapshot,seed,schemaVersion=1,requireComplete=false}){
 if(![1,4].includes(schemaVersion))throw Error('UNSUPPORTED_VERSION');
 if(typeof LoroDoc!=='function'||!(snapshot instanceof Uint8Array)||snapshot.length>1024*1024||!seed||!validId(seed.seedId)||!Array.isArray(seed.identities)||seed.identities.length>256)throw Error('INVALID_SEED');
 const doc=new LoroDoc();const imported=doc.import(snapshot);if(requireComplete&&imported.pending?.size)throw Error('INVALID_SEED');const state=doc.toJSON(),changes=doc.exportJsonUpdates(undefined,undefined,false).changes,seen=new Set(),peers=new Set(),eq=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 const identities=new Map(),commandIds=new Set();for(const x of seed.identities){if(!isObject(x)||Object.keys(x).sort().join(',')!=='commandId,effectId'||!validId(x.commandId)||!validId(x.effectId)||identities.has(x.effectId)||commandIds.has(x.commandId))throw Error('INVALID_SEED');identities.set(x.effectId,x.commandId);commandIds.add(x.commandId)}
 const cycleIds=new Set();for(const [name,v] of Object.entries(state))if(name.startsWith('shopping-list:')){if(!isObject(v)||Object.keys(v).some(k=>!['name','currentCycleId'].includes(k))||!validId(v.currentCycleId))throw Error('INVALID_SEED');cycleIds.add(v.currentCycleId)}
 for(const [name,map] of Object.entries(state)){
  if(!isObject(map))throw Error('INVALID_SEED');let fields=null;
  if(name.startsWith('recipe:'))fields=['title','description','portions','notes','createdAt','updatedAt'];else if(name.startsWith('recipe-ingredient:'))fields=['name','amount','needsShopping','position'];else if(name.startsWith('recipe-step:'))fields=['text','position'];else if(name.startsWith('pantry:'))fields=['name','preference','createdAt','updatedAt'];else if(name.startsWith('shopping-list:'))fields=['name','currentCycleId'];else if(name.startsWith('shopping-item:'))fields=['value'];else if(schemaVersion===4&&name.startsWith('shopping-item-fields:'))fields=['name','checked','recipeId','ingredientId','displayQuantity','displayUnit','updatedAt'];else if(name.startsWith('field-head:'))fields=['effect'];else if(!['recipe-index','pantry-index','shopping-cycles','shopping-item-versions','purchases','domain-effects'].includes(name)&&!name.startsWith('recipe-ingredient-index:')&&!name.startsWith('recipe-step-index:'))throw Error('INVALID_SEED');
  if(fields&&Object.keys(map).some(k=>!fields.includes(k)))throw Error('INVALID_SEED');
  if(schemaVersion===4){
   const scalar=scalarMaps.find(([prefix])=>name.startsWith(prefix))?.[1];
   if(scalar&&Object.entries(map).some(([field,value])=>!scalar[field](value)))throw Error('INVALID_SEED');
  }
  if((name==='recipe-index'||name==='pantry-index'||name.startsWith('recipe-ingredient-index:')||name.startsWith('recipe-step-index:'))&&Object.values(map).some(v=>!identities.has(v)))throw Error('INVALID_SEED');
  if(name.startsWith('field-head:')&&(!identities.has(map.effect)||Object.keys(map).length!==1))throw Error('INVALID_SEED');
  if(name==='shopping-cycles'&&Object.values(map).some(c=>!isObject(c)||Object.keys(c).sort().join(',')!=='effectId,listId,startedAt'||!identities.has(c.effectId)))throw Error('INVALID_SEED');
  if(schemaVersion===4&&name.startsWith('shopping-item-fields:')){
   const id=decodeURIComponent(name.slice('shopping-item-fields:'.length)),base=state[mapName('shopping-item',id)]?.value;
   if(!base||map.ingredientId!=null&&!nonemptyText(map.recipeId))throw Error('INVALID_SEED');
   for(const [field,value] of Object.entries(map)){
    const fieldEffect=state[mapName('field-head',JSON.stringify(['shopping-item',id,field]))]?.effect;
    const valid=field==='checked'?isObject(value)&&Object.keys(value).sort().join(',')==='cycleId,value'&&value.cycleId===base.cycleId&&typeof value.value==='boolean':
     field==='updatedAt'?date(value):field==='name'?nonemptyText(value):
     value===null||(['recipeId','ingredientId'].includes(field)?nonemptyText(value):text(value));
    if(!identities.has(fieldEffect)||!valid)throw Error('INVALID_SEED');
   }
  }
  if(name.startsWith('shopping-item:')&&(!isObject(map.value)||Object.keys(map.value).sort().join(',')!=='at,checked,cycleId,effectId,itemId,listId,name'||!cycleIds.has(map.value.cycleId)||!identities.has(map.value.effectId)))throw Error('INVALID_SEED');
  if(name==='shopping-item-versions'&&Object.entries(map).some(([id,v])=>!isObject(v)||v.effectId!==id||!cycleIds.has(v.cycleId)||!identities.has(id)||!Object.values(state).some(m=>isObject(m)&&isObject(m.value)&&eq(m.value,v))))throw Error('INVALID_SEED');

  if(name==='shopping-cycles'&&Object.keys(map).some(k=>!cycleIds.has(k)))throw Error('INVALID_SEED');
  if(name==='purchases'&&Object.entries(map).some(([id,p])=>!isObject(p)||p.id!==id||!cycleIds.has(p.purchaseCycleId)||!identities.has(id)||Object.keys(p).some(k=>!['id','listId','purchaseCycleId','itemIds','pantryItemIds','purchasedAt','author'].includes(k))))throw Error('INVALID_SEED');
  if(schemaVersion===4){
   if(name==='shopping-cycles'&&Object.values(map).some(c=>!nonemptyText(c.listId)||!date(c.startedAt)))throw Error('INVALID_SEED');
   if(name.startsWith('shopping-item:')){
    const {effectId,...data}=map.value;
    try { validate({version:1,kind:'shopping-item-put',commandId:'seed-validation',effectId,dependencyEffectIds:[],data}); }
    catch { throw Error('INVALID_SEED'); }
   }
   // Current purchase records retain IDs without the command's pantry payload.
   if(name==='purchases'&&Object.values(map).some(p=>!nonemptyText(p.listId)||!ids(p.itemIds)||!p.itemIds.length||
      !ids(p.pantryItemIds)||!date(p.purchasedAt)||!nonemptyText(p.author)))throw Error('INVALID_SEED');
  }
  if(name==='domain-effects'&&(Object.keys(map).length!==identities.size||Object.entries(map).some(([id,m])=>!isObject(m)||Object.keys(m).sort().join(',')!=='commandId,effectId,seedId,version'||m.version!==3||m.seedId!==seed.seedId||m.effectId!==id||m.commandId!==identities.get(id))))throw Error('INVALID_SEED');
 }
 if((schemaVersion===1&&!isObject(state['domain-effects']))||Object.keys(state['domain-effects']??{}).length!==identities.size)throw Error('INVALID_SEED');
 for(const change of changes){if(change.msg!==undefined&&change.msg!==null)throw Error('INVALID_SEED');const peer=String(change.id).split('@')[1];if(!peer)throw Error('INVALID_SEED');peers.add(peer);for(const op of change.ops){const prefix='cid:root-',suffix=':Map';if(typeof op.container!=='string'||!op.container.startsWith(prefix)||!op.container.endsWith(suffix)||op.content?.type!=='insert'||typeof op.content.key!=='string')throw Error('INVALID_SEED');const name=op.container.slice(prefix.length,-suffix.length),key=op.content.key,identity=JSON.stringify([name,key]);if(seen.has(identity)||!state[name]||!own(state[name],key)||!eq(state[name][key],op.content.value))throw Error('INVALID_SEED');seen.add(identity)}}
 const count=Object.values(state).reduce((n,m)=>n+Object.keys(m).length,0);if(seen.size!==count||peers.size>1)throw Error('INVALID_SEED');return {state,peers:[...peers]};
}
