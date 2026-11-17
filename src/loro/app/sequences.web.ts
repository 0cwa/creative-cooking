// Allocations are immutable. Gaps are allowed, but surviving allocations must
// never overlap or exceed the counter used for the next reservation.
const req=<T,>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&new TextEncoder().encode(value).length<=256;
function validScopes(value:unknown):value is string[]{
 if(!Array.isArray(value)||!value.length)return false;
 const seen=new Set<string>();
 for(let i=0;i<value.length;i++){if(!Object.hasOwn(value,i)||!id(value[i])||seen.has(value[i]))return false;seen.add(value[i]);}
 return true;
}
function snapshot(keys:IDBValidKey[],values:unknown[],scopes:readonly string[]){
 if(keys.length!==values.length)throw Error('SEQUENCE_CORRUPT');
 const counters=new Map<string,number>(),operations=new Map<string,number>();let format=false;
 for(let i=0;i<keys.length;i++){
  const key=keys[i],value=values[i];
  if(key==='format'){if(value!==1)throw Error('SEQUENCE_CORRUPT');format=true;continue;}
  if(typeof key!=='string')throw Error('SEQUENCE_CORRUPT');
  let parts:any;try{parts=JSON.parse(key)}catch{throw Error('SEQUENCE_CORRUPT')}
  if(!Array.isArray(parts)||JSON.stringify(parts)!==key||!scopes.includes(parts[1])||!Number.isSafeInteger(value))throw Error('SEQUENCE_CORRUPT');
  if(parts[0]==='counter'&&parts.length===2){if((value as number)<0)throw Error('SEQUENCE_CORRUPT');counters.set(parts[1],value as number);}
  else if(parts[0]==='operation'&&parts.length===3&&id(parts[2])){if((value as number)<1)throw Error('SEQUENCE_CORRUPT');operations.set(key,value as number);}
  else throw Error('SEQUENCE_CORRUPT');
 }
 if(!format||scopes.some(scope=>!counters.has(scope)))throw Error('MISSING_SEQUENCES');
 const allocated=new Map(scopes.map(scope=>[scope,new Set<number>()]));
 for(const [key,number] of operations){const scope=JSON.parse(key)[1],used=allocated.get(scope)!;if(number>counters.get(scope)!||used.has(number))throw Error('SEQUENCE_CORRUPT');used.add(number);}
 return {counters,operations};
}
async function inspect(store:IDBObjectStore,scopes:readonly string[]){const [keys,values]=await Promise.all([req(store.getAllKeys()),req(store.getAll())]);return snapshot(keys,values,scopes);}
export async function openSequences(name:string,scopes:string[],create=false){
 if(typeof name!=='string'||!/^[a-z0-9-]{1,100}$/.test(name)||!validScopes(scopes)||typeof create!=='boolean')throw Error('MALFORMED');
 scopes=[...scopes];
 const opening=indexedDB.open(`${name}-sequences`,1);
 opening.onupgradeneeded=()=>{if(!create){opening.transaction?.abort();return;}const store=opening.result.createObjectStore('sequences');store.put(1,'format');for(const scope of scopes)store.put(0,JSON.stringify(['counter',scope]));};
 let db:IDBDatabase;try{db=await req(opening)}catch{throw Error('MISSING_SEQUENCES')}
 try{await inspect(db.transaction('sequences','readonly').objectStore('sequences'),scopes)}catch(error){db.close();throw error;}
 return {close:()=>db.close(),reserve:(scope:string,operation:string)=>{
  if(!scopes.includes(scope)||!id(operation))throw Error('MALFORMED');
  return new Promise<number>((resolve,reject)=>{
   const tx=db.transaction('sequences','readwrite'),store=tx.objectStore('sequences'),slot=JSON.stringify(['operation',scope,operation]);let sequence:number|undefined,failure:unknown;
   tx.oncomplete=()=>sequence===undefined?reject(Error('SEQUENCE_FAILED')):resolve(sequence);
   tx.onabort=()=>reject(failure??tx.error??Error('SEQUENCE_FAILED'));tx.onerror=()=>{};
   inspect(store,scopes).then(state=>{
    const existing=state.operations.get(slot);if(existing!==undefined){sequence=existing;return;}
    const counter=state.counters.get(scope)!;if(counter>=Number.MAX_SAFE_INTEGER)throw Error('SEQUENCE_EXHAUSTED');
    sequence=counter+1;store.put(sequence,JSON.stringify(['counter',scope]));store.put(sequence,slot);
   }).catch(error=>{failure=error;try{tx.abort()}catch{reject(error)}});
  });
 }};
}
