import {isPersonalCommand,validatePersonalCommand,personalOperations,checkPersonalPreconditions} from './personal-codec.mjs';
// Experimental package D registry. Requires the engine to validate actual imported
// operation content against operations() before committing any remote update.
const encoder = new TextEncoder();
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const bytes = value => encoder.encode(JSON.stringify(canonical(value)));
const fail = () => { throw new Error('MALFORMED_COMMAND'); };
const str = v => typeof v === 'string' && v.trim().length > 0;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
const dense = (v,predicate) => Array.isArray(v) && Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i) && predicate(v[i])).every(Boolean);
const ids = v => dense(v,str) && new Set(v).size === v.length;
const date = v => str(v) && Number.isFinite(Date.parse(v));
const mutationFields={pantry:['name','preference','createdAt','updatedAt','removed'],recipe:['title','description','portions','ingredients','steps','stepIds','notes','createdAt','updatedAt','removed']};
const jsonValue=v=>v===null || typeof v==='string' || typeof v==='boolean' || (typeof v==='number' && Number.isFinite(v)) || dense(v,jsonValue) || (v && typeof v==='object' && Object.getPrototypeOf(v)===Object.prototype && Object.values(v).every(jsonValue));
const validMutation=m=>{if (!exact(m,['collection','id','field','value']) || !Object.hasOwn(mutationFields,m.collection) || !str(m.id) || !mutationFields[m.collection].includes(m.field) || !jsonValue(m.value)) return false; const {field,value}=m; if(field==='removed')return typeof value==='boolean';if(field==='createdAt'||field==='updatedAt')return date(value);if(field==='preference')return Number.isInteger(value)&&value>=1&&value<=5;if(field==='portions')return Number.isSafeInteger(value)&&value>0;if(['name','title'].includes(field))return str(value);if(field==='description')return typeof value==='string';if(field==='notes')return Array.isArray(value)&&value.every(x=>typeof x==='string');if(field==='ingredients'||field==='steps'||field==='stepIds')return Array.isArray(value);return false;};
export function validate(c) {
  if (isPersonalCommand(c?.kind)) return validatePersonalCommand(c);
  if (!exact(c,['version','kind','commandId','effectId','dependencyEffectIds','data']) || c.version !== 1 || !str(c.commandId) || !str(c.effectId) || !ids(c.dependencyEffectIds) || c.dependencyEffectIds.includes(c.effectId)) fail();
  const d=c.data;
  switch(c.kind) {
    case 'recipe-create':
      if (!exact(d,['recipe','author','at']) || !d.recipe || !str(d.recipe.id) || !str(d.author) || !date(d.at) || !str(d.recipe.title) || !Number.isSafeInteger(d.recipe.portions) || d.recipe.portions<1 || !Array.isArray(d.recipe.ingredients) || !Array.isArray(d.recipe.steps) || !Array.isArray(d.recipe.stepIds) || Object.keys(d.recipe).some(k=>!['id','title','description','portions','ingredients','steps','stepIds','notes','createdAt','updatedAt'].includes(k))) fail();
      break;
    case 'recipe-field':
      if (!exact(d,['recipeId','field','value','author','at']) || !str(d.recipeId) || !['title','description','portions','notes','updatedAt','removed'].includes(d.field) || !str(d.author) || !date(d.at) || (d.field === 'removed' ? typeof d.value!=='boolean' : d.field === 'updatedAt' ? !date(d.value) : d.field === 'portions' ? !Number.isSafeInteger(d.value) || d.value < 1 : d.field === 'notes' ? !Array.isArray(d.value) || !dense(d.value,x=>typeof x==='string') : typeof d.value !== 'string' || (d.field === 'title' && !str(d.value)))) fail();
      break;
    case 'recipe-ingredient-add':
      if (!exact(d,['recipeId','ingredientId','name','amount','needsShopping','position','author','at']) || !str(d.recipeId) || !str(d.ingredientId) || !str(d.name) || typeof d.amount!=='string' || typeof d.needsShopping!=='boolean' || !Number.isSafeInteger(d.position) || d.position<0 || !str(d.author) || !date(d.at)) fail();
      break;
    case 'recipe-step-add':
      if (!exact(d,['recipeId','stepId','text','position','author','at']) || !str(d.recipeId) || !str(d.stepId) || !str(d.text) || !Number.isSafeInteger(d.position) || d.position<0 || !str(d.author) || !date(d.at)) fail();
      break;
    case 'recipe-ingredient-field':
      if (!exact(d,['recipeId','ingredientId','field','value','author','at']) || !str(d.recipeId) || !str(d.ingredientId) || !['name','amount','needsShopping','removed','position'].includes(d.field) || !str(d.author) || !date(d.at) || (d.field==='name' ? !str(d.value) : d.field==='amount' ? typeof d.value!=='string' : ['needsShopping','removed'].includes(d.field) ? typeof d.value!=='boolean' : !Number.isSafeInteger(d.value) || d.value<0)) fail();
      break;
    case 'recipe-step-field':
      if (!exact(d,['recipeId','stepId','field','value','author','at']) || !str(d.recipeId) || !str(d.stepId) || !['text','removed','position'].includes(d.field) || !str(d.author) || !date(d.at) || (d.field==='text' ? !str(d.value) : d.field==='removed' ? typeof d.value!=='boolean' : !Number.isSafeInteger(d.value) || d.value<0)) fail();
      break;
    case 'shopping-list-create':
      if (!exact(d,['listId','cycleId','name','at']) || !str(d.listId) || !str(d.cycleId) || !str(d.name) || !date(d.at)) fail();
      break;
    case 'shopping-cycle-start':
      if (!exact(d,['listId','previousCycleId','cycleId','at']) || !str(d.listId) || !str(d.previousCycleId) || !str(d.cycleId) || d.cycleId===d.previousCycleId || !date(d.at)) fail();
      break;
    case 'shopping-item-put':
      if (!exact(d,['listId','cycleId','itemId','name','checked','at']) || !str(d.listId) || !str(d.cycleId) || !str(d.itemId) || !str(d.name) || typeof d.checked!=='boolean' || !date(d.at)) fail();
      break;
    case 'shopping-item-create':
      if(!exact(d,['listId','cycleId','itemId','name','checked','recipeId','ingredientId','displayQuantity','displayUnit','author','at'])||![d.listId,d.cycleId,d.itemId,d.name,d.author].every(str)||typeof d.checked!=='boolean'||!date(d.at)||![d.recipeId,d.ingredientId].every(x=>x===null||str(x))||![d.displayQuantity,d.displayUnit].every(x=>x===null||typeof x==='string')||(d.ingredientId!==null&&!d.recipeId))fail();
      break;
    case 'shopping-item-field':
      if(!exact(d,['listId','cycleId','itemId','field','value','author','at'])||![d.listId,d.cycleId,d.itemId,d.author].every(str)||!date(d.at)||!['name','checked','displayQuantity','displayUnit','createdAt','removedAt','updatedAt'].includes(d.field)||(d.field==='name'?!str(d.value):d.field==='checked'?typeof d.value!=='boolean':['createdAt','removedAt','updatedAt'].includes(d.field)?!date(d.value):['recipeId','ingredientId'].includes(d.field)?!(d.value===null||str(d.value)):!(d.value===null||typeof d.value==='string')))fail();
      break;
    case 'shopping-list-field':
      if(!exact(d,['listId','cycleId','field','value','author','at'])||![d.listId,d.cycleId,d.author].every(str)||!date(d.at)||!['removedAt','updatedAt'].includes(d.field)||!date(d.value))fail();
      break;
    case 'purchase-correction':
      if (!exact(d,['purchaseId','reason','at','author']) || !str(d.purchaseId) || !str(d.reason) || !date(d.at) || !str(d.author)) fail();
      break;
    case 'purchase':
      if (!(exact(d,['id','listId','purchaseCycleId','itemIds','pantryItemIds','purchasedAt','author']) || exact(d,['id','listId','purchaseCycleId','itemIds','pantryItemIds','pantryItems','purchasedAt','author'])) || d.id !== c.effectId || !str(d.listId) || !str(d.purchaseCycleId) || !ids(d.itemIds) || !d.itemIds.length || !ids(d.pantryItemIds) || !date(d.purchasedAt) || !str(d.author)) fail();
      if(d.pantryItems===undefined ? d.pantryItemIds.length!==0 : !dense(d.pantryItems,x=>exact(x,['id','itemId','name']) && str(x.name) && d.itemIds.includes(x.itemId) && x.id===`shopping-purchase:${encodeURIComponent(d.id)}:${encodeURIComponent(x.itemId)}`) || !ids(d.pantryItems.map(x=>x.id)) || JSON.stringify(d.pantryItems.map(x=>x.id))!==JSON.stringify(d.pantryItemIds)) fail();
      break;
    case 'pantry-create':
      if (!exact(d,['itemId','name','preference','at','author']) || !str(d.itemId) || !str(d.name) || !Number.isInteger(d.preference) || d.preference<1 || d.preference>5 || !date(d.at) || !str(d.author)) fail();
      break;
    case 'pantry-field':
      if (!exact(d,['itemId','field','value','author','at']) || !str(d.itemId) || !str(d.author) || !date(d.at) || !['name','preference','createdAt','updatedAt','removedAt'].includes(d.field) || (d.field === 'preference' ? !Number.isInteger(d.value) || d.value < 1 || d.value > 5 : ['createdAt','updatedAt','removedAt'].includes(d.field) ? !date(d.value) : !str(d.value))) fail();
      break;
    case 'chef-proposal-create':
      if (!exact(d,['conversationId','proposalId','toolName','arguments','status','createdAt']) || !str(d.conversationId) || !str(d.proposalId) || !str(d.toolName) || typeof d.arguments !== 'string' || d.status !== 'pending' || !date(d.createdAt)) fail();
      break;
    case 'chef-effect':
      if (!exact(d,['mutations']) || !Array.isArray(d.mutations) || !d.mutations.length || !dense(d.mutations,validMutation) || new Set(d.mutations.map(m=>JSON.stringify([m.collection,m.id,m.field]))).size !== d.mutations.length) fail();
      for(const m of d.mutations.filter(x=>x.field==='createdAt')) {const fields=new Set(d.mutations.filter(x=>x.collection===m.collection && x.id===m.id).map(x=>x.field));const required=m.collection==='pantry'?['name','preference','createdAt','updatedAt']:['title','portions','ingredients','steps','stepIds','createdAt','updatedAt'];if(!required.every(x=>fields.has(x))) fail();}
      break;
    case 'chef-accept':
      if (!exact(d,['conversationId','proposalId','effectIds','status','effect','proposal']) || !str(d.conversationId) || !str(d.proposalId) || d.status !== 'applied' || !ids(d.effectIds) || d.effectIds.length!==1 || !d.effect || d.effect.kind!=='chef-effect' || d.effect.effectId!==d.effectIds[0] || !exact(d.proposal,['toolName','arguments','status','createdAt','effectId']) || !str(d.proposal.toolName) || typeof d.proposal.arguments!=='string' || d.proposal.status!=='pending' || !date(d.proposal.createdAt) || !str(d.proposal.effectId)) fail();
      validate(d.effect);
      break;
    default: fail();
  }
  return structuredClone(c);
}
export const proposalMapName = (conversationId, proposalId) => `chef-proposal:${encodeURIComponent(JSON.stringify([conversationId, proposalId]))}`;
const mapName = (kind,id) => `${kind}:${encodeURIComponent(id)}`;
const fieldHead=(kind,id,field)=>mapName('field-head',JSON.stringify([kind,id,field]));
export function readShoppingItem(doc,itemId,cycleId){const base=doc.getMap(mapName('shopping-item',itemId)).get('value');if(!base)return null;const fields=doc.getMap(mapName('shopping-item-fields',itemId)).toJSON(),checked=fields.checked;return {...base,...fields,cycleId,checked:checked?.cycleId===cycleId?checked.value:base.cycleId===cycleId&&base.checked};}

// These exact operations are the replay contract. Purchase records are immutable
// event snapshots; mutable records have independent registers per field.
function domainOperations(input) {
  const c=validate(input), d=c.data;
  switch(c.kind) {
    case 'recipe-create': {const recipe={createdAt:d.at,updatedAt:d.at,...d.recipe};const mutations=Object.keys(recipe).filter(k=>k!=='id' && recipe[k]!==undefined).sort().map(field=>({collection:'recipe',id:recipe.id,field,value:recipe[field]}));return domainOperations({version:1,kind:'chef-effect',commandId:c.commandId,effectId:c.effectId,dependencyEffectIds:c.dependencyEffectIds,data:{mutations}});}
    case 'recipe-field': return [
      {container:mapName('recipe',d.recipeId),key:d.field,value:d.value},
      {container:fieldHead('recipe',d.recipeId,d.field),key:'effect',value:c.effectId},
      {container:mapName('recipe-intentions',d.recipeId),key:c.effectId,value:{field:d.field,value:d.value,author:d.author,at:d.at,commandId:c.commandId,dependencyEffectIds:c.dependencyEffectIds}}
    ];
    case 'recipe-ingredient-add': {const container=mapName('recipe-ingredient',JSON.stringify([d.recipeId,d.ingredientId]));return [{container:mapName('recipe-ingredient-index',d.recipeId),key:d.ingredientId,value:c.effectId},...['name','amount','needsShopping','position'].map(key=>({container,key,value:d[key]}))];}
    case 'recipe-step-add': {const container=mapName('recipe-step',JSON.stringify([d.recipeId,d.stepId]));return [{container:mapName('recipe-step-index',d.recipeId),key:d.stepId,value:c.effectId},...['text','position'].map(key=>({container,key,value:d[key]}))];}
    case 'recipe-ingredient-field': return [{container:mapName('recipe-ingredient',JSON.stringify([d.recipeId,d.ingredientId])),key:d.field,value:d.value},{container:fieldHead('ingredient',JSON.stringify([d.recipeId,d.ingredientId]),d.field),key:'effect',value:c.effectId},{container:mapName('recipe-intentions',d.recipeId),key:c.effectId,value:{kind:c.kind,id:d.ingredientId,field:d.field,value:d.value,author:d.author,at:d.at,commandId:c.commandId,dependencyEffectIds:c.dependencyEffectIds}}];
    case 'recipe-step-field': return [{container:mapName('recipe-step',JSON.stringify([d.recipeId,d.stepId])),key:d.field,value:d.value},{container:fieldHead('step',JSON.stringify([d.recipeId,d.stepId]),d.field),key:'effect',value:c.effectId},{container:mapName('recipe-intentions',d.recipeId),key:c.effectId,value:{kind:c.kind,id:d.stepId,field:d.field,value:d.value,author:d.author,at:d.at,commandId:c.commandId,dependencyEffectIds:c.dependencyEffectIds}}];
    case 'shopping-list-create': return [{container:mapName('shopping-list',d.listId),key:'name',value:d.name},{container:mapName('shopping-list',d.listId),key:'currentCycleId',value:d.cycleId},{container:'shopping-cycles',key:d.cycleId,value:{listId:d.listId,startedAt:d.at,effectId:c.effectId}}];
    case 'shopping-cycle-start': return [{container:mapName('shopping-list',d.listId),key:'currentCycleId',value:d.cycleId},{container:'shopping-cycles',key:d.cycleId,value:{listId:d.listId,startedAt:d.at,effectId:c.effectId}}];
    case 'shopping-item-put': return [{container:mapName('shopping-item',d.itemId),key:'value',value:{...d,effectId:c.effectId}},{container:'shopping-item-versions',key:c.effectId,value:{...d,effectId:c.effectId}}];
    case 'shopping-item-create': {const base={listId:d.listId,cycleId:d.cycleId,itemId:d.itemId,name:d.name,checked:d.checked,at:d.at,effectId:c.effectId},fields={createdAt:d.at,updatedAt:d.at,...Object.fromEntries(['recipeId','ingredientId','displayQuantity','displayUnit'].filter(k=>d[k]!==null).map(k=>[k,d[k]]))};return [{container:mapName('shopping-item',d.itemId),key:'value',value:base},{container:'shopping-item-versions',key:c.effectId,value:base},...Object.entries(fields).flatMap(([field,value])=>[{container:mapName('shopping-item-fields',d.itemId),key:field,value},{container:fieldHead('shopping-item',d.itemId,field),key:'effect',value:c.effectId}])];}
    case 'shopping-item-field': return [{container:mapName('shopping-item-fields',d.itemId),key:d.field,value:d.field==='checked'?{cycleId:d.cycleId,value:d.value}:d.value},{container:fieldHead('shopping-item',d.itemId,d.field),key:'effect',value:c.effectId}];
    case 'shopping-list-field': return [{container:mapName('shopping-list',d.listId),key:d.field,value:d.value},{container:fieldHead('shopping-list',d.listId,d.field),key:'effect',value:c.effectId}];
    case 'purchase-correction': return [{container:'purchase-corrections',key:c.effectId,value:{...d,effectId:c.effectId,dependencyEffectIds:c.dependencyEffectIds}}];
    case 'purchase': return [{container:'purchases',key:d.id,value:d},...(d.pantryItems??[]).flatMap(item=>[{container:'pantry-index',key:item.id,value:c.effectId},...Object.entries({name:item.name,preference:3,createdAt:d.purchasedAt,updatedAt:d.purchasedAt}).map(([key,value])=>({container:mapName('pantry',item.id),key,value}))])];
    case 'pantry-create': return [{container:'pantry-index',key:d.itemId,value:c.effectId},...Object.entries({name:d.name,preference:d.preference,createdAt:d.at,updatedAt:d.at}).map(([key,value])=>({container:mapName('pantry',d.itemId),key,value}))];
    case 'pantry-field': return [{container:mapName('pantry',d.itemId),key:d.field,value:d.value},{container:fieldHead('pantry',d.itemId,d.field),key:'effect',value:c.effectId}];
    case 'chef-proposal-create': return [{container:proposalMapName(d.conversationId,d.proposalId),key:'proposal',value:{toolName:d.toolName,arguments:d.arguments,status:'pending',createdAt:d.createdAt,effectId:c.effectId}}];
    case 'chef-effect': {
      const out=[], seen=new Set();
      const put=(container,key,value)=>{const k=JSON.stringify([container,key]);if(seen.has(k)) throw Error('MALFORMED_COMMAND');seen.add(k);out.push({container,key,value});};
      const indexed=new Set();
      for(const m of d.mutations) {
        const idx=JSON.stringify([m.collection,m.id]);
        if(!indexed.has(idx) && d.mutations.some(x=>x.collection===m.collection && x.id===m.id && x.field==='createdAt')) {put(`${m.collection}-index`,m.id,c.effectId);indexed.add(idx);}
        if(m.collection==='recipe' && m.field==='ingredients') {
          if(!Array.isArray(m.value) || !ids(m.value.map(x=>x?.id))) fail();
          for(const [position,item] of m.value.entries()) {
            if(!item || !str(item.name) || Object.keys(item).some(k=>!['id','name','amount','needsShopping'].includes(k)) || (item.amount!==undefined && typeof item.amount!=='string') || (item.needsShopping!==undefined && typeof item.needsShopping!=='boolean')) fail();
            put(mapName('recipe-ingredient-index',m.id),item.id,c.effectId);
            const container=mapName('recipe-ingredient',JSON.stringify([m.id,item.id]));
            for(const field of ['name','amount','needsShopping']) if(item[field]!==undefined) put(container,field,item[field]);
            put(container,'position',position);
          }
        } else if(m.collection==='recipe' && m.field==='steps') {
          const idMutation=d.mutations.find(x=>x.collection==='recipe' && x.id===m.id && x.field==='stepIds');
          if(!Array.isArray(m.value) || !dense(m.value,str) || !idMutation || !ids(idMutation.value) || idMutation.value.length!==m.value.length) fail();
          for(const [position,text] of m.value.entries()) {
            const id=idMutation.value[position];put(mapName('recipe-step-index',m.id),id,c.effectId);
            const container=mapName('recipe-step',JSON.stringify([m.id,id]));put(container,'text',text);put(container,'position',position);
          }
        } else if(m.collection==='recipe' && m.field==='stepIds') {
          if(!d.mutations.some(x=>x.collection==='recipe' && x.id===m.id && x.field==='steps')) fail();
        } else {put(mapName(m.collection,m.id),m.field,m.value);put(fieldHead(m.collection,m.id,m.field),'effect',c.effectId);}
      }
      return out;
    }
    case 'chef-accept': return [{container:proposalMapName(d.conversationId,d.proposalId),key:'acceptance',value:{status:d.status,effectIds:d.effectIds,effect:d.effect,proposal:d.proposal,commandId:c.commandId,effectId:c.effectId}}];
  }
}
export function operations(input) {const c=validate(input),d=c.data;
 if(isPersonalCommand(c.kind)) return personalOperations(c);
 const touches=c.kind==='chef-effect'?[...new Set(d.mutations.map(m=>m.collection))].sort():c.kind==='purchase' && d.pantryItems?.length?['pantry']:c.kind.startsWith('pantry-')?['pantry']:c.kind.startsWith('recipe-')?['recipe']:[];
 return [...domainOperations(c),{container:'domain-effects',key:c.effectId,value:{version:2,touches,dependencyEffectIds:c.dependencyEffectIds,command:c}}];}

export function apply(doc,c) { for (const op of operations(c)) doc.getMap(op.container).set(op.key,op.value); }
export function validateOperations(c, changes) {
  const expected=operations(c);
  if(changes.flatMap(change=>change.ops).some(op=>op.container==='cid:root-domain-effects:Map' && op.content?.type==='insert' && op.content.value?.version!==2)) throw new Error('UNSUPPORTED_VERSION');
  const actual=changes.flatMap(change=>change.ops).map(op=>({container:op.container,key:op.content?.key,value:op.content?.value,type:op.content?.type}));
  if (actual.length !== expected.length || actual.some((op,i)=>op.type !== 'insert' || op.container !== `cid:root-${expected[i].container}:Map` || op.key !== expected[i].key || JSON.stringify(canonical(op.value)) !== JSON.stringify(canonical(expected[i].value)))) throw new Error('MALFORMED_UPDATE');
}

/** Housekeeping timestamps may compete when independent field edits merge.
 * Their original causal preconditions remain mandatory in the runtime.
 * Keep a mixed-schema update in the inbox when applying it would mask another
 * device's older whole-item intent or change the baseline of a field edit. */
export function checkShoppingCompatibility(doc,command){const c=validate(command),d=c.data;if(c.kind==='shopping-item-put'&&Object.keys(doc.getMap(mapName('shopping-item-fields',d.itemId)).toJSON()).length)throw Error('SHOPPING_SCHEMA_CONFLICT');if(['shopping-item-field','shopping-list-field'].includes(c.kind)){try{checkPreconditions(doc,c,{importing:true,shoppingCompatibility:true})}catch(e){if(['MISSING_DEPENDENCY','STALE_CYCLE'].includes(e?.message))throw Error('SHOPPING_SCHEMA_CONFLICT');throw e}}}
export function checkPreconditions(doc, command, {importing=false,replaying=false,shoppingCompatibility=false}={}) {
  const c=validate(command), d=c.data;
  if(c.kind==='chef-accept' && !importing && !doc.getMap(proposalMapName(d.conversationId,d.proposalId)).get('proposal')) throw new Error('PROPOSAL_NOT_PENDING');
  for(const id of c.dependencyEffectIds) if(!doc.getMap('domain-effects').get(id)) throw new Error('MISSING_DEPENDENCY');
  if(isPersonalCommand(c.kind)) return checkPersonalPreconditions(doc,c);
  if(!replaying && ['recipe-field','pantry-field','recipe-ingredient-field','recipe-step-field'].includes(c.kind)) {
    const kind=c.kind==='recipe-field'?'recipe':c.kind==='pantry-field'?'pantry':c.kind==='recipe-ingredient-field'?'ingredient':'step';
    const id=kind==='recipe'?d.recipeId:kind==='pantry'?d.itemId:JSON.stringify([d.recipeId,kind==='ingredient'?d.ingredientId:d.stepId]);
    const previous=doc.getMap(fieldHead(kind,id,d.field)).get('effect');if(previous && !c.dependencyEffectIds.includes(previous)) throw new Error('MISSING_DEPENDENCY');
  }
  if (c.kind==='pantry-create' && doc.getMap('pantry-index').get(d.itemId)) throw new Error('CONFLICT');
  if (c.kind==='pantry-field' || c.kind==='recipe-field') {const effect=doc.getMap(c.kind==='pantry-field'?'pantry-index':'recipe-index').get(c.kind==='pantry-field'?d.itemId:d.recipeId);if(!effect || !c.dependencyEffectIds.includes(effect)) throw new Error('MISSING_DEPENDENCY');}
  if (c.kind==='recipe-create' && doc.getMap('recipe-index').get(d.recipe.id)) throw new Error('CONFLICT');
  if (['recipe-ingredient-add','recipe-step-add','recipe-ingredient-field','recipe-step-field'].includes(c.kind)) {
    const recipeEffect=doc.getMap('recipe-index').get(d.recipeId);
    if (!recipeEffect || !c.dependencyEffectIds.includes(recipeEffect)) throw new Error('MISSING_DEPENDENCY');
    const ingredient=c.kind.startsWith('recipe-ingredient'), id=ingredient?d.ingredientId:d.stepId;
    const memberEffect=doc.getMap(mapName(ingredient?'recipe-ingredient-index':'recipe-step-index',d.recipeId)).get(id);
    if(c.kind.endsWith('-add')) {if(memberEffect) throw new Error('CONFLICT');}
    else if(!memberEffect || !c.dependencyEffectIds.includes(memberEffect)) throw new Error('MISSING_DEPENDENCY');
  }
  if(c.kind==='chef-effect') {for(const m of d.mutations){const effect=doc.getMap(`${m.collection}-index`).get(m.id);const creating=d.mutations.some(x=>x.collection===m.collection && x.id===m.id && x.field==='createdAt');if(creating && effect) throw new Error('CONFLICT');if(!creating && (!effect || !c.dependencyEffectIds.includes(effect))) throw new Error('MISSING_DEPENDENCY');}}
  if(c.kind==='shopping-item-create'){const cycle=doc.getMap('shopping-cycles').get(d.cycleId),list=doc.getMap(mapName('shopping-list',d.listId));if(!cycle||cycle.listId!==d.listId||list.get('currentCycleId')!==d.cycleId||!c.dependencyEffectIds.includes(cycle.effectId))throw Error('MISSING_DEPENDENCY');if(doc.getMap(mapName('shopping-item',d.itemId)).get('value'))throw Error('CONFLICT');if(d.recipeId){const recipe=doc.getMap('recipe-index').get(d.recipeId);if(!recipe||!c.dependencyEffectIds.includes(recipe))throw Error('MISSING_DEPENDENCY');if(d.ingredientId){const ingredient=doc.getMap(mapName('recipe-ingredient-index',d.recipeId)).get(d.ingredientId),pair=JSON.stringify([d.recipeId,d.ingredientId]);if(!ingredient||!c.dependencyEffectIds.includes(ingredient)||['name','amount','needsShopping'].some(field=>{const effect=doc.getMap(fieldHead('ingredient',pair,field)).get('effect');return effect&&!c.dependencyEffectIds.includes(effect)}))throw Error('MISSING_DEPENDENCY')}}}
  if(['shopping-item-field','shopping-list-field'].includes(c.kind)){const cycle=doc.getMap('shopping-cycles').get(d.cycleId),list=doc.getMap(mapName('shopping-list',d.listId));if(!cycle||cycle.listId!==d.listId||list.get('currentCycleId')!==d.cycleId||!c.dependencyEffectIds.includes(cycle.effectId))throw Error('MISSING_DEPENDENCY');if(c.kind==='shopping-item-field'){const base=doc.getMap(mapName('shopping-item',d.itemId)).get('value');if(!base||base.listId!==d.listId||!c.dependencyEffectIds.includes(base.effectId))throw Error('MISSING_DEPENDENCY')}if(c.kind==='shopping-item-field'&&['recipeId','ingredientId'].includes(d.field)&&d.value!==null){const recipeId=d.field==='recipeId'?d.value:doc.getMap(mapName('shopping-item-fields',d.itemId)).get('recipeId'),recipe=doc.getMap('recipe-index').get(recipeId);if(!recipe||!c.dependencyEffectIds.includes(recipe))throw Error('MISSING_DEPENDENCY');if(d.field==='ingredientId'){const ingredient=doc.getMap(mapName('recipe-ingredient-index',recipeId)).get(d.value),pair=JSON.stringify([recipeId,d.value]);if(!ingredient||!c.dependencyEffectIds.includes(ingredient)||['name','amount','needsShopping'].some(field=>{const effect=doc.getMap(fieldHead('ingredient',pair,field)).get('effect');return effect&&!c.dependencyEffectIds.includes(effect)}))throw Error('MISSING_DEPENDENCY')}}const previous=doc.getMap(fieldHead(c.kind==='shopping-item-field'?'shopping-item':'shopping-list',c.kind==='shopping-item-field'?d.itemId:d.listId,d.field)).get('effect');if(previous&&!(shoppingCompatibility&&d.field==='updatedAt')&&!c.dependencyEffectIds.includes(previous))throw Error('MISSING_DEPENDENCY');}
  if (c.kind === 'shopping-list-create') {
    if (doc.getMap(mapName('shopping-list',d.listId)).get('currentCycleId') || doc.getMap('shopping-cycles').get(d.cycleId)) throw new Error('CONFLICT');
  }
  if (c.kind === 'shopping-cycle-start' || c.kind === 'shopping-item-put' || c.kind === 'purchase') {
    const cycle=c.kind==='shopping-cycle-start'?d.previousCycleId:c.kind==='purchase'?d.purchaseCycleId:d.cycleId;
    const list=doc.getMap(mapName('shopping-list',d.listId));
    const record=doc.getMap('shopping-cycles').get(cycle);
    if (!record) throw new Error(importing?'MISSING_DEPENDENCY':'STALE_CYCLE');
    if (list.get('currentCycleId')!==cycle || record.listId!==d.listId) throw new Error('STALE_CYCLE');
    if (!c.dependencyEffectIds.includes(record.effectId)) throw new Error('MISSING_DEPENDENCY');
    if (c.kind==='shopping-cycle-start' && doc.getMap('shopping-cycles').get(d.cycleId)) throw new Error('CONFLICT');
    const versions=doc.getMap('shopping-item-versions');
    if(c.kind==='shopping-item-put') {const prior=doc.getMap(mapName('shopping-item',d.itemId)).get('value');if(prior && prior.listId!==d.listId) throw new Error('CONFLICT');if(prior && !c.dependencyEffectIds.includes(prior.effectId)) throw new Error('MISSING_DEPENDENCY');}
    if (c.kind==='purchase') for(const id of d.itemIds) {const item=readShoppingItem(doc,id,cycle);if(!item || item.itemId!==id || item.listId!==d.listId || item.checked!==true || item.removedAt || !c.dependencyEffectIds.includes(item.effectId)||['name','checked','removedAt'].some(field=>{const h=doc.getMap(fieldHead('shopping-item',id,field)).get('effect');return h&&!c.dependencyEffectIds.includes(h)})) throw new Error('MISSING_DEPENDENCY');}
    if(c.kind==='purchase') for(const added of d.pantryItems??[]) {if(doc.getMap('pantry-index').get(added.id)) throw new Error('CONFLICT');const item=readShoppingItem(doc,added.itemId,cycle);if(!item || item.name!==added.name || !c.dependencyEffectIds.includes(item.effectId)) throw new Error('MISSING_DEPENDENCY');}
  }
  if (c.kind==='purchase-correction') {
    if (!doc.getMap('purchases').get(d.purchaseId) || !c.dependencyEffectIds.includes(d.purchaseId)) throw new Error('MISSING_DEPENDENCY');
  }
  if (c.kind !== 'chef-proposal-create' && c.kind !== 'chef-accept') return;
  const map=doc.getMap(proposalMapName(d.conversationId,d.proposalId));
  const proposal=map.get('proposal'), acceptance=map.get('acceptance');
  if (c.kind === 'chef-proposal-create') { if (proposal || acceptance) throw new Error('CONFLICT'); return; }
  if (!proposal) throw new Error(importing?'MISSING_DEPENDENCY':'PROPOSAL_NOT_PENDING');
  if (proposal.status !== 'pending' || acceptance) throw new Error('PROPOSAL_NOT_PENDING');
  if (!c.dependencyEffectIds.includes(proposal.effectId)) throw new Error('MISSING_DEPENDENCY');
  if (JSON.stringify(canonical(proposal))!==JSON.stringify(canonical(d.proposal))) throw new Error('CONFLICT');
}

/** Return every retained intention, including competing Loro register writes. */
export function recipeIntentions(doc,recipeId) {
  if(!str(recipeId)) fail();
  return Object.entries(doc.getMap(mapName('recipe-intentions',recipeId)).toJSON()).sort(([a],[b])=>a.localeCompare(b)).map(([effectId,intention])=>({effectId,...structuredClone(intention)}));
}
