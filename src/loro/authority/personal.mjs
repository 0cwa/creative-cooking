// Experimental separately pinned personal root; no human enrollment claim.
import {domain} from './validator.mjs';
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true});
const id=x=>typeof x==='string' && !!x && enc.encode(x).length<=256;
const exact=(v,ks)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===ks.length && ks.every(k=>Object.hasOwn(v,k));
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const bytes=v=>enc.encode(JSON.stringify(canonical(v)));
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const sig=s=>typeof s==='string' && /^[0-9a-f]{128}$/.test(s)?Uint8Array.from(s.match(/../g),x=>parseInt(x,16)):null;
const digest=async(provider,purpose,v)=>{const b=await provider.hash(domain(purpose,canonical(v)));if(!(b instanceof Uint8Array)||b.length!==32)throw Error('INVALID_PROOF');return hex(b)};
export const personalRootPin=(provider,root)=>digest(provider,'personal-root',root);
const validPeer=p=>typeof p==='string' && p.length<=20 && /^(0|[1-9][0-9]*)$/.test(p) && BigInt(p)<=18446744073709551615n;
function validate(root) {
 if(!exact(root,['version','suiteId','scopeId','ownerId','signerDeviceId','devices','documentId','generation','epochId']) || root.version!==1 || root.suiteId!=='candidate-ed25519-xchacha20-sealedbox-v1' || ![root.scopeId,root.ownerId,root.signerDeviceId,root.documentId,root.epochId].every(id) || !Number.isSafeInteger(root.generation) || root.generation<0 || !Array.isArray(root.devices) || !root.devices.length || root.devices.length>128)throw Error('MALFORMED');
 if(!root.devices.every(d=>exact(d,['deviceId','ownerId','signingKeyRef','peerId','active']) && [d.deviceId,d.signingKeyRef].every(id) && d.ownerId===root.ownerId && validPeer(d.peerId) && typeof d.active==='boolean') || new Set(root.devices.map(d=>d.deviceId)).size!==root.devices.length || new Set(root.devices.map(d=>d.peerId)).size!==root.devices.length)throw Error('MALFORMED');
}
async function verify(state,scope,pin,provider) {
 if(!exact(state,['version','root','signature']) || state.version!==1)throw Error('MALFORMED');
 const root=state.root; validate(root);
 if(scope.kind!=='personal' || root.scopeId!==scope.id || await personalRootPin(provider,root)!==pin)throw Error('INVALID_ROOT');
 const signer=root.devices.find(d=>d.deviceId===root.signerDeviceId && d.active), signature=sig(state.signature);
 if(!signer || !signature || !await provider.verify(signer.signingKeyRef,domain('personal-root-signature',canonical(root)),signature))throw Error('INVALID_PROOF');
 return root;
}
/** Provisioning requires an independently authenticated pin; no household vote. */
export async function initializePersonalAuthority(storage,scope,pin,provider,state) {
 state=structuredClone(state); await verify(state,scope,pin,provider);
 const authorizationSnapshot=await digest(provider,'personal-authority-state',state);
 const result=await storage.compareAndSwapPairingAuthority({expectedRevision:null,record:{scope,revision:0,acceptedParent:pin,authorizationSnapshot,authorityState:bytes(state)}});
 if(!result.ok)throw Error(result.error);
}
export async function resolvePersonalAuthority(storage,scope,pin,provider,authorDevice) {
 scope=structuredClone(scope); if(!exact(scope,['kind','id']) || scope.kind!=='personal' || !id(scope.id))throw Error('INVALID_ROOT');
 const result=await storage.readPairingAuthority(scope); if(!result.ok)throw Error(result.error); const record=result.value; if(!record)throw Error('MISSING_PARENT');
 let state; try {state=JSON.parse(dec.decode(record.authorityState))}catch{throw Error('MALFORMED')}
 if(hex(bytes(state))!==hex(record.authorityState) || record.acceptedParent!==pin || record.authorizationSnapshot!==await digest(provider,'personal-authority-state',state))throw Error('INVALID_AUTHORITY');
 const root=await verify(state,scope,pin,provider), active=root.devices.filter(d=>d.active), author=active.find(d=>d.deviceId===authorDevice);
 if(!author)throw Error('UNAUTHORIZED_DEVICE');
 const acceptedAuthors=active.map(d=>d.deviceId).sort();
 const authorPeers=Object.fromEntries(active.map(d=>[d.deviceId,d.peerId]).sort(([a],[b])=>a.localeCompare(b)));
 return {scope:{scopeId:scope.id,ownerId:root.ownerId,documentId:root.documentId,documentGeneration:root.generation,branchHead:pin,authorizationSnapshot:record.authorizationSnapshot,policyHashes:[pin],epochId:root.epochId,authorDevice,acceptedAuthors,authorPeers,acceptedRecipients:[...acceptedAuthors],suiteId:root.suiteId},expectedAuthority:{version:2,scope,record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}}};
}
