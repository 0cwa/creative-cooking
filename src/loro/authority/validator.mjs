// Candidate encoding and limits only; not a C1 wire contract or production authority.
const enc = new TextEncoder();
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const keys = (o, ks) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === ks.length && ks.every(k => Object.hasOwn(o,k));
const dense = a => {
 if (!Array.isArray(a)) return false;
 for(let i=0;i<a.length;i++) if(!Object.hasOwn(a,i)) return false;
 return true;
};
const ids = a => Array.isArray(a) && a.length > 0 && a.length <= 64 && dense(a) && a.every(id) && new Set(a).size === a.length && a.every((v,i) => !i || a[i-1] < v);
const hex = b => Array.from(b, x => x.toString(16).padStart(2,'0')).join('');
const signature = s => typeof s === 'string' && /^[0-9a-f]{128}$/.test(s) ? Uint8Array.from(s.match(/../g), x => parseInt(x,16)) : null;
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k,canonical(v[k])])) : v;
const domain = (purpose, value) => enc.encode(JSON.stringify(['creative-cooking/authority-candidate/v1',purpose,canonical(value)]));
export const validAdmissionPolicy = (p,n) => keys(p,['kind','fixedCount']) && (p.kind === 'fixed' ? Number.isSafeInteger(p.fixedCount) && p.fixedCount >= 1 && p.fixedCount <= n : ['allMinusOne','unanimous'].includes(p.kind) && p.fixedCount === null);
export const admissionThreshold = (p,n) => p.kind === 'fixed' ? p.fixedCount : p.kind === 'unanimous' ? n : Math.max(1,n-1);
export const isPolicyDocumentId = id => typeof id==='string' && /^policy-[0-9a-f]{64}$/.test(id);
const deny = reason => ({status:'deny',reason});
const pending = reason => ({status:'pending',reason});
const validRuntime = (r,devices) => {
 if (!keys(r,['documentId','authorPeers','acceptedRecipients']) || !id(r.documentId) || !r.authorPeers || typeof r.authorPeers!=='object' || Array.isArray(r.authorPeers) || !dense(r.acceptedRecipients)) return false;
 const active=devices.filter(d=>d.active).map(d=>d.deviceId).sort(), peers=Object.keys(r.authorPeers).sort();
 if (JSON.stringify(active)!==JSON.stringify(peers) || !active.length || active.length>128) return false;
 const values=Object.values(r.authorPeers), validPeer=p=>typeof p==='string' && p.length<=20 && /^(0|[1-9][0-9]*)$/.test(p) && BigInt(p)<=18446744073709551615n;
 return values.every(validPeer) && new Set(values).size===values.length && r.acceptedRecipients.every(x=>active.includes(x)) && new Set(r.acceptedRecipients).size===r.acceptedRecipients.length && r.acceptedRecipients.every((v,i)=>!i || r.acceptedRecipients[i-1]<v);
};
// Inactive device IDs remain reserved after their adult leaves the roster.
export const validParent = parent => !(!keys(parent,['householdId','head','policyHash','generation','epochId','roster','devices','policy','runtime']) || ![parent.householdId,parent.head,parent.policyHash,parent.epochId].every(id) || !Number.isSafeInteger(parent.generation) || parent.generation < 0 || !ids(parent.roster) || !validAdmissionPolicy(parent.policy,parent.roster.length) || !Array.isArray(parent.devices) || parent.devices.length > 128 || !dense(parent.devices) || !parent.devices.every(d=>keys(d,['deviceId','adultId','signingKeyRef','active']) && id(d.deviceId) && id(d.signingKeyRef) && id(d.adultId) && (!d.active || parent.roster.includes(d.adultId)) && typeof d.active === 'boolean') || new Set(parent.devices.map(d=>d.deviceId)).size !== parent.devices.length || !validRuntime(parent.runtime,parent.devices));
export const isRemoval = kind => kind==='revokeDevice' || kind==='removeAdult';
export const removedDevice = (event, device) => event.kind==='removeAdult' ?
 device.adultId===event.subject.adultId : event.kind==='revokeDevice' && device.deviceId===event.subject.deviceId;
export function remainingRotationDevices(parent,event) {
 const devices=parent.devices.filter(d=>d.active&&!removedDevice(event,d));
 if(event.kind==='removeAdult'){
  // Adult removal carries this order into the child's acceptedRecipients.
  return devices.sort((a,b)=>a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0);
 }
 return devices.sort((a,b)=>a.deviceId.localeCompare(b.deviceId));
}
const eventFields = ['version','suiteId','householdId','parentHead','policyHash','generation','epochId','proposalId','kind','authorDeviceId','frozenAdultRoster','subject','nextPolicy'];
const approvalFields = ['version','householdId','eventHash','parentHead','policyHash','generation','epochId','adultId','deviceId','signature'];
export const validPolicyBaseline = subject => keys(subject,['frontiers','historyHash']) &&
 typeof subject.historyHash==='string' && /^[0-9a-f]{64}$/.test(subject.historyHash) &&
 dense(subject.frontiers) && subject.frontiers.length<=64 && subject.frontiers.every((point,index) =>
  keys(point,['peer','counter']) && typeof point.peer==='string' && /^(0|[1-9][0-9]{0,19})$/.test(point.peer) &&
  BigInt(point.peer)<=18446744073709551615n && Number.isSafeInteger(point.counter) && point.counter>=0 && point.counter<=2147483647 &&
  (!index || subject.frontiers[index-1].peer<point.peer));
// The caller must authenticate and freeze the parent from the accepted authority record.
// provider.verify(signingKeyRef, bytes, signature) must resolve exactly the frozen public key.
export async function validateSuccessor(parent, event, authorSignature, approvals, provider) {
 try {
  parent = structuredClone(parent); event = structuredClone(event); approvals = structuredClone(approvals);
  if (!validParent(parent)) return deny('INVALID_PARENT');
  if (!keys(event,eventFields) || ![1,2,3,4,5].includes(event.version) || (event.version===2 && !['inviteAdult','revokeDevice','removeAdult','recoverDevice'].includes(event.kind)) || (event.version===3 && event.kind!=='changePolicy') || (event.version>=4 && event.kind!=='pairOwnDevice') || event.suiteId !== 'candidate-ed25519-xchacha20-sealedbox-v1' || ![event.householdId,event.parentHead,event.policyHash,event.epochId,event.proposalId,event.authorDeviceId].every(id) || !Number.isSafeInteger(event.generation) || event.generation < 0 || !ids(event.frozenAdultRoster) || !['inviteAdult','changePolicy','pairOwnDevice','revokeDevice','removeAdult','recoverDevice'].includes(event.kind)) return deny('INVALID_INPUT');
  if (event.householdId !== parent.householdId || event.parentHead !== parent.head) return pending('PARENT_UNRESOLVED');
  if (event.policyHash !== parent.policyHash || event.generation !== parent.generation || event.epochId !== parent.epochId || JSON.stringify(event.frozenAdultRoster) !== JSON.stringify(parent.roster)) return deny('CONTEXT_MISMATCH');
  const author = parent.devices.find(d=>d.deviceId === event.authorDeviceId && d.active);
  if (!author) return deny('UNAUTHORIZED_DEVICE');
  if (event.kind === 'inviteAdult') {
   const subject=event.subject;
   if(event.version===1) {
    if(!keys(subject,['adultId']) || !id(subject.adultId) || parent.roster.includes(subject.adultId) || event.nextPolicy!==null) return deny('INVALID_INPUT');
   } else {
    if(!keys(subject,['adultId','devices','documentId','newGeneration','newEpochId']) || !id(subject.adultId) || parent.roster.includes(subject.adultId) || !id(subject.documentId) || subject.documentId===parent.runtime.documentId || !Number.isSafeInteger(subject.newGeneration) || subject.newGeneration<=parent.generation || !id(subject.newEpochId) || subject.newEpochId===parent.epochId || event.nextPolicy!==null || !Array.isArray(subject.devices) || !subject.devices.length || subject.devices.length>128 || !dense(subject.devices)) return deny('INVALID_INPUT');
    const peers=new Set(Object.values(parent.runtime.authorPeers));
    for(let i=0;i<subject.devices.length;i++) {
     const d=subject.devices[i];
     if(!keys(d,['deviceId','signingKeyRef','wrappingKeyRef','peerId']) || ![d.deviceId,d.signingKeyRef,d.wrappingKeyRef].every(id) || parent.devices.some(p=>p.deviceId===d.deviceId) || (i && subject.devices[i-1].deviceId>=d.deviceId) || typeof d.peerId!=='string' || d.peerId.length>20 || !/^(0|[1-9][0-9]*)$/.test(d.peerId) || BigInt(d.peerId)>18446744073709551615n || peers.has(d.peerId)) return deny('INVALID_INPUT');
     peers.add(d.peerId);
    }
   }
  }
  if(isRemoval(event.kind)) {
   const s=event.subject, adult=event.kind==='removeAdult', target=adult?'adultId':'deviceId';
   if(event.version!==2||!keys(s,[target,'documentId','newGeneration','newEpochId','devices'])||!id(s[target])||
      !id(s.documentId)||s.documentId===parent.runtime.documentId||!Number.isSafeInteger(s.newGeneration)||s.newGeneration<=parent.generation||
      !id(s.newEpochId)||s.newEpochId===parent.epochId||event.nextPolicy!==null||!dense(s.devices)||!s.devices.length||s.devices.length>128)return deny('INVALID_INPUT');
   if(adult) {
    if(!parent.roster.includes(s.adultId)||parent.roster.length<2||removedDevice(event,author)||
       !parent.runtime.acceptedRecipients.includes(author.deviceId))return deny('INVALID_INPUT');
    if(!validAdmissionPolicy(parent.policy,parent.roster.length-1))return deny('FIXED_RULE_TOO_HIGH');
   } else if(!parent.devices.some(d=>d.active&&removedDevice(event,d)))return deny('INVALID_INPUT');
   const active=remainingRotationDevices(parent,event);
   if(s.devices.length!==active.length || (adult&&active.some(d=>!parent.runtime.acceptedRecipients.includes(d.deviceId))))return deny('INVALID_INPUT');
   const peers=new Set(Object.values(parent.runtime.authorPeers));for(let i=0;i<active.length;i++){const d=s.devices[i];if(!keys(d,['deviceId','signingKeyRef','wrappingKeyRef','peerId'])||d.deviceId!==active[i].deviceId||d.signingKeyRef!==active[i].signingKeyRef||typeof d.wrappingKeyRef!=='string'||!/^[0-9a-f]{64}$/.test(d.wrappingKeyRef)||typeof d.peerId!=='string'||!/^(0|[1-9][0-9]*)$/.test(d.peerId)||d.peerId.length>20||BigInt(d.peerId)>18446744073709551615n||peers.has(d.peerId))return deny('INVALID_INPUT');peers.add(d.peerId)}
  }
  if(event.kind==='recoverDevice') {
   const s=event.subject;if(event.version!==2||!keys(s,['owner','deviceId','signingKeyRef','wrappingKeyRef','claimHash','bindingHash','bindingGeneration','documentId','newGeneration','newEpochId','devices'])||!parent.roster.includes(s.owner)||!id(s.deviceId)||parent.devices.some(d=>d.deviceId===s.deviceId)||typeof s.signingKeyRef!=='string'||!/^[0-9a-f]{64}$/.test(s.signingKeyRef)||typeof s.wrappingKeyRef!=='string'||!/^[0-9a-f]{64}$/.test(s.wrappingKeyRef)||![s.claimHash,s.bindingHash,s.documentId,s.newEpochId].every(id)||!Number.isSafeInteger(s.bindingGeneration)||s.bindingGeneration<0||s.documentId===parent.runtime.documentId||!Number.isSafeInteger(s.newGeneration)||s.newGeneration<=parent.generation||s.newEpochId===parent.epochId||event.nextPolicy!==null||!Array.isArray(s.devices)||!dense(s.devices)||s.devices.length>128)return deny('INVALID_INPUT');
   const expected=[...parent.devices.filter(d=>d.active).map(d=>({deviceId:d.deviceId,signingKeyRef:d.signingKeyRef})),{deviceId:s.deviceId,signingKeyRef:s.signingKeyRef}].sort((a,b)=>a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0);if(s.devices.length!==expected.length)return deny('INVALID_INPUT');const peers=new Set(Object.values(parent.runtime.authorPeers));for(let i=0;i<expected.length;i++){const d=s.devices[i];if(!keys(d,['deviceId','signingKeyRef','wrappingKeyRef','peerId'])||d.deviceId!==expected[i].deviceId||d.signingKeyRef!==expected[i].signingKeyRef||typeof d.wrappingKeyRef!=='string'||!/^[0-9a-f]{64}$/.test(d.wrappingKeyRef)||(d.deviceId===s.deviceId&&d.wrappingKeyRef!==s.wrappingKeyRef)||typeof d.peerId!=='string'||!/^(0|[1-9][0-9]*)$/.test(d.peerId)||d.peerId.length>20||BigInt(d.peerId)>18446744073709551615n||peers.has(d.peerId))return deny('INVALID_INPUT');peers.add(d.peerId)}
  }
  if (event.kind === 'changePolicy' && ((event.version===3 ? !validPolicyBaseline(event.subject) : event.subject!==null) || !validAdmissionPolicy(event.nextPolicy,parent.roster.length))) return deny('INVALID_INPUT');
  if (event.kind === 'pairOwnDevice') {
   const s=event.subject;
   if(event.version===1) {
    if(!keys(s,['adultId','deviceId','signingKeyRef'])||s.adultId!==author.adultId||!id(s.deviceId)||!id(s.signingKeyRef)||parent.devices.some(d=>d.deviceId===s.deviceId)||event.nextPolicy!==null)return deny('INVALID_INPUT');
   } else {
    const digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
    const fields=['adultId','deviceId','signingKeyRef','wrappingKeyRef','peerId','documentId','parentSnapshot','parentRevision','transcriptHash','baseline','copyHash'];
    if(event.version===4)fields.push('sourcesHash');
    if(!keys(s,fields)||
       s.adultId!==author.adultId||!parent.runtime.acceptedRecipients.includes(author.deviceId)||!id(s.deviceId)||
       ![s.signingKeyRef,s.wrappingKeyRef,s.parentSnapshot,s.transcriptHash,s.copyHash].every(digest)||
       (event.version===4&&!digest(s.sourcesHash))||
       parent.devices.length>=128||parent.devices.some(d=>d.deviceId===s.deviceId||d.signingKeyRef===s.signingKeyRef)||
       typeof s.peerId!=='string'||!/^[1-9][0-9]{0,19}$/.test(s.peerId)||BigInt(s.peerId)>18446744073709551615n||
       Object.values(parent.runtime.authorPeers).includes(s.peerId)||!id(s.documentId)||!s.documentId.startsWith('paired-')||
       !Number.isSafeInteger(s.parentRevision)||s.parentRevision<0||!validPolicyBaseline(s.baseline)||event.nextPolicy!==null||!Array.isArray(approvals)||approvals.length!==0)return deny('INVALID_INPUT');
   }
  }
  const canonical = Object.fromEntries(eventFields.map(k=>[k,event[k]]));
  const hashBytes = await provider.hash(domain('event',canonical));
  if (!(hashBytes instanceof Uint8Array) || hashBytes.length !== 32) return deny('INVALID_PROOF');
  const eventHash = hex(hashBytes), sig = signature(authorSignature);
  if (!sig || !await provider.verify(author.signingKeyRef,domain('event-signature',canonical),sig)) return deny('INVALID_PROOF');
  if (!Array.isArray(approvals) || approvals.length > 128) return deny('INVALID_INPUT');
  const voters = new Set(), seenDevices = new Set();
  for (const a of approvals) {
   if (!keys(a,approvalFields) || a.version !== 1 || ![a.householdId,a.eventHash,a.parentHead,a.policyHash,a.epochId,a.adultId,a.deviceId].every(id) || !Number.isSafeInteger(a.generation)) return deny('INVALID_INPUT');
   if (a.householdId !== parent.householdId || a.eventHash !== eventHash || a.parentHead !== parent.head || a.policyHash !== parent.policyHash || a.generation !== parent.generation || a.epochId !== parent.epochId) return deny('CONTEXT_MISMATCH');
   const device = parent.devices.find(d=>d.deviceId === a.deviceId && d.active && d.adultId === a.adultId);
   const s = signature(a.signature);
   if (!device || !s || seenDevices.has(a.deviceId)) return deny('INVALID_PROOF');
   const unsigned = Object.fromEntries(approvalFields.slice(0,-1).map(k=>[k,a[k]]));
   if (!await provider.verify(device.signingKeyRef,domain('approval-signature',unsigned),s)) return deny('INVALID_PROOF');
   seenDevices.add(a.deviceId); voters.add(a.adultId);
  }
  if (event.kind === 'pairOwnDevice') return {...pending('CEREMONY_AND_POSSESSION_REQUIRED'),eventHash};
  const required = admissionThreshold(parent.policy,parent.roster.length);
  if (voters.size < required) return {...pending('QUORUM_REQUIRED'),eventHash,approvals:voters.size,required};
  if(event.kind==='recoverDevice')return {...pending('RECOVERY_DISTRIBUTION_REQUIRED'),eventHash,approvals:voters.size,required};
  if(isRemoval(event.kind))return {...pending('ROTATION_DISTRIBUTION_REQUIRED'),eventHash,approvals:voters.size,required};
  // Invitation also needs independent admission/delegation and fresh generation evidence.
  if (event.kind === 'inviteAdult') return {...pending('ADMISSION_AND_PROJECTION_REQUIRED'),eventHash,approvals:voters.size,required};
  return {status:'validated',eventHash,approvals:voters.size,required};
 } catch { return deny('INVALID_PROOF'); }
}
export {domain};
