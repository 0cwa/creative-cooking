// Experimental authority chain. The separately provisioned root pin and provider
// are trust inputs; this module does not perform human identity enrollment.
import {validateSuccessor, validParent, domain, isPolicyDocumentId, isRemoval, removedDevice} from './validator.mjs';
import {policyBranchAncestors,recoverPolicyBaseline,verifyRetainedPolicyBaseline} from './policy-baseline.mjs';
import {checkAdmissionAgreement, checkGrantSignatures, checkGrantManifest, checkGrantManifestMetadata, validPolicySeedManifest} from './grant.mjs';
import {checkHouseholdCeremonies,checkExistingRecipientCeremonies} from './ceremony.mjs';
import {verifyRevocation, revocationPackage, verifyRevocationSeed, projectRemovalSeed} from '../compromise/revocation.mjs';
import {verifyOwnDeviceEvent} from './own-device.mjs';
import sodium from 'libsodium-wrappers';
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true});
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>typeof s==='string' && /^[0-9a-f]{128}$/.test(s) ? Uint8Array.from(s.match(/../g),x=>parseInt(x,16)) : null;
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const bytes=v=>enc.encode(JSON.stringify(canonical(v)));
const digest=async(provider,purpose,v)=>{const b=await provider.hash(domain(purpose,canonical(v)));if (!(b instanceof Uint8Array)||b.length!==32) throw Error('INVALID_PROOF');return hex(b)};
const read=async(storage,scope)=>{const r=await storage.readPairingAuthority(scope);if(!r.ok)throw Error(r.error);return r.value};
const write=async(storage,expectedRevision,record)=>{const r=await storage.compareAndSwapPairingAuthority({expectedRevision,record});if(!r.ok)throw Error(r.error)};
const copy=v=>structuredClone(v);
export const encodeEvidence=v=>v instanceof Uint8Array?{__bytes:hex(v)}:Array.isArray(v)?v.map(encodeEvidence):v && typeof v==='object'?Object.fromEntries(Object.keys(v).map(k=>[k,encodeEvidence(v[k])])):v;
export const decodeEvidence=v=>Array.isArray(v)?v.map(decodeEvidence):v && typeof v==='object'?(Object.keys(v).length===1 && typeof v.__bytes==='string' && /^[0-9a-f]*$/.test(v.__bytes) && v.__bytes.length%2===0?Uint8Array.from(v.__bytes.match(/../g) ?? [],x=>parseInt(x,16)):Object.fromEntries(Object.keys(v).map(k=>[k,decodeEvidence(v[k])]))):v;
export {bytes as authorityBytes};
export const authorityRootId=(provider,root)=>rootPin(provider,root);
export const policyId=(provider,policy)=>digest(provider,'policy',policy);
export const snapshotId=(provider,state)=>digest(provider,'authority-state',state);

/** Replay every signed event from a locally pinned, explicitly preaccepted genesis. */
export async function verifyAuthority(state,pin,provider,{pendingOwnDeviceSet=null}={}) {
 state=copy(state);
 if (!state || Array.isArray(state) || !['activeHead,events,root,selections,version','activeHead,agreements,events,root,selections,version'].includes(Object.keys(state).sort().join(',')) || state.version!==1 || !Array.isArray(state.events) || state.events.length>128 || !Array.isArray(state.selections) || state.selections.length>128 || typeof state.activeHead!=='string') throw Error('MALFORMED');
 if (!validParent(state.root) || state.root.devices.some(d=>!state.root.roster.includes(d.adultId)) || isPolicyDocumentId(state.root.runtime.documentId) || await authorityRootId(provider,state.root)!==pin || state.root.head!==pin || state.root.policyHash!==await policyId(provider,state.root.policy)) throw Error('INVALID_ROOT');
 // A root head is the digest of the root payload excluding its self-reference.
 const nodes=new Map([[pin,state.root]]);
 const policyParents=new Map(), legacyPolicyHeads=new Set(), seedSchemas=new Map(), wrappingHistory=new Map();
 const wrappingFingerprints=new Map(), wrappingByHead=new Map([[pin,new Map()]]), pairingHeads=new Set(), pairingGuards=new Set();
 for(const item of state.events) {
  if (!item || Array.isArray(item) || !['approvals,authorSignature,event','admission,approvals,authorSignature,event','approvals,authorSignature,event,rotation','approvals,authorSignature,event,ownDevice'].includes(Object.keys(item).sort().join(','))) throw Error('MALFORMED');
  if(item.event?.version===6)throw Error('UNSUPPORTED_VERSION');
  const parent=nodes.get(item.event?.parentHead); if (!parent) throw Error('MISSING_PARENT');
  const r=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
  if(Object.hasOwn(item,'ownDevice')&&item.event.kind!=='pairOwnDevice')throw Error('INVALID_OWN_DEVICE');
  // Normal authority loads require durable support for this copied document set.
  if(item.event.kind==='pairOwnDevice'&&item.event.version===5&&pendingOwnDeviceSet===null)throw Error('UNSUPPORTED_VERSION');
  if(item.event.kind==='pairOwnDevice'&&[4,5].includes(item.event.version)&&r.reason==='CEREMONY_AND_POSSESSION_REQUIRED'){
   if(item.event.version===5&&r.eventHash!==pendingOwnDeviceSet)throw Error('UNSUPPORTED_VERSION');
   const s=item.event.subject,proof=decodeEvidence(item.ownDevice),known=wrappingByHead.get(parent.head);
   await sodium.ready;
   const {assertFreshRecoveryWrappingKey}=await import('../recovery/readmission.mjs');
   assertFreshRecoveryWrappingKey(sodium,wrappingHistory,parent.head,s.wrappingKeyRef,wrappingFingerprints);
   const oob=verifyOwnDeviceEvent(sodium,pin,parent,item.event,proof,known.get(item.event.authorDeviceId));
   assertFreshRecoveryWrappingKey(sodium,new Map([['sponsor',{keys:[oob.pins.initiator.wrappingKey]}]]),'sponsor',s.wrappingKeyRef,wrappingFingerprints);
   if(nodes.has(r.eventHash)||pairingGuards.has(proof.guard.guardId)||[...nodes.values()].some(n=>n.runtime.documentId===s.documentId))throw Error('INVALID_OWN_DEVICE');
   const child=copy(parent);
   child.head=r.eventHash;
   child.devices.push({adultId:s.adultId,deviceId:s.deviceId,signingKeyRef:s.signingKeyRef,active:true});
   child.runtime.documentId=s.documentId;
   child.runtime.authorPeers={...child.runtime.authorPeers,[s.deviceId]:s.peerId};
   child.runtime.acceptedRecipients=[...child.runtime.acceptedRecipients,s.deviceId].sort();
   if(!validParent(child))throw Error('INVALID_OWN_DEVICE');
   nodes.set(r.eventHash,child);
   policyParents.set(r.eventHash,{head:parent.head,baseline:s.baseline});
   seedSchemas.set(r.eventHash,seedSchemas.get(parent.head)??1);
   pairingHeads.add(r.eventHash);
   pairingGuards.add(proof.guard.guardId);
  } else if(item.event.kind==='changePolicy') {
   if(r.status!=='validated' || Object.hasOwn(item,'admission') || Object.hasOwn(item,'rotation')) throw Error(r.reason || 'UNSUPPORTED_TRANSITION');
   if(nodes.has(r.eventHash)) throw Error('DUPLICATE_EVENT');
   const child={...copy(parent),head:r.eventHash,policy:copy(item.event.nextPolicy),policyHash:await policyId(provider,item.event.nextPolicy)};
   if (item.event.version===3) {
    child.runtime.documentId=`policy-${r.eventHash}`;
    policyParents.set(r.eventHash,{head:parent.head,baseline:item.event.subject});
   } else legacyPolicyHeads.add(r.eventHash);
   nodes.set(r.eventHash,child);
  } else if((isRemoval(item.event.kind)||item.event.kind==='recoverDevice') && item.event.version===2 && ['ROTATION_DISTRIBUTION_REQUIRED','RECOVERY_DISTRIBUTION_REQUIRED'].includes(r.reason)) {
   const rotation=item.rotation,sub=item.event.subject;
   const product=rotation?.grant?.version===2, recovery=item.event.kind==='recoverDevice';
   if(product){
    if(Object.keys(rotation).sort().join(',')!==('authorizationSnapshot,grant,localDeviceId,manifest,operationId,recipientBindings'+(recovery?',recoveryProof':''))||
       rotation.localDeviceId!==item.event.authorDeviceId||rotation.operationId!==item.event.proposalId||
       rotation.authorizationSnapshot!==rotation.manifest?.authorizationSnapshot)throw Error('INVALID_ROTATION');
    await verifyRevocation({provider,parent,item:{event:item.event,authorSignature:item.authorSignature,approvals:item.approvals},...rotation});
    if(recovery){
     const {verifyRecoveryProof}=await import('../compromise/recovery-proof.mjs');await sodium.ready;
     const sender=sub.devices.find(d=>d.deviceId===rotation.localDeviceId),proof=rotation.recoveryProof;
     if(sender?.signingKeyRef!==proof?.senderSigningKey||sender?.wrappingKeyRef!==proof?.senderWrappingKey)throw Error('INVALID_RECOVERY_PROOF');
     await verifyRecoveryProof({sodium,parent,nodes,event:item.event,proof,provider});
     const {assertFreshRecoveryWrappingKey,recoveryBindingOnAncestry}=await import('../recovery/readmission.mjs');
     assertFreshRecoveryWrappingKey(sodium,wrappingHistory,parent.head,sub.wrappingKeyRef,wrappingFingerprints);
     const votes=rows=>rows.map(({adultId,deviceId})=>[adultId,deviceId]);
     if(hex(bytes(votes(item.approvals)))!==hex(bytes(votes(proof.confirmations)))||
        !await recoveryBindingOnAncestry(provider,state.events.slice(0,state.events.indexOf(item)),parent.head,proof.binding.checkpoint))throw Error('INVALID_RECOVERY_PROOF');
    }
    seedSchemas.set(r.eventHash,4);
   } else {
   if(item.event.kind==='removeAdult'||!rotation||![ 'authorizationSnapshot,ceremonies,grant,localDeviceId,manifest,operationId','authorizationSnapshot,ceremonies,grant,localDeviceId,manifest,operationId,recoveryProof'].includes(Object.keys(rotation).sort().join(','))||(item.event.kind==='recoverDevice')!==Object.hasOwn(rotation,'recoveryProof')||rotation.grant?.eventHash!==r.eventHash||!parent.runtime.acceptedRecipients.includes(rotation.localDeviceId)||rotation.localDeviceId===sub.deviceId||await digest(provider,'rotation-manifest',rotation.manifest)!==rotation.grant.manifestHash||rotation.manifest?.newDocumentId!==sub.documentId||rotation.manifest?.newGeneration!==sub.newGeneration||rotation.manifest?.newEpochId!==sub.newEpochId)throw Error('INVALID_ROTATION');
   const {checkRotationEvidence}=await import('../compromise/rotation-proof.mjs');await sodium.ready;
   await checkRotationEvidence({sodium,parent,authorizationSnapshot:rotation.authorizationSnapshot,item:{event:item.event,authorSignature:item.authorSignature,approvals:item.approvals},grant:rotation.grant,ceremonies:decodeEvidence(rotation.ceremonies),localDeviceId:rotation.localDeviceId,provider});
   if(item.event.kind==='recoverDevice'){const {verifyRecoveryProof}=await import('../compromise/recovery-proof.mjs');await verifyRecoveryProof({sodium,parent,nodes,event:item.event,proof:rotation.recoveryProof,provider})}
   }
   if(nodes.has(r.eventHash)||isPolicyDocumentId(sub.documentId)||[...nodes.values()].some(n=>n.epochId===sub.newEpochId||n.runtime.documentId===sub.documentId))throw Error('INVALID_ROTATION');
   const child=copy(parent);
   child.head=r.eventHash;
   child.epochId=sub.newEpochId;
   child.generation=sub.newGeneration;
   if(isRemoval(item.event.kind)){
    if(item.event.kind==='removeAdult')child.roster=child.roster.filter(id=>id!==sub.adultId);
    child.devices=child.devices.map(d=>removedDevice(item.event,d)?{...d,active:false}:d);
   }else child.devices.push({adultId:sub.owner,deviceId:sub.deviceId,signingKeyRef:sub.signingKeyRef,active:true});
   child.runtime.documentId=sub.documentId;
   child.runtime.authorPeers=Object.fromEntries(sub.devices.map(d=>[d.deviceId,d.peerId]));
   child.runtime.acceptedRecipients=sub.devices.map(d=>d.deviceId);
   if(!validParent(child))throw Error('INVALID_ROTATION');
   nodes.set(r.eventHash,child);
  } else if(item.event.kind==='inviteAdult' && item.event.version===2 && r.reason==='ADMISSION_AND_PROJECTION_REQUIRED') {
   const a=item.admission,subject=item.event.subject;
   if(!a || Array.isArray(a) || Object.keys(a).sort().join(',')!=='ceremonies,existingCeremonies,grant,localDeviceId,manifest,operationId' || a.grant?.admissionEventHash!==r.eventHash || a.grant?.recipientAdult!==subject.adultId || a.grant?.newDocumentGeneration!==subject.newGeneration || a.grant?.newEpochId!==subject.newEpochId || a.manifest?.newDocumentId!==subject.documentId || a.manifest?.newGeneration!==subject.newGeneration || JSON.stringify(a.grant?.recipientDevices)!==JSON.stringify(subject.devices.map(d=>d.deviceId)) || !parent.runtime.acceptedRecipients.includes(a.localDeviceId)) throw Error('INVALID_ADMISSION');
   const grantProof=await checkGrantSignatures(parent,a.grant,provider);
   const documentSet=a.manifest?.version===5;
   if(documentSet){
    const {checkCurrentDocumentSetManifest}=await import('../projection/current-document-set.mjs');
    await checkCurrentDocumentSetManifest({pin,parent,item,eventHash:r.eventHash,manifest:a.manifest,provider});
   }
   if(grantProof.reason!=='ADMISSION_EVIDENCE_REQUIRED' || (!documentSet&&a.manifest?.version!==1&&!validPolicySeedManifest(a.manifest)) || await digest(provider,'projection-manifest',a.manifest)!==a.grant.projectionManifestHash || (documentSet
     ? JSON.stringify(a.grant.contentClasses)!==JSON.stringify(['pantry','recipe','shopping'])
     : JSON.stringify(a.manifest.sourcePolicyHashes)!==JSON.stringify(a.grant.sourcePolicyHashes))) throw Error('INVALID_ADMISSION');
   let accepted=false;
   for(const agreement of state.agreements ?? []) {if(agreement.parentHead!==parent.head)continue;const v=await checkAdmissionAgreement(parent,agreement,provider);if(v.status==='accepted' && v.delegationHash===a.grant.delegationHash && JSON.stringify(agreement.sourcePolicyHashes)===JSON.stringify(a.grant.sourcePolicyHashes))accepted=true;}
   if(!accepted) throw Error('INVALID_AGREEMENT');
   await sodium.ready; const ceremonies=decodeEvidence(a.ceremonies),existing=decodeEvidence(a.existingCeremonies),snapshot=ceremonies[0]?.transcript?.authorizationSnapshot;
   if(documentSet&&snapshot!==a.manifest.authorizationSnapshot)throw Error('INVALID_ADMISSION');
   const verified=await checkHouseholdCeremonies(sodium,parent,snapshot,a.grant,ceremonies,provider), oldDevices=await checkExistingRecipientCeremonies(sodium,parent,snapshot,a.grant,existing,provider);
   if([...ceremonies,...existing].some(e=>e.context.sponsorDeviceId!==a.localDeviceId)) throw Error('INVALID_ADMISSION');
   if(subject.devices.some((d,i)=>d.deviceId!==verified[i]?.deviceId || d.signingKeyRef!==verified[i]?.signingKeyRef || d.wrappingKeyRef!==verified[i]?.wrappingKeyRef) || JSON.stringify(oldDevices.map(d=>d.deviceId).sort())!==JSON.stringify(parent.runtime.acceptedRecipients.filter(d=>d!==a.localDeviceId)) || new Set([...verified,...oldDevices].map(d=>d.guardId)).size!==verified.length+oldDevices.length) throw Error('INVALID_ADMISSION');
   if(nodes.has(r.eventHash)) throw Error('DUPLICATE_EVENT');
   if(isPolicyDocumentId(subject.documentId)||[...nodes.values()].some(n=>n.epochId===subject.newEpochId || n.runtime.documentId===subject.documentId)) throw Error('INVALID_ADMISSION');
   const child=copy(parent);child.head=r.eventHash;child.generation=subject.newGeneration;child.epochId=subject.newEpochId;child.roster=[...parent.roster,subject.adultId].sort();
   child.devices.push(...subject.devices.map(d=>({adultId:subject.adultId,deviceId:d.deviceId,signingKeyRef:d.signingKeyRef,active:true})));
   child.runtime.documentId=subject.documentId;for(const d of subject.devices) child.runtime.authorPeers[d.deviceId]=d.peerId;
   child.runtime.acceptedRecipients=[...parent.runtime.acceptedRecipients,...subject.devices.map(d=>d.deviceId)].sort();
   if(!validParent(child)) throw Error('INVALID_ADMISSION');nodes.set(r.eventHash,child);
   if(documentSet||a.manifest.version===4)seedSchemas.set(r.eventHash,4);
  } else throw Error(r.reason || 'UNSUPPORTED_TRANSITION');
  const wrappingKeys=new Set((item.event.subject?.devices??[]).map(d=>d.wrappingKeyRef));
  const known=new Map(wrappingByHead.get(parent.head));
  for(const d of item.event.subject?.devices??[])known.set(d.deviceId,d.wrappingKeyRef);
  // Legacy recovery could authenticate a package sender key separately from the roster.
  if(item.event.kind==='recoverDevice')wrappingKeys.add(item.rotation.recoveryProof.senderWrappingKey);
  for(const ceremony of [...(item.admission?.ceremonies??[]),...(item.admission?.existingCeremonies??[]),...(item.rotation?.ceremonies??[])]){
   for(const role of ['initiator','responder']){
    const participant=ceremony.transcript[role], key=decodeEvidence(participant.wrappingPublicKey);
    if(key instanceof Uint8Array){
     const wrap=hex(key);
     wrappingKeys.add(wrap);
     if(!known.has(participant.deviceId))known.set(participant.deviceId,wrap);
    }
   }
  }
  const proof=item.ownDevice&&decodeEvidence(item.ownDevice);
  if(proof)for(const p of [proof.transcript.initiator,proof.transcript.responder]){
   const wrap=hex(p.wrappingPublicKey);
   wrappingKeys.add(wrap);
   known.set(p.deviceId,wrap);
  }
  wrappingByHead.set(r.eventHash,known);
  wrappingHistory.set(r.eventHash,{parent:parent.head,keys:wrappingKeys});
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
 return {nodes,state,policyParents,legacyPolicyHeads,seedSchemas,wrappingHistory,wrappingByHead,pairingHeads};
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
 let recipient=null;if(storage.householdRecipient){for(const item of [...state.events].reverse()){if(!item.admission&&!item.ownDevice&&item.rotation?.grant?.version!==2)continue;const hash=await digest(provider,'event',item.event),found=await storage.householdRecipient.findByEvent(scope.id,hash);if(!found.ok)throw Error('INVALID_AUTHORITY');if(found.value){const {verifyRecipientInstallation}=await import('./recipient-load.mjs');await sodium.ready;recipient=await verifyRecipientInstallation({storage,scope,pin,provider,sodium,state,eventHash:hash});break;}}}
 const setEvent=[...state.events].reverse().find(item=>item.admission?.manifest.version===5);
 let setParent=null;
 if(setEvent){
  const {readInstalledHouseholdDocumentSet}=await import('../pairing/household-document-set.mjs');
  const checked=await readInstalledHouseholdDocumentSet({sodium,storage,scope,pin,provider,operationId:setEvent.admission.operationId});
  const retained=checked.state.events.at(-1);
  if(JSON.stringify(canonical(retained))!==JSON.stringify(canonical(setEvent)))throw Error('INVALID_AUTHORITY');
  if(checked.mode==='recipient')setParent=checked.parentState;
 }
 const publicPrefix=item=>(recipient?.parent.events.some(old=>JSON.stringify(canonical(old))===JSON.stringify(canonical(item)))||
   setParent?.events.some(old=>JSON.stringify(canonical(old))===JSON.stringify(canonical(item))));
 for(const item of state.events) if(item.ownDevice){
  const eventHash=await digest(provider,'event',item.event);
  if(publicPrefix(item)||recipient?.installation.nextAuthority.acceptedParent===eventHash)continue;
  const saved=await storage.readHouseholdOwnDeviceRelease(scope,item.event.proposalId,false);
  if(!saved.ok||!saved.value||saved.value.next.acceptedParent!==eventHash||
     saved.value.documentId!==item.event.subject.documentId||saved.value.guardId!==item.ownDevice.guard.guardId||
     saved.value.link.head!==item.event.parentHead||saved.value.link.documentId!==verified.nodes.get(item.event.parentHead).runtime.documentId||
     await digest(provider,'household-own-device-sources',saved.value.sources)!==item.event.subject.sourcesHash)throw Error('INVALID_AUTHORITY');
  const published=JSON.parse(dec.decode(saved.value.next.authorityState));
  if(!published.events.some(event=>hex(bytes(event))===hex(bytes(item))))throw Error('INVALID_AUTHORITY');
  try {
   const LoroDoc=await (await import('../app/loro-document.mjs')).loadLoroDoc();
   await verifyRetainedPolicyBaseline(LoroDoc,saved.value.document,item.event.subject.baseline,provider);
  } catch {throw Error('INVALID_AUTHORITY');}
 }
 for(const item of state.events) if(item.admission) {
  if(item===setEvent||publicPrefix(item)||recipient&&item.event.parentHead===recipient.parent.activeHead&&
     await digest(provider,'event',item.event)===recipient.installation.nextAuthority.acceptedParent)continue;
  if(item.admission.manifest.version===5){
   const {readInstalledHouseholdDocumentSet}=await import('../pairing/household-document-set.mjs');
   const checked=await readInstalledHouseholdDocumentSet({sodium,storage,scope,pin,provider,operationId:item.admission.operationId});
   if(JSON.stringify(canonical(checked.state.events.at(-1)))!==JSON.stringify(canonical(item)))throw Error('INVALID_AUTHORITY');
   continue;
  }
  const saved=await storage.getProjectionPublication(scope.id,item.admission.operationId);
  if(!saved.ok || !saved.value) throw Error('INVALID_AUTHORITY');
  const p=saved.value, eventHash=await digest(provider,'event',item.event);
  let published;try{published=JSON.parse(dec.decode(p.nextAuthority.authorityState))}catch{throw Error('INVALID_AUTHORITY')}
  if(p.admissionEventHash!==eventHash || p.nextAuthority.acceptedParent!==eventHash || p.expectedAuthority.record?.acceptedParent!==item.event.parentHead || p.grantHash!==await digest(provider,'current-state-grant',Object.fromEntries(Object.entries(item.admission.grant).filter(([k])=>k!=='signatures'))) || p.manifest.id!==item.admission.grant.projectionManifestHash || hex(p.manifest.bytes)!==hex(bytes(item.admission.manifest)) || !published.events?.some(e=>JSON.stringify(canonical(e))===JSON.stringify(canonical(item)))) throw Error('INVALID_AUTHORITY');
  if([2,3,4].includes(item.admission.manifest.version)){const manifest=item.admission.manifest,parent=verified.nodes.get(item.event.parentHead),grant=item.admission.grant;if(!validPolicySeedManifest(manifest)||!p.policySeed||p.policySeed.bundle?.version!==manifest.version||p.policySeed.bundleHash!==manifest.policyBundleHash||p.sourceDocument?.documentId!==manifest.sourceDocument||p.sourceDocument?.revision!==manifest.sourceRevision||p.documents.length!==1||!p.seed||!parent)throw Error('INVALID_AUTHORITY');const association=await checkGrantManifest(parent,grant,manifest,p.documents[0].bytes,provider);if(association.reason!=='SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED')throw Error('INVALID_AUTHORITY');const LoroDoc=await (await import('../app/loro-document.mjs')).loadLoroDoc(),doc=new LoroDoc();doc.import(p.documents[0].bytes);const seed={version:1,seedId:p.seed.seedId,peerId:p.policySeed.bundle.peerId,snapshot:p.documents[0].bytes,identities:p.seed.identities,purchaseIds:Object.keys(doc.getMap('purchases').toJSON()).sort()}, {verifyPolicyProjection}=await import('../disclosure/policy-seed.mjs');await verifyPolicyProjection({provider,pin,state,seed,bundle:p.policySeed.bundle,expectedBundleHash:manifest.policyBundleHash,expectedSourceHead:item.event.parentHead,expectedSourceDocument:manifest.sourceDocument,expectedSourceRevision:manifest.sourceRevision,LoroDoc});}
  if(item.admission.manifest.schemaVersion.startsWith('registry-seed-v1|')){if(JSON.stringify(item.admission.grant.contentClasses)!==JSON.stringify(['pantry','recipe','shopping']))throw Error('INVALID_AUTHORITY');if(!p.seed||p.seed.seedId!==item.admission.manifest.schemaVersion.split('|')[1]||await digest(provider,'projection-snapshot',hex(p.documents[0]?.bytes))!==item.admission.manifest.projectedStateHash)throw Error('INVALID_AUTHORITY');const {verifyCurrentSeed}=await import('../compromise/current-seed.mjs'),LoroDoc=await (await import('../app/loro-document.mjs')).loadLoroDoc(),seedCheck=verifyCurrentSeed({LoroDoc,snapshot:p.documents[0].bytes,seed:p.seed}),parent=verified.nodes.get(item.event.parentHead);if(seedCheck.peers.some(x=>[...Object.values(parent.runtime.authorPeers),...item.event.subject.devices.map(d=>d.peerId)].includes(x)))throw Error('INVALID_AUTHORITY')}
 }
 for(const item of state.events) if(item.rotation) {
  if(publicPrefix(item)||recipient&&await digest(provider,'event',item.event)===recipient.installation.nextAuthority.acceptedParent)continue;
  const r=item.rotation,saved=await storage.getProjectionPublication(scope.id,r.operationId);if(!saved.ok||!saved.value)throw Error('INVALID_AUTHORITY');
  const p=saved.value,eventHash=await digest(provider,'event',item.event);let published;try{published=JSON.parse(dec.decode(p.nextAuthority.authorityState))}catch{throw Error('INVALID_AUTHORITY')}if(!published.events?.some(e=>JSON.stringify(canonical(e))===JSON.stringify(canonical(item))))throw Error('INVALID_AUTHORITY');if(p.admissionEventHash!==eventHash||p.expectedAuthority.record?.acceptedParent!==item.event.parentHead||p.expectedAuthority.record?.authorizationSnapshot!==r.authorizationSnapshot||p.nextAuthority.acceptedParent!==eventHash||p.manifest.id!==r.grant.manifestHash||hex(p.manifest.bytes)!==hex(bytes(r.manifest))||p.epochId!==item.event.subject.newEpochId||!p.seed||p.seed.seedId!==r.manifest.seedId||await digest(provider,'projection-seed-identities',p.seed.identities)!==r.manifest.seedIdentitiesHash||await digest(provider,'rotation-draft-snapshot',hex(p.documents[0]?.bytes))!==r.manifest.draftHash)throw Error('INVALID_AUTHORITY');
  if(r.grant.version===2){
   if(item.event.kind==='recoverDevice'&&!sameRecoveryGuard(p.recovery,item))throw Error('INVALID_AUTHORITY');
   const parent=verified.nodes.get(item.event.parentHead),LoroDoc=await (await import('../app/loro-document.mjs')).loadLoroDoc();
   if(p.documents.length!==1||p.documents[0].documentId!==r.manifest.newDocumentId||p.documents[0].generation!==r.manifest.newGeneration||
      p.sourceDocument?.documentId!==r.manifest.sourceDocumentId||p.sourceDocument?.revision!==r.manifest.sourceRevision||
      p.localKey.record.identity.deviceId!==r.localDeviceId||p.packages.length!==r.grant.packageRefs.length||
      p.grantHash!==await digest(provider,'rotation-distribution-grant',Object.fromEntries(Object.entries(r.grant).filter(([k])=>k!=='signatures'))))throw Error('INVALID_AUTHORITY');
   await verifyRevocationSeed({provider,LoroDoc,parent,item,manifest:r.manifest,snapshot:p.documents[0].bytes,seed:p.seed});
   await sodium.ready;
   const {verifyStoredKeyPackage}=await import('../pairing/key-package.mjs');
   for(const d of item.event.subject.devices.filter(d=>d.deviceId!==r.localDeviceId)){
    const {context,guardId}=await revocationPackage({provider,parent,item,recipientDevice:d.deviceId});
    const pkg=p.packages.find(x=>x.recipientDevice===d.deviceId&&x.id===context.releaseId);
    if(!pkg||!p.guardIds?.includes(guardId))throw Error('INVALID_AUTHORITY');
    verifyStoredKeyPackage(sodium,pkg.bytes,context);
   }
   continue;
  }
  const {verifyCurrentSeed}=await import('../compromise/current-seed.mjs'),LoroDoc=await (await import('../app/loro-document.mjs')).loadLoroDoc(),seedCheck=verifyCurrentSeed({LoroDoc,snapshot:p.documents[0].bytes,seed:p.seed}),priorNode=verified.nodes.get(item.event.parentHead);if(seedCheck.peers.some(x=>[...Object.values(priorNode.runtime.authorPeers),...item.event.subject.devices.map(d=>d.peerId)].includes(x)))throw Error('INVALID_AUTHORITY');
  const {verifyStoredKeyPackage}=await import('../pairing/key-package.mjs');const proofs=decodeEvidence(r.ceremonies),others=item.event.subject.devices.filter(d=>d.deviceId!==r.localDeviceId);if(p.packages.length!==others.length||proofs.length!==others.length-(item.event.kind==='recoverDevice'?1:0))throw Error('INVALID_AUTHORITY');
  const grantBase=Object.fromEntries(Object.entries(r.grant).filter(([k])=>k!=='signatures')),grantHash=await digest(provider,'rotation-distribution-grant',grantBase);if(p.grantHash!==grantHash)throw Error('INVALID_AUTHORITY');
  for(let i=0;i<others.length;i++){
   const device=others[i],pkg=p.packages.find(x=>x.recipientDevice===device.deviceId&&x.id===r.grant.packageRefs[i]);if(!pkg)throw Error('INVALID_AUTHORITY');
   let senderSigningKey,senderWrappingKey,recipientSigningKey,transcriptHash;
   if(item.event.kind==='recoverDevice'&&device.deviceId===item.event.subject.deviceId){const proof=r.recoveryProof;senderSigningKey=proof.senderSigningKey;senderWrappingKey=proof.senderWrappingKey;recipientSigningKey=proof.claim.signingKey;transcriptHash=item.event.subject.claimHash;if(!p.recovery||p.recovery.claimHash!==item.event.subject.claimHash||p.recovery.bindingHash!==item.event.subject.bindingHash||p.recovery.generation!==item.event.subject.bindingGeneration||p.recovery.owner!==item.event.subject.owner||p.recovery.tokenCommitment!==proof.challenge.tokenCommitment||p.recovery.sealed!==proof.challenge.sealed)throw Error('INVALID_AUTHORITY')}
   else {const e=proofs.find(x=>x.context?.recipientDeviceId===device.deviceId);if(!e)throw Error('INVALID_AUTHORITY');senderSigningKey=hex(e.transcript.initiator.signingPublicKey);senderWrappingKey=hex(e.transcript.initiator.wrappingPublicKey);recipientSigningKey=hex(e.transcript.responder.signingPublicKey);transcriptHash=e.oob.hash}
   verifyStoredKeyPackage(sodium,pkg.bytes,{version:1,transcriptHash,releaseId:pkg.id,scopeKind:'household',scopeId:scope.id,purpose:'data',epochId:item.event.subject.newEpochId,generation:item.event.subject.newGeneration,senderDevice:r.localDeviceId,senderSigningKey,senderWrappingKey,recipientDevice:device.deviceId,recipientSigningKey,recipientWrappingKey:device.wrappingKeyRef,policyHash:item.event.policyHash,grantHash,projectionId:item.event.subject.documentId,manifestHash:r.grant.manifestHash});
  }
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
 return (await observePolicySuccessor(storage,scope,pin,provider,item,false)).eventHash;
}

/** Retry an exact retained successor without writing another authority revision. */
export function observeSuccessorWithOutcome(storage,scope,pin,provider,item,expectedParent) {
 return observePolicySuccessor(storage,scope,pin,provider,item,true,expectedParent);
}

async function observePolicySuccessor(storage,scope,pin,provider,item,retry,expectedParent) {
 scope=copy(scope);
 item=copy(item); if(item.event?.version===6)throw Error('UNSUPPORTED_VERSION');
 const {record,state,nodes}=await load(storage,scope,pin,provider);
 const parent=nodes.get(item.event?.parentHead); if(!parent)throw Error('MISSING_PARENT');
 const r=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
 if(r.status!=='validated')throw Error(r.reason);
 if(item.event.kind!=='changePolicy')throw Error('UNSUPPORTED_TRANSITION');
 const alreadyRetained=current=>retry&&current.events.some(value=>hex(bytes(value))===hex(bytes(item)));
 if(alreadyRetained(state))return {eventHash:r.eventHash,replayed:true};
 if(expectedParent!==undefined&&(parent.head!==expectedParent||state.activeHead!==expectedParent))throw Error('CONFLICT');
 if(nodes.has(r.eventHash))throw Error('DUPLICATE_EVENT');
 state.events.push(item); await verifyAuthority(state,pin,provider);
 try{await save(storage,record,state,provider)}catch(error){
  if(!retry||error?.message!=='CONFLICT'||!alreadyRetained((await load(storage,scope,pin,provider)).state))throw error;
  return {eventHash:r.eventHash,replayed:true};
 }
 return {eventHash:r.eventHash,replayed:false};
}

/** Traverse only signed policy edges. Each component has one retained starting workspace. */
export function policyCheckoutCandidates({nodes,state,policyParents,legacyPolicyHeads,pairingHeads=new Set()}) {
 const base=head=>{while(policyParents.has(head)&&!pairingHeads.has(head))head=policyParents.get(head).head;return head;};
 const activeBase=base(state.activeHead);
 return [...nodes.values()].filter(node=>node.head!==state.activeHead && base(node.head)===activeBase && !legacyPolicyHeads.has(activeBase));
}

export async function checkoutPolicyHead({storage,scope,pin,provider,LoroDoc,adultId,deviceId,expectedHead,expectedRevision,targetHead,explicit}) {
 if (explicit!==true) throw Error('CONFIRMATION_REQUIRED');
 scope=copy(scope);
 const verified=await load(storage,scope,pin,provider),{record,state,nodes,policyParents}=verified;
 if (state.activeHead!==expectedHead || record.revision!==expectedRevision) throw Error('CONFLICT');
 const from=nodes.get(expectedHead),device=from.devices.find(d=>d.active && d.adultId===adultId && d.deviceId===deviceId);
 if (!device || !policyCheckoutCandidates(verified).some(node=>node.head===targetHead)) throw Error('INVALID_POLICY_CHECKOUT');
 const location=node=>({head:node.head,documentId:node.runtime.documentId});
 const edge=policyParents.get(targetHead), target=location(nodes.get(targetHead));
 const parent=edge && !verified.pairingHeads.has(targetHead) ? location(nodes.get(edge.head)) : null;
 const expectedAuthority={version:2,scope,record:{revision:record.revision,acceptedParent:expectedHead,authorizationSnapshot:record.authorizationSnapshot}};
 const opened=await storage.readPolicyCheckoutDocuments(expectedAuthority,location(from),target,parent);
 if (!opened.ok) throw Error(opened.error.code);
 const {fromRevision,targetRevision,parentDocument}=opened.value;
 const baseline=edge && targetRevision===null ? await recoverPolicyBaseline(LoroDoc,parentDocument,edge.baseline,provider) : null;

 const selection={from:expectedHead,to:targetHead,deviceId,index:state.selections.length};
 const signature=hex(await provider.sign(device.signingKeyRef,domain('select-head',{root:pin,householdId:scope.id,...selection})));
 state.selections.push({...selection,signature}); state.activeHead=targetHead;
 await verifyAuthority(state,pin,provider);
 const nextAuthority={scope,revision:record.revision+1,acceptedParent:targetHead,authorizationSnapshot:await snapshotId(provider,state),authorityState:bytes(state)};
 const result=await storage.commitPolicyCheckout({expectedAuthority,nextAuthority,from:{...location(from),revision:fromRevision},
  target:{...target,revision:targetRevision}, parent:parent && {...parent,revision:parentDocument?.revision??null}, baseline});
 if (!result.ok) throw Error(result.error.code);
 return {head:targetHead};
}
/** Compare an already verified authority with the signed installed state. */
export function matchesInstalledSetAuthority(record,state,installedRecord) {
 const published=JSON.parse(dec.decode(installedRecord.authorityState));
 const prior=published.agreements??[],current=state.agreements??[];
 const additions=current.slice(prior.length);
 return record.revision===installedRecord.revision+additions.length &&
  same(record.scope,installedRecord.scope) && record.acceptedParent===installedRecord.acceptedParent &&
  same(current.slice(0,prior.length),prior) && current.length>=prior.length &&
  additions.every(agreement=>agreement.parentHead===state.activeHead) &&
  same({...state,agreements:prior},{...published,agreements:prior});
}

/** Resolve only from a pinned and replayed selected head, never from runtime options. */
async function resolveRuntimeAuthorityInternal(storage,scope,pin,provider,authorDevice,installed) {
 const {record,state,nodes}=await load(storage,scope,pin,provider), selected=nodes.get(state.activeHead);
 const selectedSet=state.events.find(item=>item.admission?.manifest.version===5&&item.admission.grant.admissionEventHash===state.activeHead);
 // A verified delegation may be appended after installation. Keep every
 // published event and selection byte-for-byte bound to the original receipt;
 // only agreements for this selected head can extend that state.
 if(selectedSet && (!installed || !matchesInstalledSetAuthority(record,state,installed.publication.nextAuthority) ||
   !same(selectedSet,installed.item) || installed.selection.to!==state.activeHead)) throw Error('UNSUPPORTED_VERSION');
 if(installed && !selectedSet) throw Error('INVALID_AUTHORITY');
 return runtimeAuthority(scope,record,state,selected,authorDevice);
}

function runtimeAuthority(scope,record,state,selected,authorDevice) {
 const acceptedAuthors=selected.devices.filter(d=>d.active).map(d=>d.deviceId).sort();
 if(!acceptedAuthors.includes(authorDevice))throw Error('UNAUTHORIZED_DEVICE');
 const runtimeScope={scopeId:scope.id,documentId:selected.runtime.documentId,documentGeneration:selected.generation,branchHead:state.activeHead,authorizationSnapshot:record.authorizationSnapshot,policyHashes:[selected.policyHash],epochId:selected.epochId,authorDevice,acceptedAuthors,authorPeers:copy(selected.runtime.authorPeers),acceptedRecipients:copy(selected.runtime.acceptedRecipients),suiteId:'candidate-ed25519-xchacha20-sealedbox-v1'};
 const signingKeyRefs=Object.freeze(Object.fromEntries(selected.devices.filter(d=>d.active).map(d=>[d.deviceId,d.signingKeyRef]).sort(([a],[b])=>a.localeCompare(b))));
 return {scope:runtimeScope,signingKeyRefs,adultId:selected.devices.find(d=>d.deviceId===authorDevice).adultId,selectionIndex:state.selections.length,expectedAuthority:{version:2,scope:copy(scope),record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}}};
}

/** Default callers cannot use a multi-document admission. */
export async function resolveRuntimeAuthority(storage,scope,pin,provider,authorDevice) {
 return resolveRuntimeAuthorityInternal(storage,scope,pin,provider,authorDevice,null);
}

/** Resolve only after verifying the locally installed, selected document set. */
export async function resolveInstalledSetAuthority({storage,scope,pin,provider,authorDevice,sodium,operationId,LoroDoc,
 paired=/** @type {{keys:any;useWrapping?:(use:(secret:Uint8Array)=>Promise<any>)=>Promise<any>}|undefined} */(undefined)}) {
 scope=copy(scope);
 if(paired){
  const {reopenOwnDeviceSet}=await import('../pairing/household-own-device-set.mjs');
  const options={storage,scope,pin,provider,sodium,operationId,LoroDoc,keys:paired.keys};
  let opening;
  const reopen=wrappingSecret=>{
   if(opening)throw Error('INVALID_AUTHORITY_CONFIG');
   opening=reopenOwnDeviceSet({...options,wrappingSecret});
   return opening;
  };
  if(paired.useWrapping)await paired.useWrapping(reopen);
  else await reopen(undefined);
  if(!opening)throw Error('INVALID_AUTHORITY_CONFIG');
  const opened=await opening;
  if(opened.documents.some(document=>document.identity.deviceId!==authorDevice))throw Error('UNAUTHORIZED_DEVICE');
  const {record}=opened;
  const state=JSON.parse(dec.decode(record.authorityState));
  const verified=await verifyAuthority(state,pin,provider,{pendingOwnDeviceSet:opened.head});
  if(state.activeHead!==opened.head||!same(record,await read(storage,scope)))throw Error('STALE_AUTHORITY');
  const selected=verified.nodes.get(opened.head);
  return {...runtimeAuthority(scope,record,state,selected,authorDevice),
   members:opened.documents.map(({recipeId,documentId})=>({recipeId,documentId})),
   pairedDocuments:opened.documents,wrappingKeyRefs:{},pairedAuthority:{record,state,verified}};
 }
 const {readInstalledHouseholdDocumentSet}=await import('../pairing/household-document-set.mjs');
 const installed=await readInstalledHouseholdDocumentSet({storage,scope,pin,provider,sodium,operationId,LoroDoc});
 if(installed.publication.localKey.record.identity.deviceId!==authorDevice) throw Error('UNAUTHORIZED_DEVICE');
 const resolved=await resolveRuntimeAuthorityInternal(storage,scope,pin,provider,authorDevice,installed);
 const {ceremonies,existingCeremonies,manifest}=installed.item.admission, wrapping=new Map();
 for(const {transcript} of decodeEvidence([...ceremonies,...existingCeremonies])){
  for(const participant of [transcript.initiator,transcript.responder]){
   const {deviceId,signingPublicKey,wrappingPublicKey}=participant;
   const ref=hex(wrappingPublicKey);
   if(!resolved.scope.acceptedRecipients.includes(deviceId)||resolved.signingKeyRefs[deviceId]!==hex(signingPublicKey))continue;
   wrapping.set(deviceId,wrapping.has(deviceId)&&wrapping.get(deviceId)!==ref?null:ref);
  }
 }
 return {...resolved,wrappingKeyRefs:Object.fromEntries(wrapping),
  deliveryAuthorizationSnapshot:installed.publisherAuthorizationSnapshot,
  pairedDocuments:undefined,
  members:manifest.entries.map(({recipeId,documentId})=>({recipeId:recipeId??null,documentId}))};
}

/** Resolve a selected v6 checkout only from its authenticated retained activation. */
export async function resolveActivatedPolicyAuthority({storage,scope,pin,provider,authorDevice,LoroDoc,targetHead,keys}) {
 scope=copy(scope);
 const {readVerifiedActivatedPolicyDocumentSet}=await import('../app/read-activated-policy-document-set.mjs');
 const opened=await readVerifiedActivatedPolicyDocumentSet({storage,scope,pin,provider,deviceId:authorDevice,LoroDoc,targetHead,keys});
 const {record,state,parent,item,selection,documents}=opened;
 if(state.activeHead!==targetHead || selection.index!==state.selections.length-1 || selection.to!==targetHead ||
    item.event.version!==6 || item.event.kind!=='changePolicy' || item.event.parentHead!==parent.head ||
    !same(record,await read(storage,scope))) throw Error('STALE_AUTHORITY');
 const selected={...copy(parent),head:targetHead,policy:copy(item.event.nextPolicy),policyHash:await policyId(provider,item.event.nextPolicy)};
 selected.runtime.documentId=`policy-${targetHead}`;
 const resolved=runtimeAuthority(scope,record,state,selected,authorDevice);
 if(!same(record,await read(storage,scope)))throw Error('STALE_AUTHORITY');
 return {...resolved,members:documents.map(({recipeId,documentId,operationId,identity})=>({recipeId,documentId,operationId,identity}))};
}

/** Persist explicit acceptance at the currently selected frozen parent. */
export async function acceptAdmissionAgreement(storage,scope,pin,provider,agreement) {
 return (await acceptAdmissionAgreementWithOutcome(storage,scope,pin,provider,agreement)).delegationHash;
}
/** Exact replay is recognized against the same fresh state used for the CAS. */
export async function acceptAdmissionAgreementWithOutcome(storage,scope,pin,provider,agreement) {
 scope=copy(scope);agreement=copy(agreement);const {record,state,nodes}=await load(storage,scope,pin,provider);
 if(agreement.parentHead!==state.activeHead)throw Error('CONFLICT');
 const result=await checkAdmissionAgreement(nodes.get(state.activeHead),agreement,provider);
 if(result.status!=='accepted')throw Error(result.reason);
 const retained=current=>(current.agreements??[]).some(value=>JSON.stringify(canonical(value))===JSON.stringify(canonical(agreement)));
 if(retained(state))return {delegationHash:result.delegationHash,replayed:true};
 state.agreements??=[];state.agreements.push(agreement);
 await verifyAuthority(state,pin,provider);
 try{await save(storage,record,state,provider)}catch(error){
  if(error?.message!=='CONFLICT')throw error;
  const latest=await load(storage,scope,pin,provider);
  if(latest.state.activeHead!==agreement.parentHead||!retained(latest.state))throw error;
  return {delegationHash:result.delegationHash,replayed:true};
 }
 return {delegationHash:result.delegationHash,replayed:false};
}

/** Resolve admission evidence from the current pinned authority, without releasing keys. */
async function checkCurrentAdmissionAssociation(storage,scope,pin,provider,item,grant,manifest,associate) {
 item=copy(item); grant=copy(grant); manifest=copy(manifest);
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
 const association=await associate(parent,grant,manifest,provider);
 if(association.reason!=='SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED') throw Error(association.reason || 'INVALID_MANIFEST');
 return {status:'pending',reason:'CEREMONY_AND_SOURCE_EVIDENCE_REQUIRED',admissionEventHash:admission.eventHash,grantHash:proof.grantHash,authorityRevision:record.revision,authorizationSnapshot:record.authorizationSnapshot};
}

export async function checkCurrentAdmission(storage,scope,pin,provider,item,grant,manifest,snapshot) {
 snapshot=new Uint8Array(snapshot);
 return checkCurrentAdmissionAssociation(storage,scope,pin,provider,item,grant,manifest,
  (parent,grant,manifest,provider)=>checkGrantManifest(parent,grant,manifest,snapshot,provider));
}

export async function checkCurrentAdmissionMetadata(storage,scope,pin,provider,item,grant,manifest) {
 return checkCurrentAdmissionAssociation(storage,scope,pin,provider,item,grant,manifest,checkGrantManifestMetadata);
}

/** Verify the complete proof bundle at the selected parent. This does not publish
 * or create a successor; those require the atomic guarded publication transaction. */
export async function checkAdmissionProofs(storage,scope,pin,provider,sodium,item,grant,manifest,snapshot,ceremonies,existingCeremonies,localDeviceId,sourceRuntime,policyBundle,disclosureService) {
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
 const source=await checkProjectionSource(storage,expectedAuthority,manifest,grant,snapshot,provider,sourceRuntime,policyBundle,disclosureService);
 if(source.seed){const seedPeer=manifest.schemaVersion.split('|')[2];if([...Object.values(parent.runtime.authorPeers),...subject.devices.map(d=>d.peerId)].includes(seedPeer))throw Error('INVALID_SEED_PEER')}
 return {status:'pending',reason:'ATOMIC_SUCCESSOR_REQUIRED',admissionEventHash:proof.admissionEventHash,grantHash:proof.grantHash,expectedAuthority,sourceDocument:source.sourceDocument,seed:source.seed,policySeed:source.policySeed,devices,existingDevices};
}

/** Verify, then commit the fresh projection, key packages, guard consumption and
 * selected successor in one transaction. A saved retry is checked before RNG. */
export async function publishHouseholdAdmission(input) {
 const {storage,scope,pin,provider,master,operationId,keyOperationId,localDeviceId,signingSecret}=input;
 const {item,grant,manifest,snapshot,ceremonies,existingCeremonies,selection,pendingEdits,policyBundle}=structuredClone({item:input.item,grant:input.grant,manifest:input.manifest,snapshot:input.snapshot,ceremonies:input.ceremonies,existingCeremonies:input.existingCeremonies,selection:input.selection,pendingEdits:input.pendingEdits,policyBundle:input.policyBundle});
 await sodium.ready;
 const saved=await storage.getProjectionPublication(scope.id,operationId);if(!saved.ok)throw Error(saved.error);
 const packed={...item,admission:{grant,manifest,ceremonies:encodeEvidence(ceremonies),existingCeremonies:encodeEvidence(existingCeremonies),localDeviceId,operationId}};
 if(saved.value) {
  const p=saved.value;let state;try{state=JSON.parse(dec.decode(p.nextAuthority.authorityState))}catch{throw Error('CORRUPT')}
  const replayed=await verifyAuthority(state,pin,provider);
  const current=(await load(storage,scope,pin,provider)).record;
  if(!current || current.revision!==p.nextAuthority.revision || current.acceptedParent!==p.nextAuthority.acceptedParent || current.authorizationSnapshot!==p.nextAuthority.authorizationSnapshot || hex(current.authorityState)!==hex(p.nextAuthority.authorityState) || p.admissionEventHash!==await digest(provider,'event',item.event) || p.grantHash!==await digest(provider,'current-state-grant',Object.fromEntries(Object.entries(grant).filter(([k])=>k!=='signatures'))) || JSON.stringify(canonical(state.events.find(e=>e.event?.parentHead===item.event?.parentHead && e.event?.proposalId===item.event?.proposalId)))!==JSON.stringify(canonical(packed)) || JSON.stringify(canonical(state.selections.at(-1)))!==JSON.stringify(canonical(selection)) || hex(p.manifest.bytes)!==hex(bytes(manifest)) || p.manifest.id!==grant.projectionManifestHash || p.documents.length!==1 || p.documents[0].documentId!==manifest.newDocumentId || p.documents[0].generation!==grant.newDocumentGeneration || hex(p.documents[0].bytes)!==hex(snapshot) || p.localKey.record.operationId!==keyOperationId || p.localKey.record.identity.deviceId!==localDeviceId || JSON.stringify(canonical(p.pendingEdits))!==JSON.stringify(canonical(pendingEdits)) || ([2,3,4].includes(manifest.version) && JSON.stringify(canonical(p.policySeed?.bundle))!==JSON.stringify(canonical(policyBundle)))) throw Error('CONFLICT');
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
 const checked=await checkAdmissionProofs(storage,scope,pin,provider,sodium,item,grant,manifest,snapshot,ceremonies,existingCeremonies,localDeviceId,input.sourceRuntime,policyBundle,input.disclosureService);
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
 const publication={version:1,...(checked.seed?{seed:checked.seed}:{}),...(checked.policySeed?{policySeed:checked.policySeed}:{}),operationId,guardIds:guards,sourceDocument:checked.sourceDocument,expectedAuthority:checked.expectedAuthority,nextAuthority:{scope,revision:record.revision+1,acceptedParent:state.activeHead,authorizationSnapshot:await snapshotId(provider,state),authorityState:bytes(state)},admissionEventHash:checked.admissionEventHash,grantHash:checked.grantHash,manifest:{id:grant.projectionManifestHash,bytes:bytes(manifest)},epochId:grant.newEpochId,documents:[{documentId:manifest.newDocumentId,generation:grant.newDocumentGeneration,bytes:new Uint8Array(snapshot)}],packages:prepared.packets,localKey:{record:prepared.record,catalog:prepared.catalog},pendingEdits};
 const committed=await storage.publishProjection(publication);if(!committed.ok) throw Error(committed.error);
 const durable=await storage.getProjectionPublication(scope.id,operationId);if(!durable.ok || !durable.value)throw Error(durable.error || 'CORRUPT');
 return {replayed:committed.value.replayed,publication:durable.value};
}

/** Historical inspection only: resolve a head actually selected in the pinned chain.
 * This grants no present authority and does not authorize publication. */
export async function resolveHistoricalAuthority(storage,scope,pin,provider,head) {
 const verified=await load(storage,scope,pin,provider);
 return historicalAuthority(verified,scope,pin,head);
}

function historicalAuthority({record,state,nodes,seedSchemas},scope,pin,head) {
 const selected=new Set([pin,...state.selections.map(s=>s.to)]);
 if(!selected.has(head))throw Error('HISTORICAL_HEAD_NOT_SELECTED');
 const node=nodes.get(head);if(!node)throw Error('MISSING_PARENT');
 const devices=node.devices.filter(d=>d.active);
 return {scope:{scopeId:scope.id,documentId:node.runtime.documentId,documentGeneration:node.generation,branchHead:head,policyHashes:[node.policyHash],epochId:node.epochId,acceptedAuthors:devices.map(d=>d.deviceId).sort(),authorPeers:copy(node.runtime.authorPeers),suiteId:'candidate-ed25519-xchacha20-sealedbox-v1'},signingKeyRefs:Object.fromEntries(devices.map(d=>[d.deviceId,d.signingKeyRef])),seedSchemaVersion:seedSchemas.get(head)??1,expectedAuthority:{version:2,scope:copy(scope),record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}}};
}

/** A report may inherit cooking operations only along verified checkout edges. */
export async function resolveHistoricalPolicyLineage(storage,scope,pin,provider,head,maxHeads) {
 const verified=await load(storage,scope,pin,provider);
 const ancestors=policyBranchAncestors(verified,head);
 if(!ancestors.length)throw Error('HISTORICAL_HEAD_NOT_SELECTED');
 if(ancestors.length>maxHeads)throw Error('AUTHORITY_HEAD_BUDGET');
 if(verified.legacyPolicyHeads.has(ancestors.at(-1).head))throw Error('UNSUPPORTED_POLICY_LINEAGE');
 const ordered=ancestors.reverse();
 return ordered.map((node,index)=>({
  authority:historicalAuthority(verified,scope,pin,node.head),
  upperBound:verified.policyParents.get(ordered[index+1]?.head)?.baseline??null
 }));
}

/** Publish a deliberately selected, previously authenticated compromise draft.
 * The existing projection transaction installs the independent key, packages,
 * document, authority and ceremony guards together. */
async function publishHouseholdSuccessor(input,kind) {
 const {storage,scope,pin,provider,master,operationId,keyOperationId,localDeviceId,signingSecret,reviews,reviewId,runtime}=input;
 if(!storage?.compromise||reviews!==storage.compromise)throw Error('UNTRUSTED_REVIEW_STORE');
 const {item,grant,manifest,ceremonies,selection,pendingEdits}=structuredClone({item:input.item,grant:input.grant,manifest:input.manifest,ceremonies:input.ceremonies,selection:input.selection,pendingEdits:input.pendingEdits});
 await sodium.ready;
 const saved=await storage.getProjectionPublication(scope.id,operationId);if(!saved.ok)throw Error(saved.error);
 if(saved.value){const p=saved.value,{record:current,state:durable}=await load(storage,scope,pin,provider),rotation={authorizationSnapshot:p.expectedAuthority.record?.authorizationSnapshot,ceremonies:encodeEvidence(ceremonies),grant,localDeviceId,manifest,operationId,...(kind==='recoverDevice'?{recoveryProof:input.recoveryProof}:{})},packed={...item,rotation},review=await reviews.get(scope.id,reviewId);if(current.revision!==p.nextAuthority.revision||current.acceptedParent!==p.nextAuthority.acceptedParent||current.authorizationSnapshot!==p.nextAuthority.authorizationSnapshot||!durable.events.some(x=>JSON.stringify(canonical(x))===JSON.stringify(canonical(packed)))||JSON.stringify(canonical(durable.selections.at(-1)))!==JSON.stringify(canonical(selection))||p.localKey.record.operationId!==keyOperationId||p.localKey.record.identity.deviceId!==localDeviceId||!review||review.status!=='local-draft'||review.draft.documentId!==p.documents[0]?.documentId||!review.draft.currentSeed||hex(review.draft.currentSeed.snapshot)!==hex(p.documents[0]?.bytes)||JSON.stringify(canonical(p.pendingEdits))!==JSON.stringify(canonical(pendingEdits)))throw Error('CONFLICT');return {replayed:true,publication:p}}
 const {record,state,nodes}=await load(storage,scope,pin,provider),parent=nodes.get(state.activeHead);
 if(item?.event?.kind!==kind||item?.event?.parentHead!==state.activeHead||scope.kind!=='household'||runtime.scope.scopeId!==scope.id||!parent)throw Error('CONFLICT');
 const {checkRotationEvidence}=await import('../compromise/rotation-proof.mjs');
 const checked=await checkRotationEvidence({sodium,parent,authorizationSnapshot:record.authorizationSnapshot,item,grant,ceremonies,localDeviceId,provider});
 const signer=parent.devices.find(d=>d.active&&d.deviceId===localDeviceId),challenge=domain('rotation-local-signer',{householdId:scope.id,parentHead:parent.head,operationId});
 if(!signer||!(signingSecret instanceof Uint8Array)||signingSecret.length!==64||!await provider.verify(signer.signingKeyRef,challenge,sodium.crypto_sign_detached(challenge,signingSecret)))throw Error('INVALID_KEY');
 const expectedAuthority={version:2,scope:copy(scope),record:{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}},review=await reviews.get(scope.id,reviewId);
 if(!review||review.status!=='local-draft'||review.context.authorityHead!==record.acceptedParent||review.context.authorityRevision!==record.revision||review.context.authoritySnapshot!==record.authorizationSnapshot||review.context.kind!=='household'||review.draft.held.length||!review.draft.currentSeed||review.draft.documentId!==item.event.subject.documentId||review.draft.publicationBaseDocumentId!==parent.runtime.documentId)throw Error('INVALID_DRAFT');
 const {verifyReport}=await import('../compromise/report.mjs');if(await verifyReport({runtime,report:review.report,context:review.context,reviewId,manifest:review.manifest})!==review.reportHash)throw Error('INVALID_REPORT');
 const source=await storage.reopenBranchDocument(expectedAuthority,parent.runtime.documentId);if(!source.ok||!source.value)throw Error('SOURCE_UNAVAILABLE');
 const seed=review.draft.currentSeed,{projectCurrentSeed}=await import('../compromise/current-seed.mjs'),recomputed=projectCurrentSeed({LoroDoc:runtime.LoroDoc,source:review.draft.snapshot,seedId:seed.seedId,peerId:seed.peerId});if(hex(recomputed.snapshot)!==hex(seed.snapshot)||JSON.stringify(canonical(recomputed.identities))!==JSON.stringify(canonical(seed.identities)))throw Error('INVALID_SEED');const draftDoc=new runtime.LoroDoc(),oldDoc=new runtime.LoroDoc();try{draftDoc.import(seed.snapshot);oldDoc.import(source.value.bytes)}catch{throw Error('INVALID_DRAFT')}const oldPeers=new Set([...oldDoc.oplogVersion().toJSON().keys(),...Object.values(parent.runtime.authorPeers),...item.event.subject.devices.map(d=>d.peerId)]);if([...draftDoc.oplogVersion().toJSON().keys()].some(p=>oldPeers.has(p)))throw Error('INVALID_DRAFT_PEERS');
 const expectedManifest={version:1,scopeId:scope.id,sourceDocumentId:parent.runtime.documentId,sourceRevision:source.value.revision,sourceHash:await digest(provider,'rotation-source-snapshot',hex(source.value.bytes)),reviewId,evidenceDocumentId:review.draft.sourceDocumentId,evidenceGeneration:review.draft.sourceGeneration,reportHash:review.reportHash,selectionHash:await digest(provider,'rotation-selection',review.selection),newDocumentId:item.event.subject.documentId,newGeneration:item.event.subject.newGeneration,newEpochId:item.event.subject.newEpochId,draftHash:await digest(provider,'rotation-draft-snapshot',hex(seed.snapshot)),seedId:seed.seedId,seedIdentitiesHash:await digest(provider,'projection-seed-identities',seed.identities),archiveHash:await digest(provider,'rotation-archive-snapshot',hex(review.draft.snapshot))};
 if(JSON.stringify(canonical(manifest))!==JSON.stringify(canonical(expectedManifest))||await digest(provider,'rotation-manifest',manifest)!==grant.manifestHash||selection.from!==parent.head||selection.to!==checked.eventHash||!Array.isArray(pendingEdits))throw Error('INVALID_MANIFEST');
 let recoveryGuard=null;
 if(kind==='recoverDevice'){
  const proof=input.recoveryProof,{checkRecoveryReadmission}=await import('../recovery/readmission.mjs');
  const readmission=await checkRecoveryReadmission({sodium,storage,recoveryRun:input.recoveryRun,scope,pin,provider,claim:proof.claim,continuitySignature:proof.continuitySignature,deviceSignature:proof.deviceSignature,continuityBinding:proof.binding,continuityBindingSignature:proof.bindingSignature,continuityRegistry:input.continuityRegistry,possession:proof.possession,confirmations:proof.confirmations});
  if(readmission.reason!=='ADMISSION_TRANSITION_REQUIRED'||readmission.bindingHash!==item.event.subject.bindingHash||readmission.bindingGeneration!==item.event.subject.bindingGeneration||readmission.authorityRevision!==record.revision||readmission.authorityHead!==state.activeHead||hex(signingSecret.slice(32))!==proof.senderSigningKey||!(input.wrappingSecret instanceof Uint8Array)||input.wrappingSecret.length!==32||hex(sodium.crypto_scalarmult_base(input.wrappingSecret))!==proof.senderWrappingKey)throw Error('INVALID_RECOVERY_PROOF');
  recoveryGuard={owner:item.event.subject.owner,generation:readmission.bindingGeneration,bindingHash:readmission.bindingHash,claimHash:item.event.subject.claimHash,tokenCommitment:proof.challenge.tokenCommitment,sealed:proof.challenge.sealed};
 }
 const packed={...item,rotation:{authorizationSnapshot:record.authorizationSnapshot,ceremonies:encodeEvidence(ceremonies),grant,localDeviceId,manifest,operationId,...(kind==='recoverDevice'?{recoveryProof:input.recoveryProof}:{})}};
 state.events.push(packed);state.selections.push(selection);state.activeHead=selection.to;await verifyAuthority(state,pin,provider);
 const {makeKeyPackage}=await import('../pairing/key-package.mjs'),others=item.event.subject.devices.filter(d=>d.deviceId!==localDeviceId);
 if(others.length!==ceremonies.length+(kind==='recoverDevice'?1:0))throw Error('CEREMONY_REQUIRED');
 const identity={version:1,scope,deviceId:localDeviceId,purpose:'data',epochId:item.event.subject.newEpochId};
 const prepared=await storage.localKeys(master,sodium).prepareForAtomicInstall(keyOperationId,identity,async secret=>others.map((recipient,i)=>{const packageId=grant.packageRefs[i];let transcriptHash,senderSigningKey,senderWrappingKey,recipientSigningKey;
  if(kind==='recoverDevice'&&recipient.deviceId===item.event.subject.deviceId){transcriptHash=item.event.subject.claimHash;senderSigningKey=input.recoveryProof.senderSigningKey;senderWrappingKey=input.recoveryProof.senderWrappingKey;recipientSigningKey=input.recoveryProof.claim.signingKey}
  else {const e=ceremonies.find(x=>x.context.recipientDeviceId===recipient.deviceId),proof=checked.devices.find(x=>x.deviceId===recipient.deviceId);if(!e||!proof||!sodium.crypto_sign_verify_detached(sodium.crypto_sign_detached(challenge,signingSecret),challenge,e.transcript.initiator.signingPublicKey))throw Error('INVALID_KEY');transcriptHash=proof.transcriptHash;senderSigningKey=hex(e.transcript.initiator.signingPublicKey);senderWrappingKey=hex(e.transcript.initiator.wrappingPublicKey);recipientSigningKey=hex(e.transcript.responder.signingPublicKey)}
  if(!packageId)throw Error('INVALID_KEY');const context={version:1,transcriptHash,releaseId:packageId,scopeKind:'household',scopeId:scope.id,purpose:'data',epochId:item.event.subject.newEpochId,generation:item.event.subject.newGeneration,senderDevice:localDeviceId,senderSigningKey,senderWrappingKey,recipientDevice:recipient.deviceId,recipientSigningKey,recipientWrappingKey:recipient.wrappingKeyRef,policyHash:item.event.policyHash,grantHash:checked.grantHash,projectionId:item.event.subject.documentId,manifestHash:grant.manifestHash};return {id:packageId,recipientDevice:recipient.deviceId,bytes:makeKeyPackage(sodium,context,secret,signingSecret)}}));
 const publication={version:1,seed:{seedId:seed.seedId,identities:seed.identities},...(recoveryGuard?{recovery:recoveryGuard}:{}),...(others.length?{guardIds:checked.devices.map(d=>d.guardId).sort()}:{singleRecipient:true}),operationId,sourceDocument:{documentId:parent.runtime.documentId,revision:source.value.revision},expectedAuthority,nextAuthority:{scope,revision:record.revision+1,acceptedParent:state.activeHead,authorizationSnapshot:await snapshotId(provider,state),authorityState:bytes(state)},admissionEventHash:checked.eventHash,grantHash:checked.grantHash,manifest:{id:grant.manifestHash,bytes:bytes(manifest)},epochId:item.event.subject.newEpochId,documents:[{documentId:item.event.subject.documentId,generation:item.event.subject.newGeneration,bytes:seed.snapshot}],packages:prepared.packets,localKey:{record:prepared.record,catalog:prepared.catalog},pendingEdits};
 const committed=await storage.publishProjection(publication);if(!committed.ok)throw Error(committed.error);return {replayed:committed.value.replayed,publication};
}

export async function publishHouseholdRevocation(input){return publishHouseholdSuccessor(input,'revokeDevice')}
export async function publishHouseholdRecovery(input){
 return input.grant?.version===2 ? publishReviewedRevocation(input) : publishHouseholdSuccessor(input,'recoverDevice');
}

function recoveryGuardFor(item,proof){
 const {owner,bindingGeneration:generation,bindingHash,claimHash}=item.event.subject;
 return {owner,generation,bindingHash,claimHash,tokenCommitment:proof.challenge.tokenCommitment,sealed:proof.challenge.sealed};
}
function sameRecoveryGuard(guard,item){
 return guard&&hex(bytes(guard))===hex(bytes(recoveryGuardFor(item,item.rotation.recoveryProof)));
}

/** Publish a v4 clean seed and new data key against the exact reviewed source. */
export async function publishReviewedRevocation({
 storage,scope,pin,provider,master,deviceId,signingSecret,wrappingSecret,runtime,item,grant,manifest,recipientBindings,sha256,recoveryProof,recoveryRun,continuityRegistry
}) {
 ({item,grant,manifest,recipientBindings,recoveryProof}=copy({item,grant,manifest,recipientBindings,recoveryProof}));
 const current=await load(storage,scope,pin,provider), {record,state,nodes}=current;
 const event=item?.event,parent=nodes.get(event?.parentHead);
 if(!parent||event.authorDeviceId!==deviceId||runtime.scope.scopeId!==scope.id)throw Error('INVALID_AUTHORITY');
 const checked=await verifyRevocation({provider,parent,item,grant,manifest,recipientBindings});
 const recovery=event.kind==='recoverDevice';
 if(recovery!==!!recoveryProof)throw Error('INVALID_RECOVERY_PROOF');
 const operationId=event.proposalId, keyOperationId=`revocation-key:${operationId}`;
 const packed={...item,rotation:{authorizationSnapshot:manifest.authorizationSnapshot,recipientBindings,grant,localDeviceId:deviceId,manifest,operationId,...(recovery?{recoveryProof}:{})}};
 const replay=async()=>{
  const saved=await storage.getProjectionPublication(scope.id,operationId);
  if(!saved.ok)throw Error(saved.error);
  if(!saved.value)return null;
  const durable=(await load(storage,scope,pin,provider)).state;
  if(!durable.events.some(entry=>hex(bytes(entry))===hex(bytes(packed)))||
     saved.value.admissionEventHash!==checked.eventHash||saved.value.grantHash!==checked.grantHash)throw Error('CONFLICT');
  return {acceptedHead:checked.eventHash,operationId,replayed:true};
 };
 const prior=await replay();
 if(prior)return prior;
 const expectedAuthority=await runtime.authorize();
 if(state.activeHead!==parent.head||record.authorizationSnapshot!==manifest.authorizationSnapshot||
    expectedAuthority.record.revision!==record.revision)throw Error('STALE_AUTHORITY');
 const source=await storage.reopenBranchDocument(expectedAuthority,parent.runtime.documentId);
 if(!source.ok)throw Error(source.error);
 let recoveryGuard;
 if(recovery){
  await sodium.ready;
  const {checkRecoveryReadmission}=await import('../recovery/readmission.mjs');
  const proof=recoveryProof;
  const checked=await checkRecoveryReadmission({sodium,storage,recoveryRun,scope,pin,provider,continuityRegistry,
   claim:proof.claim,continuitySignature:proof.continuitySignature,deviceSignature:proof.deviceSignature,
   continuityBinding:proof.binding,continuityBindingSignature:proof.bindingSignature,possession:proof.possession,confirmations:proof.confirmations});
  if(checked.reason!=='ADMISSION_TRANSITION_REQUIRED'||checked.authorityRevision!==record.revision||
     checked.bindingHash!==event.subject.bindingHash||checked.bindingGeneration!==event.subject.bindingGeneration)throw Error('INVALID_RECOVERY_PROOF');
  recoveryGuard=recoveryGuardFor(item,proof);
 }
 let seed, sourceGuard={source:source.value};
 if(event.kind==='removeAdult'||recovery){
  if((source.value?.revision??null)!==manifest.sourceRevision||
     await digest(provider,'rotation-source-snapshot',hex(source.value?.bytes??new Uint8Array()))!==manifest.sourceHash)throw Error('SOURCE_CHANGED');
  seed=projectRemovalSeed({LoroDoc:runtime.LoroDoc,source:source.value,seedId:manifest.seedId,peerId:manifest.seedPeerId});
  await verifyRevocationSeed({provider,LoroDoc:runtime.LoroDoc,parent,item,manifest,snapshot:seed.snapshot,seed});
 }else{
  const review=await storage.compromise.get(scope.id,manifest.reviewId);
  const original=review&&await storage.compromise.inspectOriginal(scope.id,manifest.reviewId,sha256);
  seed=await verifiedRevocationDraft({runtime,provider,item,manifest,review,original,source:source.value,sha256});
  sourceGuard={...sourceGuard,reviewId:manifest.reviewId,review,original:{checkpoint:original.checkpointBytes,objects:original.objects.map(o=>o.bytes)}};
 }
 await sodium.ready;
 const publisher=event.subject.devices.find(d=>d.deviceId===deviceId);
 if(!(signingSecret instanceof Uint8Array)||signingSecret.length!==64||hex(signingSecret.subarray(32))!==publisher.signingKeyRef||
    recovery&&(!(wrappingSecret instanceof Uint8Array)||wrappingSecret.length!==32||hex(sodium.crypto_scalarmult_base(wrappingSecret))!==publisher.wrappingKeyRef))throw Error('INVALID_KEY');
 const select={root:pin,householdId:scope.id,from:parent.head,to:checked.eventHash,deviceId,index:state.selections.length};
 const selection={from:select.from,to:select.to,deviceId,index:select.index,signature:hex(sodium.crypto_sign_detached(domain('select-head',select),signingSecret))};
 const next={...state,events:[...state.events,packed],selections:[...state.selections,selection],activeHead:checked.eventHash};
 await verifyAuthority(next,pin,provider);
 const packages=await Promise.all(event.subject.devices.filter(d=>d.deviceId!==deviceId)
  .map(d=>revocationPackage({provider,parent,item:packed,recipientDevice:d.deviceId})));
 const identity={version:1,scope,deviceId,purpose:'data',epochId:event.subject.newEpochId};
 const {makeKeyPackage}=await import('../pairing/key-package.mjs');
 try{
  const prepared=await storage.localKeys(master,sodium).prepareForAtomicInstall(keyOperationId,identity,secret=>
    packages.map(({context})=>({id:context.releaseId,recipientDevice:context.recipientDevice,bytes:makeKeyPackage(sodium,context,secret,signingSecret)})));
   const nextAuthority={scope,revision:record.revision+1,acceptedParent:next.activeHead,authorizationSnapshot:await snapshotId(provider,next),authorityState:bytes(next)};
   const result=await storage.publishProjection({
    version:1,seed:{seedId:seed.seedId,identities:seed.identities},
    ...(recovery?{recovery:recoveryGuard}:{}),
    ...(packages.length ? {guardIds:packages.map(p=>p.guardId).sort()} : {singleRecipient:true}),
    operationId,sourceDocument:{documentId:parent.runtime.documentId,revision:manifest.sourceRevision},
    expectedAuthority,nextAuthority,admissionEventHash:checked.eventHash,grantHash:checked.grantHash,
    manifest:{id:grant.manifestHash,bytes:bytes(manifest)},epochId:identity.epochId,
    documents:[{documentId:event.subject.documentId,generation:event.subject.newGeneration,bytes:seed.snapshot}],
    packages:prepared.packets,localKey:{record:prepared.record,catalog:prepared.catalog},
    // Old document, outbox and pending inbox rows keep their original owners.
    pendingEdits:[]
   },sourceGuard);
   if(!result.ok)throw Error(result.error);
   return {acceptedHead:checked.eventHash,operationId,replayed:result.value.replayed};
 }catch(error){
  if(error.message==='CONFLICT'){
   const concurrent=await replay();
   if(concurrent)return concurrent;
  }
  throw error;
 }
}

export async function verifiedRevocationDraft({runtime,provider,item,manifest,review,original,source,sha256}) {
 const {verifyReport}=await import('../compromise/report.mjs');
 const {projectCurrentSeed}=await import('../compromise/current-seed.mjs');
 const draft=review?.draft, event=item.event;
 if(!review?.isolated||review.status!=='local-draft'||!review.selection||draft.held.length||
    draft.documentId!==manifest.newDocumentId||draft.publicationBaseDocumentId!==manifest.sourceDocumentId||
    review.context.authorityHead!==event.parentHead||review.context.authoritySnapshot!==manifest.authorizationSnapshot||
    draft.sourceDocumentId!==manifest.evidenceDocumentId||draft.sourceGeneration!==manifest.evidenceGeneration||
    review.report.payload.head!==event.parentHead||JSON.stringify(review.report.payload.suspectDeviceIds)!==JSON.stringify([event.subject.deviceId])||
    review.reportHash!==manifest.reportHash||original?.checkpointBytes==null||original.missing.length)throw Error('INVALID_DRAFT');
 if(await verifyReport({runtime,report:review.report,context:review.context,reviewId:manifest.reviewId,manifest:review.manifest,sha256})!==manifest.reportHash||
    await digest(provider,'rotation-selection',review.selection)!==manifest.selectionHash||
    await digest(provider,'rotation-archive-snapshot',hex(draft.snapshot))!==manifest.archiveHash||
    draft.publicationBaseRevision!==manifest.sourceRevision||
    (source?.revision??null)!==manifest.sourceRevision||
    await digest(provider,'rotation-source-snapshot',hex(source?.bytes??new Uint8Array()))!==manifest.sourceHash)throw Error('SOURCE_CHANGED');
 const seed=projectCurrentSeed({LoroDoc:runtime.LoroDoc,source:draft.snapshot,seedId:manifest.seedId,peerId:manifest.seedPeerId,schemaVersion:4});
 const old=new runtime.LoroDoc();
 if(source)old.import(source.bytes);
 if(old.oplogVersion().toJSON().has(seed.peerId))throw Error('INVALID_DRAFT_PEERS');
 await verifyRevocationSeed({provider,LoroDoc:runtime.LoroDoc,parent:{runtime:{authorPeers:runtime.scope.authorPeers}},item,manifest,snapshot:seed.snapshot,seed});
 return seed;
}
