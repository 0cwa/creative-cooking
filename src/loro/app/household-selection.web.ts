import {openJoinedSequences} from './joined-sequences.web.ts';
import {selectedHousehold} from './household-selection.mjs';

const request=<T,>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
export function householdSelection({name,meta,...dependencies}:any){
 const locks=globalThis.navigator?.locks;
 if(!locks)throw Error('LOCK_UNAVAILABLE');
 return selectedHousehold({
  ...dependencies,
  openJoined:(input:any)=>openJoinedSequences({...input,name}),
  lock:<T,>(mode:'shared'|'exclusive',use:()=>Promise<T>)=>locks.request(`creative-cooking/bootstrap/v1/${name}`,{mode},use),
  readStored:()=>{
   const store=meta.transaction('metadata','readonly').objectStore('metadata');
   return Promise.all([request(store.get('selected-household')),request(store.get('selected-household-required'))]);
  },
  writeStored:async(value:Uint8Array|null)=>{
   const tx=meta.transaction('metadata','readwrite'),store=tx.objectStore('metadata');
   if(value===null){store.delete('selected-household');store.delete('selected-household-required')}
   else{store.put(value,'selected-household');store.put(1,'selected-household-required')}
   await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>{}});
  }
 });
}
