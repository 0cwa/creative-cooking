import assert from 'node:assert/strict';
import * as A from '@automerge/automerge';
import { LoroDoc } from 'loro-crdt';
import { validateDocument, docId, SCHEMA_VERSION } from './schema.mjs';

export const ENGINE_VERSIONS = { automerge:'3.5.0', loro:'1.16.4' };
export const ACTORS = {
  seed:'00000000000000000000000000000000',
  phone:'11111111111111111111111111111111',
  tablet:'22222222222222222222222222222222',
  resolver:'33333333333333333333333333333333',
  receiver:'44444444444444444444444444444444'
};
export const PEERS = { seed:'900', phone:'101', tablet:'202', resolver:'303', receiver:'404' };
const own = (o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function cloneJson(x) { return JSON.parse(JSON.stringify(x)); }
export function init(engine, actor='receiver') {
  if(engine==='automerge') return A.init({ actor:ACTORS[actor] });
  if(engine==='loro') {
    const d = new LoroDoc();d.setPeerId(PEERS[actor]);return d;
  }
  throw Error('unknown engine');
}
export function fork(engine, doc, actor) {
  if(engine==='automerge') return A.clone(doc,{actor:ACTORS[actor]});
  const d=doc.fork();d.setPeerId(PEERS[actor]);return d;
}
export function snapshot(engine,doc) {
  return engine==='automerge'?Uint8Array.from(A.save(doc)):Uint8Array.from(doc.export({mode:'snapshot'}));
}
export function load(engine,bytes) {
  if(engine==='automerge') return A.load(bytes,{actor:ACTORS.receiver});
  const d=init('loro');d.import(bytes);return d;
}
export function frontier(engine,doc) {
  if(engine==='automerge')return A.getHeads(doc).sort();
  return doc.frontiers().map(x=>String(x.counter)+'@'+String(x.peer)).sort();
}
const setKnown=(map,obj,keys)=>{for(const k of keys)if(own(obj,k))map.set(k,obj[k]);};
function seedLoro(d,v) {
  const meta=d.getMap('meta');
  meta.set('schemaVersion',SCHEMA_VERSION);
  meta.set('documentId',v.documentId);
  meta.set('kind',v.namespace.kind);
  meta.set('spaceId',v.namespace.id);
  meta.set('activeConversationId',v.activeConversationId??'');
  for(const [id,p] of Object.entries(v.pantry)){
    d.getMap('registry:pantry').set(id,true);
    setKnown(d.getMap('pantry:'+id),p,['id','name','preference','createdAt','updatedAt','deleted']);
  }
  for(const [id,r] of Object.entries(v.recipes)){
    d.getMap('registry:recipe').set(id,true);
    const map=d.getMap('recipe:'+id);
    setKnown(map,r,['id','title','description','portions','createdAt','updatedAt','deleted']);
    if(own(r,'notes'))map.set('notesJson',JSON.stringify(r.notes));
    for(const [iid,ingredient] of Object.entries(r.ingredientsById)){
      d.getMap('registry:ingredient:'+id).set(iid,true);
      setKnown(d.getMap('ingredient:'+iid),ingredient,['id','name','amount','deleted']);
    }
    const ingredients=d.getMovableList('recipe:'+id+':ingredients');
    for(const iid of r.ingredientOrder)ingredients.push(iid);
    for(const [sid,step] of Object.entries(r.stepsById)){
      d.getMap('registry:step:'+id).set(sid,true);
      setKnown(d.getMap('step:'+sid),step,['id','text','deleted']);
    }
    const steps=d.getMovableList('recipe:'+id+':steps');
    for(const sid of r.stepOrder)steps.push(sid);
  }
  for(const [id,c] of Object.entries(v.conversations)){
    d.getMap('registry:conversation').set(id,true);
    setKnown(d.getMap('conversation:'+id),c,['id','title','createdAt','updatedAt','deleted']);
    for(const [mid,m] of Object.entries(c.messagesById)){
      d.getMap('registry:message:'+id).set(mid,true);
      setKnown(d.getMap('message:'+mid),m,['id','role','content','createdAt','deleted']);
    }
    const order=d.getMovableList('conversation:'+id+':messages');
    for(const mid of c.messageOrder)order.push(mid);
  }
  for(const [id,receipt] of Object.entries(v.migrationReceipts))
    d.getMap('migrationReceipts').set(id,receipt.contentDigest);
  d.commit({message:'migration:v1→v2 seed, nonproduction'});
}
export function seed(engine,v2) {
  validateDocument(v2,v2.namespace);
  if(engine==='automerge') {
    return A.change(init(engine,'seed'),{message:'migration:v1→v2 seed',time:1700000000},d=>{
      d.state=cloneJson(v2);
    });
  }
  const d=init(engine,'seed');seedLoro(d,v2);return d;
}
function toScalar(x) {
  if(typeof x==='bigint') {
    const n=Number(x);
    if(!Number.isSafeInteger(n))throw Error('unsafe bigint');
    return n;
  }
  return x;
}
function mapJson(d,name) {
  const raw=d.getMap(name).toJSON();
  return Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,toScalar(v)]));
}
function fromLoro(d) {
  const meta=mapJson(d,'meta');
  for(const key of Object.keys(meta))assert.ok(['schemaVersion','documentId','kind','spaceId','activeConversationId'].includes(key),'unknown engine metadata field '+key);
  const pantry={}, recipes={}, conversations={}, migrationReceipts={};
  for(const id of Object.keys(mapJson(d,'registry:pantry'))) {
    pantry[id]=mapJson(d,'pantry:'+id);
  }
  for(const id of Object.keys(mapJson(d,'registry:recipe'))) {
    const r=mapJson(d,'recipe:'+id),ingredientsById={},stepsById={};
    for(const iid of Object.keys(mapJson(d,'registry:ingredient:'+id)))
      ingredientsById[iid]=mapJson(d,'ingredient:'+iid);
    for(const sid of Object.keys(mapJson(d,'registry:step:'+id)))
      stepsById[sid]=mapJson(d,'step:'+sid);
    const result={...r,ingredientsById,ingredientOrder:d.getMovableList('recipe:'+id+':ingredients').toArray(),
      stepsById,stepOrder:d.getMovableList('recipe:'+id+':steps').toArray()};
    if(own(result,'notesJson')) {
      result.notes=JSON.parse(result.notesJson);delete result.notesJson;
    }
    recipes[id]=result;
  }
  for(const id of Object.keys(mapJson(d,'registry:conversation'))) {
    const c=mapJson(d,'conversation:'+id), messagesById={};
    for(const mid of Object.keys(mapJson(d,'registry:message:'+id)))
      messagesById[mid]=mapJson(d,'message:'+mid);
    conversations[id]={...c,messagesById,messageOrder:d.getMovableList('conversation:'+id+':messages').toArray()};
  }
  for(const [id,contentDigest] of Object.entries(mapJson(d,'migrationReceipts')))
    migrationReceipts[id]={id,contentDigest,formatVersion:1};
  const allowedRoots=new Set(['meta','registry:pantry','registry:recipe','registry:conversation','migrationReceipts']);
  for(const id of Object.keys(pantry))allowedRoots.add('pantry:'+id);
  for(const [id,r] of Object.entries(recipes)) {
    for(const label of ['recipe:'+id,'registry:ingredient:'+id,'registry:step:'+id,
      'recipe:'+id+':ingredients','recipe:'+id+':steps']) allowedRoots.add(label);
    for(const iid of Object.keys(r.ingredientsById))allowedRoots.add('ingredient:'+iid);
    for(const sid of Object.keys(r.stepsById))allowedRoots.add('step:'+sid);
  }
  for(const [id,c] of Object.entries(conversations)) {
    for(const label of ['conversation:'+id,'registry:message:'+id,
      'conversation:'+id+':messages']) allowedRoots.add(label);
    for(const mid of Object.keys(c.messagesById))allowedRoots.add('message:'+mid);
  }
  for(const root of Object.keys(d.toJSON()))assert.ok(allowedRoots.has(root),'unknown CRDT root container '+root);
  return {
    schemaVersion:meta.schemaVersion,documentId:meta.documentId,
    namespace:{kind:meta.kind,id:meta.spaceId},pantry,recipes,conversations,
    activeConversationId:meta.activeConversationId||null,migrationReceipts
  };
}
export function read(engine,d,space) {
  if(engine==='automerge')assert.deepEqual(Object.keys(d).sort(),['state'],'unknown Automerge root');
  const result=engine==='automerge'?cloneJson(d.state):fromLoro(d);
  validateDocument(result,space);
  return result;
}
export function edit(engine,doc,actor,operation, ids, value) {
  const r=ids.recipeId, s=ids.stepId;
  if(engine==='automerge') {
    return A.change(doc,{message:'test:'+actor+':'+operation,time:1700000200},d=>{
      const state=d.state;
      switch(operation) {
        case 'title': case 'portions':state.recipes[r][operation]=value;break;
        case 'stepEdit':state.recipes[r].stepsById[s].text=value;break;
        case 'reorder':{
          const a=state.recipes[r].stepOrder;
          const idx=a.indexOf(s);assert.ok(idx>=0);a.splice(idx,1);a.unshift(s);break;
        }
        case 'delete':state.recipes[r].deleted=true;break;
        case 'addPantry':state.pantry[value.id]=value;break;
        case 'receipt':state.migrationReceipts[value.id]=value;break;
        case 'rogueField':state[value.key]=value.secret;break;
        default:throw Error('unsupported Automerge op '+operation);
      }
    });
  }
  switch(operation) {
    case 'title':case 'portions':doc.getMap('recipe:'+r).set(operation,value);break;
    case 'stepEdit':doc.getMap('step:'+s).set('text',value);break;
    case 'reorder':{
      const list=doc.getMovableList('recipe:'+r+':steps');
      const idx=list.toArray().indexOf(s);assert.ok(idx>=0);list.move(idx,0);break;
    }
    case 'delete':doc.getMap('recipe:'+r).set('deleted',true);break;
    case 'addPantry':
      doc.getMap('registry:pantry').set(value.id,true);
      setKnown(doc.getMap('pantry:'+value.id),value,['id','name','preference','createdAt','updatedAt','deleted']);
      break;
    case 'receipt':doc.getMap('migrationReceipts').set(value.id,value.contentDigest);break;
    case 'rogueField':doc.getMap('meta').set(value.key,value.secret);break;
    default:throw Error('unsupported Loro op '+operation);
  }
  doc.commit({message:'test:'+actor+':'+operation});
  return doc;
}
export function merge(engine,left,right){
  if(engine==='automerge') return A.merge(A.clone(left),right);
  const result=left.fork();result.import(right.export({mode:'update'}));return result;
}
export function incremental(engine,base,target){
  if(engine==='automerge') return A.getChanges(base,target).map(b=>Uint8Array.from(b));
  return [Uint8Array.from(target.export({mode:'update',from:base.oplogVersion()}))];
}
export function apply(engine,doc,bytes) {
  const target=engine==='automerge'?A.clone(doc):doc.fork();
  if(engine==='automerge')return A.applyChanges(target,[bytes])[0];
  target.import(bytes);return target;
}
export function actualAlternatives(engine,doc,recipeId,field) {
  if(engine==='automerge'){
    const alternatives=A.getConflicts(doc.state.recipes[recipeId],field)??{};
    return {values:Object.values(alternatives),operationIds:Object.keys(alternatives),frontier:frontier(engine,doc),
      evidence:'getConflicts real Automerge operation IDs'};
  }
  const name='recipe:'+recipeId,writes=[];
  for(const [peer,changes] of doc.getAllChanges()) for(const change of changes) {
    for(const op of doc.getOpsInChange({peer:String(peer),counter:change.counter})) {
      const root=op?.container?.Root??op?.container?.root;
      const map=typeof op?.container==='string'?
        (op.container.startsWith('cid:root-')&&op.container.endsWith(':Map')?op.container.slice(9,-4):null):
        root?.name??null;
      const content=op?.content?.Map??op?.content?.map??(op?.content?.type==='insert'?op.content:null);
      if(map===name&&content?.key===field)
        writes.push({value:toScalar(content.value),peer:String(peer),counter:Number(op.counter),
          id:String(op.counter)+'@'+String(peer)});
    }
  }
  const maximal=writes.filter(a=>!writes.some(b=>b!==a&&
    doc.cmpFrontiers([{peer:a.peer,counter:a.counter}],[{peer:b.peer,counter:b.counter}])===-1));
  const concurrent=maximal.some((a,i)=>maximal.slice(i+1).some(b=>
    doc.cmpFrontiers([{peer:a.peer,counter:a.counter}],[{peer:b.peer,counter:b.counter}])===undefined));
  return {values:maximal.map(x=>x.value),operationIds:maximal.map(x=>x.id),frontier:frontier(engine,doc),
    concurrent,evidence:'getAllChanges/getOpsInChange/cmpFrontiers real Loro history'};
}
