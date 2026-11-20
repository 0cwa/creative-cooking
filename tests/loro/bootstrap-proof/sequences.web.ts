// A reserved number may be skipped after a crash, but an operation retry always
// receives the same number. This store contains identifiers only, never keys.
const req=<T,>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
export async function openSequences(name:string,scopes:string[],create=false) {
 if(!/^[a-z0-9-]{1,100}$/.test(name)||!Array.isArray(scopes)||!scopes.length||new Set(scopes).size!==scopes.length||!scopes.every(x=>typeof x==='string'&&x.length>0&&x.length<=256))throw Error('MALFORMED');
 const opening=indexedDB.open(`${name}-sequences`,1);opening.onupgradeneeded=()=>{if(!create){opening.transaction?.abort();return}const store=opening.result.createObjectStore('sequences');store.put(1,'format');for(const scope of scopes)store.put(0,JSON.stringify(['counter',scope]))};let db:IDBDatabase;try{db=await req(opening)}catch{throw Error('MISSING_SEQUENCES')}
 const store=db.transaction('sequences','readonly').objectStore('sequences');const checks=await Promise.all([req(store.get('format')),...scopes.map(scope=>req(store.get(JSON.stringify(['counter',scope]))))]);if(checks[0]!==1||checks.slice(1).some(v=>!Number.isSafeInteger(v)||v<0)){db.close();throw Error('MISSING_SEQUENCES')}
 return {close:()=>db.close(),reserve:(scope:string,operation:string)=>{
  if(!scopes.includes(scope)||!operation||operation.length>256)throw Error('MALFORMED');
  return new Promise<number>((resolve,reject)=>{const tx=db.transaction('sequences','readwrite'),store=tx.objectStore('sequences'),slot=JSON.stringify(['operation',scope,operation]),counter=JSON.stringify(['counter',scope]);let sequence:number;
   const existing=store.get(slot);existing.onsuccess=()=>{if(existing.result!==undefined){if(!Number.isSafeInteger(existing.result)||existing.result<1){tx.abort();return}sequence=existing.result;return}const current=store.get(counter);current.onsuccess=()=>{const value=current.result;if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER){tx.abort();return}sequence=value+1;store.put(sequence,counter);store.put(sequence,slot)}};
   tx.oncomplete=()=>resolve(sequence);tx.onabort=()=>reject(tx.error??Error('SEQUENCE_FAILED'));tx.onerror=()=>{};
  });
 }};
}
