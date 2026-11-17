import {candidateObjectId} from '../crypto/candidate.mjs';
// The caller pins the relay verification key and owns durable inbox/outbox transactions.
const enc=new TextEncoder();
const validId=s=>typeof s==='string' && /^[0-9a-f]{64}$/.test(s);
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
function signatureBytes(signature) {if(typeof signature!=='string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;try {const raw=Uint8Array.from(atob(signature.replace(/-/g,'+').replace(/_/g,'/')+'=='),c=>c.charCodeAt(0));const canonical=btoa(String.fromCharCode(...raw)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');return raw.length===64 && canonical===signature?raw:null;}catch{return null;}}
async function bounded(response,max) {const length=response.headers.get('content-length');if(length && (!/^\d+$/.test(length) || Number(length)>max)) throw Error('TOO_LARGE');if(!response.body) throw Error('MALFORMED');const reader=response.body.getReader();let size=0,parts=[];try {while(true){const {value,done}=await reader.read();if(done) break;size+=value.length;if(size>max) throw Error('TOO_LARGE');parts.push(value);}} finally {await reader.cancel().catch(()=>{});}const b=new Uint8Array(size);let p=0;for(const part of parts){b.set(part,p);p+=part.length;}return b;}
const parse=async(r,max=32768)=>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(r,max)));}catch(e){if(e.message==='TOO_LARGE') throw e;throw Error('MALFORMED');}};
// Import the pinned DER SubjectPublicKeyInfo from an authenticated configuration.
export async function ed25519ReceiptVerifier(spki) {
 if(!(spki instanceof Uint8Array) || spki.length!==44) throw Error('MALFORMED');
 const pinned=new Uint8Array(spki);
 const key=await crypto.subtle.importKey('spki',pinned,{name:'Ed25519'},false,['verify']);
 const relayId=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',pinned)));
 return {relayId,verifyReceipt:async(claims,signature)=>{try {const raw=signatureBytes(signature);return raw!==null && await crypto.subtle.verify('Ed25519',key,raw,enc.encode(JSON.stringify(claims)));}catch{return false;}}};
}
export function relayClient({baseUrl,mailbox,relayId,readCapability,appendCapability,expectedExpires,verifyReceipt,hashProvider,fetch:fetcher=fetch,now=Date.now,maxObject=2425344,maxPage=128}) {
 if(!validId(mailbox) || !validId(relayId) || !validId(readCapability) || !validId(appendCapability) || !Number.isSafeInteger(expectedExpires) || expectedExpires<1 || typeof now!=='function' || typeof verifyReceipt!=='function' || typeof hashProvider?.hash!=='function' || !Number.isSafeInteger(maxObject) || maxObject<1 || !Number.isSafeInteger(maxPage) || maxPage<1) throw Error('MALFORMED');
 const base=new URL(baseUrl);if(base.protocol!=='https:' && !(base.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) throw Error('HTTPS_REQUIRED');
 const endpoint=`${base.href.replace(/\/$/,'')}/v1/mailboxes/${mailbox}`;
 async function request(path,method,cap,body) {const r=await fetcher(endpoint+path,{method,headers:{authorization:`Bearer ${cap}`,...(body?{'content-type':'application/octet-stream'}:{})},body,redirect:'error'});if(!r.ok){const e=await parse(r);throw Error(typeof e.error==='string'?e.error:'HTTP_ERROR');}return r;}
 return Object.freeze({
  relayId,mailbox,
  async put(object) {if(!object || !validId(object.id) || !(object.bytes instanceof Uint8Array) || object.bytes.length>maxObject) throw Error('MALFORMED');const id=object.id,bytes=new Uint8Array(object.bytes);if(await candidateObjectId(hashProvider,bytes)!==id) throw Error('MALFORMED');const receipt=await parse(await request(`/objects/${id}`,'PUT',appendCapability,bytes));const c=receipt?.claims;if(!exact(receipt,['claims','signature']) || !exact(c,['domain','version','kind','relayId','mailbox','objectId','size','method','path','expires']) || c.domain!=='creative-cooking/relay-receipt/v1' || c.version!==1 || c.relayId!==relayId || c.method!=='PUT' || c.path!==`/v1/mailboxes/${mailbox}/objects/${id}` || c.kind!=='relay-stored' || c.mailbox!==mailbox || c.objectId!==id || c.size!==bytes.length || c.expires!==expectedExpires || !signatureBytes(receipt.signature) || !await verifyReceipt(Object.freeze({...c}),receipt.signature)) throw Error('INVALID_PROOF');const checkedAt=now();if(!Number.isSafeInteger(checkedAt) || checkedAt<0 || c.expires<=checkedAt) throw Error('EXPIRED');return receipt;},
  async get(id) {if(!validId(id)) throw Error('MALFORMED');const bytes=await bounded(await request(`/objects/${id}`,'GET',readCapability),maxObject);if(await candidateObjectId(hashProvider,bytes)!==id) throw Error('INVALID_PROOF');return {id,bytes};},
  async list({after=null,limit=32}={}) {if((after!==null && !validId(after)) || !Number.isSafeInteger(limit) || limit<1 || limit>maxPage) throw Error('MALFORMED');const query=new URLSearchParams({limit:String(limit)});if(after) query.set('after',after);const page=await parse(await request(`/log?${query}`,'GET',readCapability));if(!exact(page,['objects','cursor']) || !Array.isArray(page.objects) || page.objects.length>limit || !page.objects.every(o=>exact(o,['id','size']) && validId(o.id) && Number.isSafeInteger(o.size) && o.size>=0 && o.size<=maxObject) || page.cursor!==(page.objects.length?page.objects.at(-1).id:after) || new Set(page.objects.map(o=>o.id)).size!==page.objects.length) throw Error('INVALID_PROOF');return page;}
 });
}
