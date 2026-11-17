/** Candidate only; independent master provisioning precedes recipient transactions. */
const req=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
export async function openBrowserMaster(name:string){const o=indexedDB.open(name,1);o.onupgradeneeded=()=>o.result.createObjectStore('master');const db=await req(o);
 async function transaction<T>(write:boolean,f:(s:IDBObjectStore)=>Promise<T>){const t=db.transaction('master',write?'readwrite':'readonly'), s=t.objectStore('master');const done=new Promise<void>((resolve,reject)=>{t.oncomplete=()=>resolve();t.onabort=()=>reject(t.error??Error('abort'));t.onerror=()=>{}});try{const result=await f(s);await done;return result}catch(e){try{t.abort()}catch{} await done.catch(()=>{});throw e}}
 async function provision(id:string){const m=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await transaction(true,async s=>{if(await req(s.get('marker'))!==undefined || await req(s.get('key'))!==undefined)throw Error('LOCKED');await req(s.put(id,'marker'));await req(s.put(m,'key'));});}
 function valid(id:string,marker:any,m:any):m is CryptoKey{return marker===id && m instanceof CryptoKey && m.type==='secret' && !m.extractable && m.algorithm.name==='AES-GCM' && (m.algorithm as AesKeyAlgorithm).length===256 && m.usages.includes('encrypt') && m.usages.includes('decrypt');}
 async function ensure(id:string){
  const exists=await transaction(false,async s=>{const marker=await req(s.get('marker')),m=await req(s.get('key'));if(marker===undefined&&m===undefined)return false;if(!valid(id,marker,m))throw Error('LOCKED');return true;});
  if(exists)return;
  const fresh=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  await transaction(true,async s=>{const marker=await req(s.get('marker')),m=await req(s.get('key'));if(marker!==undefined||m!==undefined){if(!valid(id,marker,m))throw Error('LOCKED');return;}await req(s.put(id,'marker'));await req(s.put(fresh,'key'));});
 }
 async function get(id:string){return transaction(false,async s=>{const marker=await req(s.get('marker')),m=await req(s.get('key'));if(!valid(id,marker,m))throw Error('LOCKED');return m;});}
 async function wrap(id:string,plain:Uint8Array,aad:Uint8Array){const input=new Uint8Array(plain), context=new Uint8Array(aad);const m=await get(id),iv=crypto.getRandomValues(new Uint8Array(12));const c=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:context},m,input));const out=new Uint8Array(iv.length+c.length);out.set(iv);out.set(c,iv.length);return out;}
 async function unwrap(id:string,wrapped:Uint8Array,aad:Uint8Array){const input=new Uint8Array(wrapped), context=new Uint8Array(aad);const m=await get(id);return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:input.slice(0,12),additionalData:context},m,input.slice(12)));}
 return {provision,ensure,get,wrap,unwrap,close:()=>db.close()};}
