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
 const record=await readRecord(storage,scope);
 const {root}=await verifyPersonalRecord(record,scope,pin,provider);
 return resolvedPersonal(root,scope,pin,record,authorDevice);
}
function resolvedPersonal(root,scope,pin,record,authorDevice){
 const active=root.devices.filter(d=>d.active), author=active.find(d=>d.deviceId===authorDevice);
 if(!author)throw Error('UNAUTHORIZED_DEVICE');
 const acceptedAuthors=active.map(d=>d.deviceId).sort();
 const authorPeers=Object.fromEntries(active.map(d=>[d.deviceId,d.peerId]).sort(([a],[b])=>a.localeCompare(b)));
 const signingKeyRefs=Object.freeze(Object.fromEntries(active.map(d=>[d.deviceId,d.signingKeyRef]).sort(([a],[b])=>a.localeCompare(b))));
 return {devices:root.devices,rotation:root.rotation??null,signingKeyRefs,scope:{scopeId:scope.id,ownerId:root.ownerId,documentId:root.documentId,documentGeneration:root.generation,branchHead:root.branchHead??pin,authorizationSnapshot:record.authorizationSnapshot,policyHashes:[pin],epochId:root.epochId,authorDevice,acceptedAuthors,authorPeers,acceptedRecipients:[...acceptedAuthors],suiteId:root.suiteId},expectedAuthority:{version:2,scope,record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}}};
}

const admissionFields=['version','scopeId','ownerId','parentSnapshot','sponsorDeviceId','recipientDeviceId','recipientSigningKeyRef','recipientWrappingKeyRef','recipientSigningKey','recipientWrappingKey','peerId','transcriptHash','guardId'];
const key32=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
export function personalAdmissionBytes(a){if(!exact(a,admissionFields)||a.version!==1||!admissionFields.slice(1).every(k=>id(a[k]))||!key32(a.recipientSigningKey)||!key32(a.recipientWrappingKey)||a.recipientSigningKeyRef!==a.recipientSigningKey||a.recipientWrappingKeyRef!==a.recipientWrappingKey||!key32(a.transcriptHash)||!validPeer(a.peerId)||a.sponsorDeviceId===a.recipientDeviceId)throw Error('MALFORMED');return domain('personal-device-admission',canonical(a))}
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const snapshotHash=(provider,state)=>digest(provider,'personal-authority-state',state);
export const personalDataCommitment=(provider,purpose,data)=>digest(provider,`personal-rotation-${purpose}`,hex(data));
const maximumHistory=1048576;
const maximumDevices=128;
const usablePeer=p=>validPeer(p)&&p!=='18446744073709551615';
const rotationFields=['version','scopeId','ownerId','parentSnapshot','sponsorDeviceId','operationId',
 'sourceDocumentId','sourceRevision','sourceHash','documentId','generation','epochId','snapshotHash','keyHash',
 'retiredDevices','recipients','seedPeerId'];
export function personalRotationBytes(rotation){
 const r=rotation;
 if(!exact(r,rotationFields)||r.version!==1||
  ![r.scopeId,r.ownerId,r.sponsorDeviceId,r.operationId,r.sourceDocumentId,r.documentId,r.epochId].every(id)||
  ![r.parentSnapshot,r.snapshotHash,r.keyHash].every(key32)||
  !(r.sourceRevision===null?r.sourceHash===null:Number.isSafeInteger(r.sourceRevision)&&r.sourceRevision>=0&&key32(r.sourceHash))||
  !Number.isSafeInteger(r.generation)||r.generation<1||!usablePeer(r.seedPeerId)||!Array.isArray(r.retiredDevices)||r.retiredDevices.length>127||
  !Array.from(r.retiredDevices).every((d,i)=>id(d)&&(!i||r.retiredDevices[i-1]<d))||
  !Array.isArray(r.recipients)||r.recipients.length>127||!Array.from(r.recipients).every((d,i)=>
   exact(d,['deviceId','signingKey','wrappingKey','peerId','requestHash'])&&id(d.deviceId)&&
   [d.signingKey,d.wrappingKey,d.requestHash].every(key32)&&usablePeer(d.peerId)&&
   (!i||r.recipients[i-1].deviceId<d.deviceId)))throw Error('MALFORMED');
 return domain('personal-affected-key-rotation',canonical(r));
}

async function replayAdmission(root,scope,provider,previous,item){
 if(!exact(item,['admission','signature']))throw Error('MALFORMED');
 const a=item.admission,payload=personalAdmissionBytes(a),signer=root.devices.find(x=>x.active&&x.deviceId===a.sponsorDeviceId),signature=sig(item.signature);
 if(!signer||!signature||a.scopeId!==scope.id||a.ownerId!==root.ownerId||
  a.parentSnapshot!==await snapshotHash(provider,previous)||(previous.version===3&&
    (root.devices.length>=maximumDevices||!usablePeer(a.peerId)||a.peerId===root.rotation.seedPeerId))||
  root.devices.some(x=>x.deviceId===a.recipientDeviceId||x.peerId===a.peerId||
    (previous.version===3&&x.signingKeyRef===a.recipientSigningKeyRef))||
  !await provider.verify(signer.signingKeyRef,payload,signature))throw Error('INVALID_PROOF');
 root.devices.push({deviceId:a.recipientDeviceId,ownerId:a.ownerId,signingKeyRef:a.recipientSigningKeyRef,peerId:a.peerId,active:true});
}

async function replayRotation(root,scope,provider,previous,item,usedDocuments,usedEpochs){
 if(!exact(item,['rotation','signature']))throw Error('MALFORMED');
 const r=item.rotation,payload=personalRotationBytes(r),signature=sig(item.signature);
 const sponsor=root.devices.find(d=>d.active&&d.deviceId===r.sponsorDeviceId);
 if(!sponsor||!signature||r.ownerId!==root.ownerId||r.scopeId!==scope.id||
  r.parentSnapshot!==await snapshotHash(provider,previous)||r.sourceDocumentId!==root.documentId||
  r.generation!==root.generation+1||usedDocuments.has(r.documentId)||usedEpochs.has(r.epochId)||
  root.devices.some(d=>d.peerId===r.seedPeerId)||r.recipients.some(d=>d.peerId===r.seedPeerId)||
  !await provider.verify(sponsor.signingKeyRef,payload,signature))throw Error('INVALID_PROOF');
 const active=root.devices.filter(d=>d.active);
 if(active.some(d=>d.deviceId!==sponsor.deviceId&&
   (r.retiredDevices.includes(d.deviceId)===r.recipients.some(x=>x.deviceId===d.deviceId)))||
   r.retiredDevices.some(d=>d===sponsor.deviceId||!active.some(x=>x.deviceId===d))||
   r.recipients.some(d=>d.deviceId===sponsor.deviceId||r.retiredDevices.includes(d.deviceId)))throw Error('INVALID_RECIPIENTS');
 for(const d of r.recipients){
  const prior=root.devices.find(x=>x.deviceId===d.deviceId);
  if(prior){if(!prior.active||prior.signingKeyRef!==d.signingKey||prior.peerId!==d.peerId)throw Error('INVALID_RECIPIENTS');continue}
  if(root.devices.length>=maximumDevices||root.devices.some(x=>x.peerId===d.peerId||x.signingKeyRef===d.signingKey))throw Error('INVALID_RECIPIENTS');
  root.devices.push({deviceId:d.deviceId,ownerId:root.ownerId,signingKeyRef:d.signingKey,peerId:d.peerId,active:true});
 }
 const retiredKeys=new Set(root.devices.filter(d=>r.retiredDevices.includes(d.deviceId)).map(d=>d.signingKeyRef));
 for(const d of root.devices)if(r.retiredDevices.includes(d.deviceId))d.active=false;
 if(root.devices.some(d=>d.active&&retiredKeys.has(d.signingKeyRef)))throw Error('INVALID_RECIPIENTS');
 usedDocuments.add(r.documentId);usedEpochs.add(r.epochId);
 Object.assign(root,{documentId:r.documentId,generation:r.generation,epochId:r.epochId,
  branchHead:await digest(provider,'personal-rotation-head',item),rotation:structuredClone(r)});
}

/** Verify the original pinned history and each exact successor prefix. */
async function verifyPersonalHistory(state,scope,pin,provider,atSnapshot){
 if(!state||bytes(state).length>maximumHistory)throw Error('MALFORMED');
 if(state.version===1){
  const root=await verify(state,scope,pin,provider);
  if(atSnapshot&&await snapshotHash(provider,state)!==atSnapshot)throw Error('MISSING_PARENT');
  return root;
 }
 if(state.version===2){
  if(!exact(state,['version','rootState','admissions'])||!Array.isArray(state.admissions)||!state.admissions.length||state.admissions.length>127)throw Error('MALFORMED');
  const root=structuredClone(await verify(state.rootState,scope,pin,provider));let previous=state.rootState,selected;
  if(atSnapshot&&await snapshotHash(provider,previous)===atSnapshot)selected=structuredClone(root);
  for(let i=0;i<state.admissions.length;i++){
   await replayAdmission(root,scope,provider,previous,state.admissions[i]);
   previous={version:2,rootState:state.rootState,admissions:state.admissions.slice(0,i+1)};
   if(atSnapshot&&await snapshotHash(provider,previous)===atSnapshot)selected=structuredClone(root);
  }
  if(atSnapshot&&!selected)throw Error('MISSING_PARENT');
  return selected??root;
 }
 if(!exact(state,['version','base','events'])||state.version!==3||![1,2].includes(state.base?.version)||
  !Array.isArray(state.events)||!state.events.length||state.events.length>128||!state.events[0]?.rotation)throw Error('MALFORMED');
 const root=structuredClone(await verifyPersonalHistory(state.base,scope,pin,provider));
 const documents=new Set([root.documentId]),epochs=new Set([root.epochId]);
 let previous=state.base,selected;
 if(atSnapshot){
  try{selected=await verifyPersonalHistory(state.base,scope,pin,provider,atSnapshot)}
  catch(e){if(e.message!=='MISSING_PARENT')throw e}
 }
 for(let i=0;i<state.events.length;i++){
  const item=state.events[i];
  if(item?.rotation)await replayRotation(root,scope,provider,previous,item,documents,epochs);
  else await replayAdmission(root,scope,provider,previous,item);
  previous={version:3,base:state.base,events:state.events.slice(0,i+1)};
  if(atSnapshot&&await snapshotHash(provider,previous)===atSnapshot)selected=structuredClone(root);
 }
 if(atSnapshot&&!selected)throw Error('MISSING_PARENT');
 return selected??root;
}

export async function verifyPersonalRecord(record,scope,pin,provider){
 if(!record||!(record.authorityState instanceof Uint8Array)||record.authorityState.length>maximumHistory)throw Error('INVALID_AUTHORITY');
 let state;
 try{state=JSON.parse(dec.decode(record.authorityState))}catch{throw Error('MALFORMED')}
 if(!same(record.scope,scope)||hex(bytes(state))!==hex(record.authorityState)||
    record.authorizationSnapshot!==await snapshotHash(provider,state))throw Error('INVALID_AUTHORITY');
 if(state?.version!==3&&record.acceptedParent!==pin)throw Error('INVALID_AUTHORITY');
 const root=await verifyPersonalHistory(state,scope,pin,provider);
 if(record.acceptedParent!==(root.branchHead??pin))throw Error('INVALID_AUTHORITY');
 return {state,root};
}

export async function resolveHistoricalPersonalAuthority(storage,scope,pin,provider,authorDevice,atSnapshot){
 const record=await readRecord(storage,scope),{state}=await verifyPersonalRecord(record,scope,pin,provider);
 const root=atSnapshot===null&&state.version===3?
  await verifyPersonalHistory(state.base,scope,pin,provider):
  await verifyPersonalHistory(state,scope,pin,provider,atSnapshot);
 return resolvedPersonal(root,scope,pin,record,authorDevice);
}
async function readRecord(storage,scope){
 const result=await storage.readPairingAuthority(scope);
 if(!result.ok)throw Error(result.error);
 if(!result.value)throw Error('MISSING_PARENT');
 return result.value;
}
async function makeRecord(scope,pin,provider,state,revision){
 const root=await verifyPersonalHistory(state,scope,pin,provider);
 return {scope,revision,acceptedParent:root.branchHead??pin,
  authorizationSnapshot:await snapshotHash(provider,state),authorityState:bytes(state)};
}

/** Keep v1/v2 encoding for pre-rotation pairing and append to v3 afterward. */
export async function preparePersonalAdmission(storage,scope,pin,provider,item){
 const old=await readRecord(storage,scope),{state}=await verifyPersonalRecord(old,scope,pin,provider);
 item=structuredClone(item);
 const items=state.version===3?state.events:state.admissions??[];
 if(items.length&&same(items.at(-1),item)){
  if(old.revision<1)throw Error('CORRUPT');
  const previous=state.version===3?{...state,events:items.slice(0,-1)}:
   items.length===1?state.rootState:{...state,admissions:items.slice(0,-1)};
  return {expected:await makeRecord(scope,pin,provider,previous,old.revision-1),next:old,replayed:true};
 }
 const next=state.version===3?{...state,events:[...items,item]}:
  {version:2,rootState:state.version===1?state:state.rootState,admissions:[...items,item]};
 return {expected:old,next:await makeRecord(scope,pin,provider,next,old.revision+1)};
}

export async function preparePersonalRotation(expected,pin,provider,item){
 const {scope}=expected,{state}=await verifyPersonalRecord(expected,scope,pin,provider);
 item=structuredClone(item);
 const next=state.version===3?{...state,events:[...state.events,item]}:{version:3,base:state,events:[item]};
 return makeRecord(scope,pin,provider,next,expected.revision+1);
}

/** Install public history into an isolated guardian trust store. */
export async function importPersonalAuthorityHistory(storage,scope,pin,provider,state,expectedOwner,authorDevice){
 state=structuredClone(state);
 const selected=await verifyPersonalHistory(state,scope,pin,provider);
 if(selected.ownerId!==expectedOwner||!selected.devices.some(d=>d.active&&d.deviceId===authorDevice))throw Error('INVALID_AUTHORITY');
 const current=await storage.readPairingAuthority(scope);
 if(!current.ok)throw Error(current.error);
 const old=current.value;
 if(old){
  const {state:previous}=await verifyPersonalRecord(old,scope,pin,provider);
  if(same(previous,state))return {replayed:true};
  try{await verifyPersonalHistory(state,scope,pin,provider,old.authorizationSnapshot)}
  catch(e){if(e.message==='MISSING_PARENT')throw Error('CONFLICT');throw e}
 }
 const record=await makeRecord(scope,pin,provider,state,old?old.revision+1:0);
 const result=await storage.compareAndSwapPairingAuthority({expectedRevision:old?.revision??null,record});
 if(!result.ok)throw Error(result.error);
 return {replayed:false};
}
