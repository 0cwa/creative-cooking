// Experimental authority chain. The separately provisioned root pin and provider
// are trust inputs; this module does not perform human identity enrollment.
import {validateSuccessor, validParent, domain} from './validator.mjs';
import {checkAdmissionAgreement, checkGrantSignatures, checkGrantManifest} from './grant.mjs';
import {checkHouseholdCeremonies,checkExistingRecipientCeremonies} from './ceremony.mjs';
import sodium from 'libsodium-wrappers';
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true});
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>typeof s==='string' && /^[0-9a-f]{128}$/.test(s) ? Uint8Array.from(s.match(/../g),x=>parseInt(x,16)) : null;
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const bytes=v=>enc.encode(JSON.stringify(canonical(v)));
const digest=async(provider,purpose,v)=>{const b=await provider.hash(domain(purpose,canonical(v)));if (!(b instanceof Uint8Array)||b.length!==32) throw Error('INVALID_PROOF');return hex(b)};
const read=async(storage,scope)=>{const r=await storage.readPairingAuthority(scope);if(!r.ok)throw Error(r.error);return r.value};
const write=async(storage,expectedRevision,record)=>{const r=await storage.compareAndSwapPairingAuthority({expectedRevision,record});if(!r.ok)throw Error(r.error)};
const copy=v=>structuredClone(v);
const encodeEvidence=v=>v instanceof Uint8Array?{__bytes:hex(v)}:Array.isArray(v)?v.map(encodeEvidence):v && typeof v==='object'?Object.fromEntries(Object.keys(v).map(k=>[k,encodeEvidence(v[k])])):v;
const decodeEvidence=v=>Array.isArray(v)?v.map(decodeEvidence):v && typeof v==='object'?(Object.keys(v).length===1 && typeof v.__bytes==='string' && /^[0-9a-f]*$/.test(v.__bytes) && v.__bytes.length%2===0?Uint8Array.from(v.__bytes.match(/../g) ?? [],x=>parseInt(x,16)):Object.fromEntries(Object.keys(v).map(k=>[k,decodeEvidence(v[k])]))):v;
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
  if (!item || Array.isArray(item) || !['approvals,authorSignature,event','admission,approvals,authorSignature,event'].includes(Object.keys(item).sort().join(','))) throw Error('MALFORMED');
  const parent=nodes.get(item.event?.parentHead); if (!parent) throw Error('MISSING_PARENT');
  const r=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
  if(item.event.kind==='changePolicy') {
   if(r.status!=='validated' || Object.hasOwn(item,'admission')) throw Error(r.reason || 'UNSUPPORTED_TRANSITION');
   if(nodes.has(r.eventHash)) throw Error('DUPLICATE_EVENT');
   nodes.set(r.eventHash,{...copy(parent),head:r.eventHash,policy:copy(item.event.nextPolicy),policyHash:await policyId(provider,item.event.nextPolicy)});
  } else if(item.event.kind==='inviteAdult' && item.event.version===2 && r.reason==='ADMISSION_AND_PROJECTION_REQUIRED') {
   const a=item.admission,subject=item.event.subject;
   if(!a || Array.isArray(a) || Object.keys(a).sort().join(',')!=='ceremonies,existingCeremonies,grant,localDeviceId,manifest,operationId' || a.grant?.admissionEventHash!==r.eventHash || a.grant?.recipientAdult!==subject.adultId || a.grant?.newDocumentGeneration!==subject.newGeneration || a.grant?.newEpochId!==subject.newEpochId || a.manifest?.newDocumentId!==subject.documentId || a.manifest?.newGeneration!==subject.newGeneration || JSON.stringify(a.grant?.recipientDevices)!==JSON.stringify(subject.devices.map(d=>d.deviceId)) || !parent.runtime.acceptedRecipients.includes(a.localDeviceId)) throw Error('INVALID_ADMISSION');
   const grantProof=await checkGrantSignatures(parent,a.grant,provider);
   if(grantProof.reason!=='ADMISSION_EVIDENCE_REQUIRED' || await digest(provider,'projection-manifest',a.manifest)!==a.grant.projectionManifestHash || JSON.stringify(a.manifest.sourcePolicyHashes)!==JSON.stringify(a.grant.sourcePolicyHashes)) throw Error('INVALID_ADMISSION');
   let accepted=false;
   for(const agreement of state.agreements ?? []) {if(agreement.parentHead!==parent.head)continue;const v=await checkAdmissionAgreement(parent,agreement,provider);if(v.status==='accepted' && v.delegationHash===a.grant.delegationHash && JSON.stringify(agreement.sourcePolicyHashes)===JSON.stringify(a.grant.sourcePolicyHashes))accepted=true;}
   if(!accepted) throw Error('INVALID_AGREEMENT');
   await sodium.ready; const ceremonies=decodeEvidence(a.ceremonies),existing=decodeEvidence(a.existingCeremonies),snapshot=ceremonies[0]?.transcript?.authorizationSnapshot;
   const verified=await checkHouseholdCeremonies(sodium,parent,snapshot,a.grant,ceremonies,provider), oldDevices=await checkExistingRecipientCeremonies(sodium,parent,snapshot,a.grant,existing,provider);
   if([...ceremonies,...existing].some(e=>e.context.sponsorDeviceId!==a.localDeviceId)) throw Error('INVALID_ADMISSION');
   if(subject.devices.some((d,i)=>d.deviceId!==verified[i]?.deviceId || d.signingKeyRef!==verified[i]?.signingKeyRef || d.wrappingKeyRef!==verified[i]?.wrappingKeyRef) || JSON.stringify(oldDevices.map(d=>d.deviceId).sort())!==JSON.stringify(parent.runtime.acceptedRecipients.filter(d=>d!==a.localDeviceId)) || new Set([...verified,...oldDevices].map(d=>d.guardId)).size!==verified.length+oldDevices.length) throw Error('INVALID_ADMISSION');
   if(nodes.has(r.eventHash)) throw Error('DUPLICATE_EVENT');
   if([...nodes.values()].some(n=>n.epochId===subject.newEpochId || n.runtime.documentId===subject.documentId)) throw Error('INVALID_ADMISSION');
   const child=copy(parent);child.head=r.eventHash;child.generation=subject.newGeneration;child.epochId=subject.newEpochId;child.roster=[...parent.roster,subject.adultId].sort();
   child.devices.push(...subject.devices.map(d=>({adultId:subject.adultId,deviceId:d.deviceId,signingKeyRef:d.signingKeyRef,active:true})));
   child.runtime.documentId=subject.documentId;for(const d of subject.devices) child.runtime.authorPeers[d.deviceId]=d.peerId;
   child.runtime.acceptedRecipients=[...parent.runtime.acceptedRecipients,...subject.devices.map(d=>d.deviceId)].sort();
   if(!validParent(child)) throw Error('INVALID_ADMISSION');nodes.set(r.eventHash,child);
  } else throw Error(r.reason || 'UNSUPPORTED_TRANSITION');
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
 const verified=await verifyAuthority(state,pin,provider);
 for(const item of state.events) if(item.admission) {
  const saved=await storage.getProjectionPublication(scope.id,item.admission.operationId);
  if(!saved.ok || !saved.value) throw Error('INVALID_AUTHORITY');
  const p=saved.value, eventHash=await digest(provider,'event',item.event);
  let published;try{published=JSON.parse(dec.decode(p.nextAuthority.authorityState))}catch{throw Error('INVALID_AUTHORITY')}
  if(p.admissionEventHash!==eventHash || p.nextAuthority.acceptedParent!==eventHash || p.expectedAuthority.record?.acceptedParent!==item.event.parentHead || p.grantHash!==await digest(provider,'current-state-grant',Object.fromEntries(Object.entries(item.admission.grant).filter(([k])=>k!=='signatures'))) || p.manifest.id!==item.admission.grant.projectionManifestHash || hex(p.manifest.bytes)!==hex(bytes(item.admission.manifest)) || !published.events?.some(e=>JSON.stringify(canonical(e))===JSON.stringify(canonical(item)))) throw Error('INVALID_AUTHORITY');
 }
 return {record,...verified};
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
 const signingKeyRefs=Object.freeze(Object.fromEntries(selected.devices.filter(d=>d.active).map(d=>[d.deviceId,d.signingKeyRef]).sort(([a],[b])=>a.localeCompare(b))));
 return {scope:runtimeScope,signingKeyRefs,expectedAuthority:{version:2,scope:copy(scope),record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}}};
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

/** Resolve admission evidence from the current pinned authority, without releasing keys. */
export async function checkCurrentAdmission(storage,scope,pin,provider,item,grant,manifest,snapshot) {
 item=copy(item); grant=copy(grant); manifest=copy(manifest); snapshot=new Uint8Array(snapshot);
 const {record,state,nodes}=await load(storage,scope,pin,provider), parent=nodes.get(state.activeHead);
 if(item?.event?.kind!=='inviteAdult' || item.event.parentHead!==state.activeHead) throw Error('CONFLICT');
 const admission=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
 if(admission.reason!=='ADMISSION_AND_PROJECTION_REQUIRED') throw Error(admission.reason || 'INVALID_ADMISSION');
 if(grant.admissionEventHash!==admission.eventHash || grant.recipientAdult!==item.event.subject.adultId) throw Error('CONTEXT_MISMATCH');
 const proof=await checkGrantSignatures(parent,grant,provider);
 if(proof.reason!=='ADMISSION_EVIDENCE_REQUIRED') throw Error(proof.reason || 'INVALID_PROOF');
 let accepted=false;
 for(const agreement of state.agreements ?? []) {
  if(agreement.parentHead!==state.activeHead) continue;
  const r=await checkAdmissionAgreement(parent,agreement,provider);
  if(r.status==='accepted' && r.delegationHash===grant.delegationHash && JSON.stringify(agreement.sourcePolicyHashes)===JSON.stringify(grant.sourcePolicyHashes)) accepted=true;
 }
 if(!accepted) throw Error('DELEGATION_REQUIRED');
 const association=await checkGrantManifest(parent,grant,manifest,snapshot,provider);
 if(association.reason!=='SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED') throw Error(association.reason || 'INVALID_MANIFEST');
 return {status:'pending',reason:'CEREMONY_AND_SOURCE_EVIDENCE_REQUIRED',admissionEventHash:admission.eventHash,grantHash:proof.grantHash,authorityRevision:record.revision,authorizationSnapshot:record.authorizationSnapshot};
}

/** Verify the complete proof bundle at the selected parent. This does not publish
 * or create a successor; those require the atomic guarded publication transaction. */
export async function checkAdmissionProofs(storage,scope,pin,provider,sodium,item,grant,manifest,snapshot,ceremonies,existingCeremonies,localDeviceId) {
 if(item?.event?.version!==2 || item.event.kind!=='inviteAdult') throw Error('UNSUPPORTED_TRANSITION');
 const proof=await checkCurrentAdmission(storage,scope,pin,provider,item,grant,manifest,snapshot);
 const {record,state,nodes}=await load(storage,scope,pin,provider);
 if(state.activeHead!==item.event.parentHead || record.revision!==proof.authorityRevision || record.authorizationSnapshot!==proof.authorizationSnapshot) throw Error('CONFLICT');
 const parent=nodes.get(state.activeHead);
 if([...nodes.values()].some(n=>n.epochId===grant.newEpochId || n.runtime.documentId===manifest.newDocumentId)) throw Error('CONFLICT');
 const devices=await checkHouseholdCeremonies(sodium,parent,record.authorizationSnapshot,grant,ceremonies,provider);
 if(!parent.runtime.acceptedRecipients.includes(localDeviceId)) throw Error('UNAUTHORIZED_DEVICE');
 const existingDevices=await checkExistingRecipientCeremonies(sodium,parent,record.authorizationSnapshot,grant,existingCeremonies,provider);
 const expectedExisting=parent.runtime.acceptedRecipients.filter(d=>d!==localDeviceId);
 if(JSON.stringify(existingDevices.map(d=>d.deviceId).sort())!==JSON.stringify(expectedExisting) || new Set([...devices,...existingDevices].map(d=>d.guardId)).size!==devices.length+existingDevices.length) throw Error('CEREMONY_REQUIRED');
 const {checkProjectionSource}=await import('../projection/source.mjs');
 const expectedAuthority={version:2,scope:copy(scope),record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}};
 const subject=item.event.subject;
 if(subject.documentId!==manifest.newDocumentId || subject.newGeneration!==grant.newDocumentGeneration || subject.newEpochId!==grant.newEpochId || JSON.stringify(subject.devices.map(d=>d.deviceId))!==JSON.stringify(grant.recipientDevices) || subject.devices.some((d,i)=>d.deviceId!==devices[i]?.deviceId || d.signingKeyRef!==devices[i]?.signingKeyRef || d.wrappingKeyRef!==devices[i]?.wrappingKeyRef)) throw Error('CONTEXT_MISMATCH');
 const source=await checkProjectionSource(storage,expectedAuthority,manifest,grant,snapshot,provider);
 return {status:'pending',reason:'ATOMIC_SUCCESSOR_REQUIRED',admissionEventHash:proof.admissionEventHash,grantHash:proof.grantHash,expectedAuthority,sourceDocument:source.sourceDocument,devices,existingDevices};
}

/** Verify, then commit the fresh projection, key packages, guard consumption and
 * selected successor in one transaction. A saved retry is checked before RNG. */
export async function publishHouseholdAdmission(input) {
 const {storage,scope,pin,provider,master,operationId,keyOperationId,localDeviceId,signingSecret}=input;
 const {item,grant,manifest,snapshot,ceremonies,existingCeremonies,selection,pendingEdits}=structuredClone({item:input.item,grant:input.grant,manifest:input.manifest,snapshot:input.snapshot,ceremonies:input.ceremonies,existingCeremonies:input.existingCeremonies,selection:input.selection,pendingEdits:input.pendingEdits});
 await sodium.ready;
 const saved=await storage.getProjectionPublication(scope.id,operationId);if(!saved.ok)throw Error(saved.error);
 const packed={...item,admission:{grant,manifest,ceremonies:encodeEvidence(ceremonies),existingCeremonies:encodeEvidence(existingCeremonies),localDeviceId,operationId}};
 if(saved.value) {
  const p=saved.value;let state;try{state=JSON.parse(dec.decode(p.nextAuthority.authorityState))}catch{throw Error('CORRUPT')}
  const replayed=await verifyAuthority(state,pin,provider);
  const current=(await load(storage,scope,pin,provider)).record;
  if(!current || current.revision!==p.nextAuthority.revision || current.acceptedParent!==p.nextAuthority.acceptedParent || current.authorizationSnapshot!==p.nextAuthority.authorizationSnapshot || hex(current.authorityState)!==hex(p.nextAuthority.authorityState) || p.admissionEventHash!==await digest(provider,'event',item.event) || p.grantHash!==await digest(provider,'current-state-grant',Object.fromEntries(Object.entries(grant).filter(([k])=>k!=='signatures'))) || JSON.stringify(canonical(state.events.find(e=>e.event?.parentHead===item.event?.parentHead && e.event?.proposalId===item.event?.proposalId)))!==JSON.stringify(canonical(packed)) || JSON.stringify(canonical(state.selections.at(-1)))!==JSON.stringify(canonical(selection)) || hex(p.manifest.bytes)!==hex(bytes(manifest)) || p.manifest.id!==grant.projectionManifestHash || p.documents.length!==1 || p.documents[0].documentId!==manifest.newDocumentId || p.documents[0].generation!==grant.newDocumentGeneration || hex(p.documents[0].bytes)!==hex(snapshot) || p.localKey.record.operationId!==keyOperationId || p.localKey.record.identity.deviceId!==localDeviceId || JSON.stringify(canonical(p.pendingEdits))!==JSON.stringify(canonical(pendingEdits))) throw Error('CONFLICT');
  const priorSource=await storage.reopenDocument(scope.id,manifest.sourceDocument);
  if(!priorSource.ok || !priorSource.value || priorSource.value.revision!==p.sourceDocument?.revision || await digest(provider,'projection-source-snapshot',hex(priorSource.value.bytes))!==manifest.sourceCheckpointHash) throw Error('CONFLICT');
  const parent=replayed.nodes.get(item.event.parentHead), prior=p.expectedAuthority.record;
  if(!parent || !prior || prior.acceptedParent!==parent.head || p.sourceDocument?.documentId!==manifest.sourceDocument || p.epochId!==grant.newEpochId || p.localKey.record.identity.epochId!==grant.newEpochId) throw Error('CORRUPT');
  const newer=await checkHouseholdCeremonies(sodium,parent,prior.authorizationSnapshot,grant,ceremonies,provider), older=await checkExistingRecipientCeremonies(sodium,parent,prior.authorizationSnapshot,grant,existingCeremonies,provider);
  const evidence=[...ceremonies,...existingCeremonies], verified=[...newer,...older], guards=verified.map(d=>d.guardId).sort();
  if(JSON.stringify(guards)!==JSON.stringify(p.guardIds) || p.packages.length!==verified.length) throw Error('CORRUPT');
  const {verifyStoredKeyPackage}=await import('../pairing/key-package.mjs');
  for(let i=0;i<evidence.length;i++) {
   const e=evidence[i], device=e.context.recipientDeviceId, recipient=verified.find(d=>d.deviceId===device);
   const packageId=i<ceremonies.length?grant.keyEnvelopeRefs[grant.recipientDevices.indexOf(device)]:await digest(provider,'existing-key-envelope',{admissionEventHash:p.admissionEventHash,deviceId:device});
   const pkg=p.packages.find(x=>x.id===packageId && x.recipientDevice===device);if(!recipient || !pkg || e.context.sponsorDeviceId!==localDeviceId) throw Error('CORRUPT');
   verifyStoredKeyPackage(sodium,pkg.bytes,{version:1,transcriptHash:recipient.transcriptHash,releaseId:packageId,scopeKind:'household',scopeId:scope.id,purpose:'data',epochId:grant.newEpochId,generation:grant.newDocumentGeneration,senderDevice:localDeviceId,senderSigningKey:hex(e.transcript.initiator.signingPublicKey),senderWrappingKey:hex(e.transcript.initiator.wrappingPublicKey),recipientDevice:device,recipientSigningKey:hex(e.transcript.responder.signingPublicKey),recipientWrappingKey:recipient.wrappingKeyRef,policyHash:item.event.policyHash,grantHash:p.grantHash,projectionId:manifest.newDocumentId,manifestHash:grant.projectionManifestHash});
  }
  return {replayed:true,publication:p};
 }
 const checked=await checkAdmissionProofs(storage,scope,pin,provider,sodium,item,grant,manifest,snapshot,ceremonies,existingCeremonies,localDeviceId);
 if(selection.from!==item.event.parentHead || selection.to!==checked.admissionEventHash) throw Error('INVALID_SELECTION');
 const {record,state}=await load(storage,scope,pin,provider);
 if(record.revision!==checked.expectedAuthority.record.revision || record.authorizationSnapshot!==checked.expectedAuthority.record.authorizationSnapshot) throw Error('CONFLICT');
 state.events.push(packed);state.selections.push(selection);state.activeHead=selection.to;await verifyAuthority(state,pin,provider);
 const signer=state.root && (await verifyAuthority(state,pin,provider)).nodes.get(selection.from).devices.find(d=>d.active && d.deviceId===localDeviceId);
 if(!signer || !(signingSecret instanceof Uint8Array) || signingSecret.length!==64) throw Error('INVALID_KEY');
 const challenge=domain('admission-local-signer',{householdId:scope.id,parentHead:selection.from,operationId});
 if(!await provider.verify(signer.signingKeyRef,challenge,sodium.crypto_sign_detached(challenge,signingSecret))) throw Error('INVALID_KEY');
 const all=[...ceremonies,...existingCeremonies];if(all.some(c=>c.context.sponsorDeviceId!==localDeviceId)) throw Error('UNAUTHORIZED_DEVICE');
 const {makeKeyPackage}=await import('../pairing/key-package.mjs');
 const identity={version:1,scope,deviceId:localDeviceId,purpose:'data',epochId:grant.newEpochId};
 const prepared=await storage.localKeys(master,sodium).prepareForAtomicInstall(keyOperationId,identity,async secret=>{
  const packages=[];
  for(let i=0;i<all.length;i++) {
   const e=all[i],newRecipient=i<ceremonies.length,device=e.context.recipientDeviceId;
   const recipient=newRecipient?checked.devices.find(d=>d.deviceId===device):checked.existingDevices.find(d=>d.deviceId===device);
   const packageId=newRecipient?grant.keyEnvelopeRefs[grant.recipientDevices.indexOf(device)]:await digest(provider,'existing-key-envelope',{admissionEventHash:checked.admissionEventHash,deviceId:device});
   if(!recipient || !packageId || !sodium.crypto_sign_verify_detached(sodium.crypto_sign_detached(challenge,signingSecret),challenge,e.transcript.initiator.signingPublicKey)) throw Error('INVALID_KEY');
   const context={version:1,transcriptHash:recipient.transcriptHash,releaseId:packageId,scopeKind:'household',scopeId:scope.id,purpose:'data',epochId:grant.newEpochId,generation:grant.newDocumentGeneration,senderDevice:localDeviceId,senderSigningKey:hex(e.transcript.initiator.signingPublicKey),senderWrappingKey:hex(e.transcript.initiator.wrappingPublicKey),recipientDevice:device,recipientSigningKey:hex(e.transcript.responder.signingPublicKey),recipientWrappingKey:recipient.wrappingKeyRef,policyHash:item.event.policyHash,grantHash:checked.grantHash,projectionId:manifest.newDocumentId,manifestHash:grant.projectionManifestHash};
   packages.push({id:packageId,recipientDevice:device,bytes:makeKeyPackage(sodium,context,secret,signingSecret)});
  }
  return packages;
 });
 const guards=[...checked.devices,...checked.existingDevices].map(d=>d.guardId).sort();
 const publication={version:1,operationId,guardIds:guards,sourceDocument:checked.sourceDocument,expectedAuthority:checked.expectedAuthority,nextAuthority:{scope,revision:record.revision+1,acceptedParent:state.activeHead,authorizationSnapshot:await snapshotId(provider,state),authorityState:bytes(state)},admissionEventHash:checked.admissionEventHash,grantHash:checked.grantHash,manifest:{id:grant.projectionManifestHash,bytes:bytes(manifest)},epochId:grant.newEpochId,documents:[{documentId:manifest.newDocumentId,generation:grant.newDocumentGeneration,bytes:new Uint8Array(snapshot)}],packages:prepared.packets,localKey:{record:prepared.record,catalog:prepared.catalog},pendingEdits};
 const committed=await storage.publishProjection(publication);if(!committed.ok) throw Error(committed.error);
 const durable=await storage.getProjectionPublication(scope.id,operationId);if(!durable.ok || !durable.value)throw Error(durable.error || 'CORRUPT');
 return {replayed:committed.value.replayed,publication:durable.value};
}
