/** Browser durability adapter. Resolve on transaction complete, never request success.
 * No connection to the application's personal storage or credentials. */
export async function indexedDBPersistence({indexedDB=globalThis.indexedDB,databaseName='creative-cooking-household-spike'}={}) {
  if(!indexedDB)throw new Error('IndexedDB unavailable');
  const database=await new Promise((resolve,reject)=>{
    const request=indexedDB.open(databaseName,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('snapshots');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('IndexedDB upgrade blocked'));
  });
  const transaction=(mode,key,bytes)=>new Promise((resolve,reject)=>{
    const tx=database.transaction('snapshots',mode);
    let result;
    const request=mode==='readonly'?tx.objectStore('snapshots').get(key):tx.objectStore('snapshots').put(bytes.slice(),key);
    request.onsuccess=()=>{result=request.result;};
    tx.oncomplete=()=>resolve(mode==='readonly'?result?.slice():undefined);
    tx.onabort=()=>reject(tx.error??new Error('IndexedDB transaction aborted'));
    tx.onerror=()=>reject(tx.error??request.error);
  });
  return {write:(key,bytes)=>transaction('readwrite',key,bytes),read:key=>transaction('readonly',key),close:()=>database.close()};
}
