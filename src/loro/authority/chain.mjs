// Experimental authority chain. The separately provisioned root pin and provider
// are trust inputs; this module does not perform human identity enrollment.
import {validateSuccessor, validParent, domain} from './validator.mjs';
import {checkAdmissionAgreement} from './grant.mjs';
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true});
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>typeof s==='string' && /^[0-9a-f]{128}$/.test(s) ? Uint8Array.from(s.match(/../g),x=>parseInt(x,16)) : null;
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const bytes=v=>enc.encode(JSON.stringify(canonical(v)));
const digest=async(provider,purpose,v)=>{const b=await provider.hash(domain(purpose,canonical(v)));if (!(b instanceof Uint8Array)||b.length!==32) throw Error('INVALID_PROOF');return hex(b)};
const read=async(storage,scope)=>{const r=await storage.readPairingAuthority(scope);if(!r.ok)throw Error(r.error);return r.value};
const write=async(storage,expectedRevision,record)=>{const r=await storage.compareAndSwapPairingAuthority({expectedRevision,record});if(!r.ok)throw Error(r.error)};
const copy=v=>structuredClone(v);
export const authorityRootId=(provider,root)=>rootPin(provider,root);
export const policyId=(provider,policy)=>digest(provider,'policy',policy);
const snapshotId=(provider,state)=>digest(provider,'authority-state',state);

/** Replay every signed event from a locally pinned, explicitly preaccepted genesis. */
export async function verifyAuthority(state,pin,provider) {
 state=copy(state);
 if (!state || Array.isArray(state) || !['activeHead,events,root,selections,version','activeHead,agreements,events,root,selections,version'].includes(Object.keys(state).sort().join(',')) || state.version!==1 || !Array.isArray(state.events) || state.events.length>128 || !Array.isArray(state.selections) || state.selections.length>128 || typeof state.activeHead!=='string') throw Error('MALFORMED');
 if (!validParent(state.root) || await authorityRootId(provider,state.root)!==pin || state.root.head!==pin || state.root.policyHash!==await policyId(provider,state.root.policy)) throw Error('INVALID_ROOT');
 // A root head is the digest of the root payload excluding its self-reference.
 const nodes=new Map([[pin,state.root]]);
 for(const item of state.events) {
  if (!item || Array.isArray(item) || Object.keys(item).sort().join(',')!=='approvals,authorSignature,event') throw Error('MALFORMED');
  const parent=nodes.get(item.event?.parentHead); if (!parent) throw Error('MISSING_PARENT');
  const r=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
  if(r.status!=='validated' || item.event.kind!=='changePolicy') throw Error(r.reason || 'UNSUPPORTED_TRANSITION');
  if(nodes.has(r.eventHash)) throw Error('DUPLICATE_EVENT');
  nodes.set(r.eventHash,{...copy(parent),head:r.eventHash,policy:copy(item.event.nextPolicy),policyHash:await policyId(provider,item.event.nextPolicy)});
 }
 const agreements=state.agreements ?? [];
 if(!Array.isArray(agreements) || agreements.length>128 || !Array.from({length:agreements.length},(_,i)=>Object.hasOwn(agreements,i)).every(Boolean)) throw Error('MALFORMED');
 const agreementHashes=new Set();
 for(const agreement of agreements) {
  const parent=nodes.get(agreement?.parentHead); if(!parent) throw Error('MISSING_PARENT');
  const result=await checkAdmissionAgreement(parent,agreement,provider);
  if(result.status!=='accepted' || agreementHashes.has(result.delegationHash)) throw Error('INVALID_AGREEMENT');
  agreementHashes.add(result.delegationHash);
 }
 let active=pin;
 for (const [index, selection] of state.selections.entries()) {
  if (!selection || Array.isArray(selection) || Object.keys(selection).sort().join(',')!=='deviceId,from,index,signature,to' || selection.index!==index || selection.from!==active || !nodes.has(selection.to)) throw Error('INVALID_SELECTION');
  const signer=nodes.get(active).devices.find(d=>d.deviceId===selection.deviceId && d.active);
  const sig=unhex(selection.signature), payload={root:pin,householdId:state.root.householdId,from:selection.from,to:selection.to,deviceId:selection.deviceId,index};
  if (!signer || !sig || !await provider.verify(signer.signingKeyRef,domain('select-head',payload),sig)) throw Error('INVALID_SELECTION');
  active=selection.to;
 }
 if(active!==state.activeHead)throw Error('MISSING_ACTIVE_HEAD');
 return {nodes,state};
}
// Hash excludes head so genesis is not self-referential.
export async function rootPin(provider,root) { const r=copy(root); delete r.head; return digest(provider,'root',r); }

/** Initialize only an explicitly pinned root. The caller owns authorization to bootstrap. */
export async function initializeAuthority(storage,root,pin,provider) {
 root=copy(root);
 if (await rootPin(provider,root)!==pin || root.head!==pin || root.policyHash!==await policyId(provider,root.policy)) throw Error('INVALID_ROOT');
 const state={version:1,root,events:[],selections:[],activeHead:pin};
 await verifyAuthority(state,pin,provider);
 const scope={kind:'household',id:root.householdId};
 await write(storage,null,{scope,revision:0,acceptedParent:pin,authorizationSnapshot:await snapshotId(provider,state),authorityState:bytes(state)});
}
async function load(storage,scope,pin,provider) {
 const record=await read(storage,scope); if(!record)throw Error('MISSING_PARENT');
 let state; try {state=JSON.parse(dec.decode(record.authorityState));}catch {throw Error('MALFORMED');}
 if (hex(bytes(state))!==hex(record.authorityState) || record.acceptedParent!==state.activeHead || record.authorizationSnapshot!==await snapshotId(provider,state) || state.root?.householdId!==scope.id) throw Error('INVALID_AUTHORITY');
 return {record,...await verifyAuthority(state,pin,provider)};
}
export async function readAuthority(storage,scope,pin,provider) {
 const {record,state,nodes}=await load(storage,scope,pin,provider);
 return {revision:record.revision,activeHead:state.activeHead,heads:[...nodes.keys()].filter(h=>!state.events.some(e=>e.event.parentHead===h)),state};
}
async function save(storage,record,state,provider) {
 if(record.revision===Number.MAX_SAFE_INTEGER)throw Error('CONFLICT');
 await write(storage,record.revision,{scope:record.scope,revision:record.revision+1,acceptedParent:state.activeHead,authorizationSnapshot:await snapshotId(provider,state),authorityState:bytes(state)});
}
/** Persist a signed child without selecting it; competing children remain visible. */
export async function observeSuccessor(storage,scope,pin,provider,item) {
 item=copy(item); const {record,state,nodes}=await load(storage,scope,pin,provider);
 const parent=nodes.get(item.event?.parentHead); if(!parent)throw Error('MISSING_PARENT');
 const r=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
 if(r.status!=='validated')throw Error(r.reason);
 if(item.event.kind!=='changePolicy')throw Error('UNSUPPORTED_TRANSITION');
 if(nodes.has(r.eventHash))throw Error('DUPLICATE_EVENT');
 state.events.push(item); await verifyAuthority(state,pin,provider); await save(storage,record,state,provider); return r.eventHash;
}
/** Signature is from an active device on the currently selected branch. */
export async function selectHead(storage,scope,pin,provider,selection) {
 selection=copy(selection); const {record,state}=await load(storage,scope,pin,provider);
 if(selection.from!==state.activeHead)throw Error('CONFLICT');
 state.selections.push(selection); state.activeHead=selection.to;
 await verifyAuthority(state,pin,provider); await save(storage,record,state,provider);
}
/** Resolve only from a pinned and replayed selected head, never from runtime options. */
export async function resolveRuntimeAuthority(storage,scope,pin,provider,authorDevice) {
 const {record,state,nodes}=await load(storage,scope,pin,provider), selected=nodes.get(state.activeHead);
 const acceptedAuthors=selected.devices.filter(d=>d.active).map(d=>d.deviceId).sort();
 if(!acceptedAuthors.includes(authorDevice))throw Error('UNAUTHORIZED_DEVICE');
 const runtimeScope={scopeId:scope.id,documentId:selected.runtime.documentId,documentGeneration:selected.generation,branchHead:state.activeHead,authorizationSnapshot:record.authorizationSnapshot,policyHashes:[selected.policyHash],epochId:selected.epochId,authorDevice,acceptedAuthors,authorPeers:copy(selected.runtime.authorPeers),acceptedRecipients:copy(selected.runtime.acceptedRecipients),suiteId:'candidate-ed25519-xchacha20-sealedbox-v1'};
 return {scope:runtimeScope,expectedAuthority:{version:2,scope:copy(scope),record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}}};
}

/** Persist explicit acceptance at the currently selected frozen parent. */
export async function acceptAdmissionAgreement(storage,scope,pin,provider,agreement) {
 agreement=copy(agreement); const {record,state,nodes}=await load(storage,scope,pin,provider);
 if(agreement.parentHead!==state.activeHead) throw Error('CONFLICT');
 const result=await checkAdmissionAgreement(nodes.get(state.activeHead),agreement,provider);
 if(result.status!=='accepted') throw Error(result.reason);
 state.agreements ??= []; state.agreements.push(agreement);
 await verifyAuthority(state,pin,provider); await save(storage,record,state,provider);
 return result.delegationHash;
}
