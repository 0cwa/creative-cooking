import {resolveRuntimeAuthority} from '../authority/chain.mjs';
import {openSequences} from './sequences.web.ts';

// The recipient receipt and selected authority are authenticated before the
// separate counter is made available. A pending counter has never been handed
// to a runtime, so interrupted initialization can safely resume; an active
// counter must always exist and is never recreated.
async function joinedSequences({name,storage,scope,pin,provider,deviceId,operationId,prepare}:{name:string;storage:any;scope:any;pin:string;provider:any;deviceId:string;operationId:string;prepare:boolean}) {
 if(!/^[a-z0-9-]{1,100}$/.test(name)||scope?.kind!=='household'||typeof scope.id!=='string'||!scope.id||typeof pin!=='string'||!pin||typeof deviceId!=='string'||!deviceId||typeof operationId!=='string'||!operationId)throw Error('MALFORMED');
 const locks=globalThis.navigator?.locks;if(!locks)throw Error('LOCK_UNAVAILABLE');
 return locks.request(`creative-cooking/joined-sequences/v1/${name}`,{mode:'exclusive'},async()=>{
  const found=await storage.householdRecipient.find(scope.id,operationId);if(!found.ok)throw Error('INVALID_ADMISSION');
  let resolved:any;if(!prepare){if(!found.value)throw Error('MISSING_ADMISSION');resolved=await resolveRuntimeAuthority(storage,scope,pin,provider,deviceId);const receipt=found.value,checked=await storage.householdRecipient.check(receipt);if(!checked.ok||checked.value!==true||receipt.receiptBody?.recipientDevice!==deviceId||receipt.scopeId!==scope.id)throw Error('INVALID_ADMISSION');}
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const q=indexedDB.open(`${name}-joined`,1);q.onupgradeneeded=()=>q.result.createObjectStore('enrollments');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
  const get=()=>new Promise<any>((resolve,reject)=>{const tx=db.transaction('enrollments','readonly'),q=tx.objectStore('enrollments').get(scope.id);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
  const put=(value:any)=>new Promise<void>((resolve,reject)=>{const tx=db.transaction('enrollments','readwrite');tx.objectStore('enrollments').put(value,scope.id);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>{}});
  let sequences:Awaited<ReturnType<typeof openSequences>>|undefined;
  try {
   let enrollment=await get();
   if(!enrollment){if(!prepare||found.value)throw Error('MISSING_ENROLLMENT');const established=await storage.householdRecipient.hasDevice(scope.id,deviceId);if(!established.ok||established.value)throw Error('MISSING_ENROLLMENT');enrollment={version:1,stage:'pending',scopeId:scope.id,pin,deviceId,operationId,sequenceName:`joined-${crypto.randomUUID()}`};await put(enrollment)}
   if(enrollment.version!==1||!['pending','active'].includes(enrollment.stage)||enrollment.scopeId!==scope.id||enrollment.pin!==pin||enrollment.deviceId!==deviceId||enrollment.operationId!==operationId||!/^joined-[a-z0-9-]{36}$/.test(enrollment.sequenceName))throw Error('ENROLLMENT_CONFLICT');
   if(prepare){if(enrollment.stage!=='pending'&& !found.value)throw Error('ENROLLMENT_CONFLICT');return null;}
   sequences=await openSequences(enrollment.sequenceName,[scope.id],enrollment.stage==='pending');
   if(enrollment.stage==='pending')await put({...enrollment,stage:'active'});
   return {sequences,resolved};
  } catch(e) {sequences?.close();throw e} finally {db.close()}
 });
}

export const prepareJoinedSequences=(args:Parameters<typeof joinedSequences>[0] extends infer T ? Omit<T,'prepare'> : never)=>joinedSequences({...args,prepare:true});
export const openJoinedSequences=(args:Parameters<typeof joinedSequences>[0] extends infer T ? Omit<T,'prepare'> : never)=>joinedSequences({...args,prepare:false});
