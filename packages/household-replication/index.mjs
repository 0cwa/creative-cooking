import * as A from '@automerge/automerge';

// Actor IDs only distinguish CRDT writers. Authentication belongs to the external authority.
export const scalar = value => new A.RawString(value);
const text = value => typeof value === 'string' || value instanceof A.RawString;
const plain = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const forbidden = /^(?:apiKey|accessToken|refreshToken|password|privateKey|credentials|members|__proto__|constructor|prototype)$/i;
const rootKeys = ['schemaVersion','householdId','replicationEpoch','shoppingLists','deletedLists','recipes','deletedRecipes','requirements'];
const keys = (object, allowed) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Expected map');
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`Unexpected field: ${key}`);
};
const maps = (map, validate) => {
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Expected entity map');
  for (const [key,value] of Object.entries(map)) {
    if (!id(key)) throw new Error('Invalid stable ID');
    validate(value,key);
  }
};
const tombstones = map => maps(map, value => { if(value !== true) throw new Error('Invalid tombstone'); });
function scan(value) {
  if (!value || typeof value !== 'object' || value instanceof A.RawString) return;
  for (const [key,v] of Object.entries(value)) {
    if (forbidden.test(key)) throw new Error('Credential/authority field excluded');
    scan(v);
    // Validate hidden alternatives as well as the deterministic winning projection.
    if (!Array.isArray(value)) {
      const alternatives=Object.values(A.getConflicts(value,key) ?? {});
      for(const alternative of alternatives) {
        if(text(v)!==text(alternative) || (!text(v)&&typeof v!==typeof alternative)) throw new Error('Invalid conflicting scalar type');
        if(!text(v)&&v&&typeof v==='object'&&alternatives.length>1) throw new Error('Conflicting structural identity; quarantine for explicit resolution');
        if(typeof v==='boolean'&&v!==alternative) {
          // Checkboxes may conflict; tombstones are monotonic and never clearable.
          if(key!=='checked') throw new Error('Invalid conflicting tombstone');
        }
        if(key==='diet'&&!['none','vegetarian','vegan'].includes(String(alternative)))throw new Error('Invalid conflicting diet');
        if(key==='portions'&&(!Number.isFinite(alternative)||alternative<=0))throw new Error('Invalid conflicting portions');
        scan(alternative);
      }
    }
  }
}
export function validate(doc, scope) {
  keys(doc,rootKeys);
  if(doc.schemaVersion !== 1 || String(doc.householdId) !== scope.householdId || doc.replicationEpoch !== scope.replicationEpoch) throw new Error('Space, epoch or schema mismatch');
  for(const [field,expected] of [['schemaVersion',1],['householdId',scope.householdId],['replicationEpoch',scope.replicationEpoch]]) {
    for(const alternative of Object.values(A.getConflicts(doc,field)??{})) if(String(alternative)!==String(expected)) throw new Error('Conflicting namespace or epoch');
  }
  scan(doc);
  tombstones(doc.deletedLists); tombstones(doc.deletedRecipes);
  maps(doc.shoppingLists,(list,key) => {
    keys(list,['id','title','items','deletedItems']);
    if(String(list.id)!==key || !text(list.title)) throw new Error('Invalid shopping list');
    tombstones(list.deletedItems);
    maps(list.items,(item,itemId) => {
      keys(item,['id','name','amount','checked']);
      if(String(item.id)!==itemId || !text(item.name) || typeof item.checked!=='boolean' || (item.amount!==undefined&&!text(item.amount))) throw new Error('Invalid item');
    });
  });
  maps(doc.recipes,(recipe,key) => {
    keys(recipe,['id','sourceRecipeId','title','description','portions','ingredients','ingredientOrder','steps','stepOrder','deletedIngredients','deletedSteps']);
    if(String(recipe.id)!==key || !text(recipe.title) || !id(String(recipe.sourceRecipeId)) || !Number.isFinite(recipe.portions)||recipe.portions<=0) throw new Error('Invalid recipe');
    if(recipe.description!==undefined&&!text(recipe.description)) throw new Error('Invalid description');
    for(const [collection,order,deleted,fields] of [['ingredients','ingredientOrder','deletedIngredients',['id','name','amount']],['steps','stepOrder','deletedSteps',['id','text']]]) {
      tombstones(recipe[deleted]);
      maps(recipe[collection],(entity,entityId) => {
        keys(entity,fields); if(String(entity.id)!==entityId) throw new Error('Invalid recipe entity');
        for(const field of fields.filter(f=>f!=='id')) if(entity[field]!==undefined&&!text(entity[field])) throw new Error('Invalid recipe scalar');
        if(!text(entity[collection==='steps'?'text':'name'])) throw new Error('Missing recipe scalar');
      });
      if(!Array.isArray(recipe[order]) || recipe[order].some(v=>!id(String(v)))) throw new Error('Invalid recipe order');
    }
  });
  keys(doc.requirements,['allergies','diet']);
  maps(doc.requirements.allergies,v=>{if(!text(v))throw new Error('Invalid allergy');});
  if(!['none','vegetarian','vegan'].includes(String(doc.requirements.diet))) throw new Error('Invalid diet');
  return doc;
}
function preserveTombstones(previous,next) {
  if(!previous||typeof previous!=='object'||previous instanceof A.RawString)return;
  for(const [key,value] of Object.entries(previous)) {
    if(key.startsWith('deleted')&&value&&typeof value==='object') {
      for(const tombstone of Object.keys(value))if(value[tombstone]===true&&next?.[key]?.[tombstone]!==true)throw new Error('Tombstones cannot be cleared');
    } else preserveTombstones(value,next?.[key]);
  }
}
export function create(scope, actor) {
  if(!id(scope.householdId)||!Number.isSafeInteger(scope.replicationEpoch)||scope.replicationEpoch<1)throw new Error('Invalid scope');
  return A.from({schemaVersion:1,householdId:scalar(scope.householdId),replicationEpoch:scope.replicationEpoch,shoppingLists:{},deletedLists:{},recipes:{},deletedRecipes:{},requirements:{allergies:{},diet:scalar('none')}},actor?{actor}:undefined);
}
export const save = doc => A.save(doc);
export const load = (snapshot,scope,actor) => validate(A.load(snapshot,actor?{actor}:undefined),scope);
export function originalConflicts(doc,path,field) {
  const node=path.reduce((value,key)=>value?.[key],doc);
  return plain(A.getConflicts(node,field)??{});
}
export function project(doc) {
  const p=plain(doc);
  p.shoppingLists=Object.values(p.shoppingLists).filter(v=>!p.deletedLists[v.id]).map(list=>({...list,items:Object.values(list.items).filter(item=>!list.deletedItems[item.id])}));
  p.recipes=Object.values(p.recipes).filter(v=>!p.deletedRecipes[v.id]).map(recipe=>({...recipe,ingredients:ordered(recipe.ingredients,recipe.ingredientOrder,recipe.deletedIngredients),steps:ordered(recipe.steps,recipe.stepOrder,recipe.deletedSteps)}));
  return p;
}
function ordered(entities,order,deleted) {
  // Concurrent move duplicates are collapsed; concurrent insertions missing from order remain visible.
  return [...new Set([...order.map(String),...Object.keys(entities).sort()])].filter(key=>entities[key]&&!deleted[key]).map(key=>entities[key]);
}
export function copySelectedRecipe(doc,{copyId,sourceRecipeId,recipe}) {
  if(!id(copyId)||!id(sourceRecipeId)||doc.deletedRecipes[copyId]||doc.recipes[copyId])throw new Error('Invalid or reused copy ID');
  const copy={id:scalar(copyId),sourceRecipeId:scalar(sourceRecipeId),title:scalar(recipe.title),portions:recipe.portions,ingredients:{},ingredientOrder:[],steps:{},stepOrder:[],deletedIngredients:{},deletedSteps:{}};
  if(recipe.description!==undefined)copy.description=scalar(recipe.description);
  recipe.ingredients.forEach((item,index)=>{const key=`${copyId}_ingredient_${index}`;copy.ingredients[key]={id:scalar(key),name:scalar(item.name)};if(item.amount!==undefined)copy.ingredients[key].amount=scalar(item.amount);copy.ingredientOrder.push(scalar(key));});
  recipe.steps.forEach((step,index)=>{const key=`${copyId}_step_${index}`;copy.steps[key]={id:scalar(key),text:scalar(step)};copy.stepOrder.push(scalar(key));});
  doc.recipes[copyId]=copy;
}
export function memoryPersistence() {
  const records=new Map();
  return {async write(key,bytes){records.set(key,bytes.slice());},async read(key){return records.get(key)?.slice();}};
}

/** Trusted authority.verify must authenticate the sender/evidence and return access for THIS
 * space, epoch and action. It must never consult replicated application fields. */
export function repository({scope,actor,persistence,authority,publish=async()=>{},snapshot}) {
  if(!authority?.verify||!persistence?.write)throw new Error('Trusted authority and durable persistence required');
  let doc=snapshot?load(snapshot,scope,actor):create(scope,actor);
  let tail=Promise.resolve();
  const quarantine=[];
  const storageKey=`household/${scope.householdId}/epoch/${scope.replicationEpoch}`;
  const serial=fn=>{const run=tail.then(fn);tail=run.catch(()=>{});return run;};
  const envelope=changes=>({householdId:scope.householdId,replicationEpoch:scope.replicationEpoch,schemaVersion:1,changes});
  const persist=async candidate=>{await persistence.write(storageKey,save(candidate));doc=candidate;};
  return {
    storageKey,quarantine,
    get document(){return doc;},
    projection:()=>project(doc), snapshot:()=>save(doc),
    // Sender and evidence are opaque authority input, never crypto claims made by this package.
    change:(mutate,credentials)=>serial(async()=>{
      if(!await authority.verify({...credentials,...scope,action:'write'}))throw new Error('Write denied');
      const previous=doc;
      const candidate=validate(A.change(A.clone(doc,{actor:A.getActorId(doc)}),mutate),scope);
      preserveTombstones(previous,candidate);
      const outgoing=envelope(A.getChanges(previous,candidate));
      await persist(candidate); // failure leaves current document and publication untouched
      await publish(outgoing);
      return outgoing;
    }),
    receive:(incoming,credentials)=>serial(async()=>{
      try {
        if(incoming.householdId!==scope.householdId||incoming.replicationEpoch!==scope.replicationEpoch||incoming.schemaVersion!==1)throw new Error('Space, epoch or schema mismatch');
        if(!await authority.verify({...credentials,...scope,action:'receive'}))throw new Error('Receive denied');
        if(!Array.isArray(incoming.changes)||incoming.changes.length>1000)throw new Error('Invalid change batch');
        for(const change of incoming.changes) {
          if(!(change instanceof Uint8Array)||change.length>1_000_000)throw new Error('Invalid change size');
          const decoded=A.decodeChange(change);
          for(const op of decoded.ops) {
            if(op.key&&forbidden.test(op.key))throw new Error('Credential/authority field excluded');
            if(op.obj==='_root'&&['schemaVersion','householdId','replicationEpoch'].includes(op.key)&&op.pred.length)throw new Error('Immutable namespace or epoch');
          }
        }
        // Clone isolates rejected candidates and Automerge's deferred causally pending changes.
        const [candidate]=A.applyChanges(A.clone(doc,{actor:A.getActorId(doc)}),incoming.changes);
        validate(candidate,scope);
        preserveTombstones(doc,candidate);
        await persist(candidate);
        return {accepted:true,missingDependencies:A.getMissingDeps(doc,[])};
      } catch(error) {
        quarantine.push({reason:error.message,householdId:incoming?.householdId,replicationEpoch:incoming?.replicationEpoch});
        return {accepted:false,reason:error.message};
      }
    }),
    allChanges:()=>envelope(A.getAllChanges(doc)),
  };
}
