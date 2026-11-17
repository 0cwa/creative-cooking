// Candidate encoding and limits only; not a C1 wire contract or production authority.
const enc = new TextEncoder();
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const keys = (o, ks) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === ks.length && ks.every(k => Object.hasOwn(o,k));
const ids = a => Array.isArray(a) && a.length > 0 && a.length <= 64 && a.every(id) && new Set(a).size === a.length && a.every((v,i) => !i || a[i-1] < v);
const hex = b => Array.from(b, x => x.toString(16).padStart(2,'0')).join('');
const signature = s => typeof s === 'string' && /^[0-9a-f]{128}$/.test(s) ? Uint8Array.from(s.match(/../g), x => parseInt(x,16)) : null;
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k,canonical(v[k])])) : v;
const domain = (purpose, value) => enc.encode(JSON.stringify(['creative-cooking/authority-candidate/v1',purpose,canonical(value)]));
const policy = (p,n) => keys(p,['kind','fixedCount']) && (p.kind === 'fixed' ? Number.isSafeInteger(p.fixedCount) && p.fixedCount >= 1 && p.fixedCount <= n : ['allMinusOne','unanimous'].includes(p.kind) && p.fixedCount === null);
const threshold = (p,n) => p.kind === 'fixed' ? p.fixedCount : p.kind === 'unanimous' ? n : Math.max(1,n-1);
const deny = reason => ({status:'deny',reason});
const pending = reason => ({status:'pending',reason});
const validRuntime = (r,devices) => {
 if (!keys(r,['documentId','authorPeers','acceptedRecipients']) || !id(r.documentId) || !r.authorPeers || typeof r.authorPeers!=='object' || Array.isArray(r.authorPeers) || !Array.isArray(r.acceptedRecipients)) return false;
 const active=devices.filter(d=>d.active).map(d=>d.deviceId).sort(), peers=Object.keys(r.authorPeers).sort();
 if (JSON.stringify(active)!==JSON.stringify(peers) || !active.length || active.length>128) return false;
 const values=Object.values(r.authorPeers), validPeer=p=>typeof p==='string' && p.length<=20 && /^(0|[1-9][0-9]*)$/.test(p) && BigInt(p)<=18446744073709551615n;
 return values.every(validPeer) && new Set(values).size===values.length && r.acceptedRecipients.every(x=>active.includes(x)) && new Set(r.acceptedRecipients).size===r.acceptedRecipients.length && r.acceptedRecipients.every((v,i)=>!i || r.acceptedRecipients[i-1]<v);
};
export const validParent = parent => !(!keys(parent,['householdId','head','policyHash','generation','epochId','roster','devices','policy','runtime']) || ![parent.householdId,parent.head,parent.policyHash,parent.epochId].every(id) || !Number.isSafeInteger(parent.generation) || parent.generation < 0 || !ids(parent.roster) || !policy(parent.policy,parent.roster.length) || !Array.isArray(parent.devices) || parent.devices.length > 128 || !parent.devices.every(d=>keys(d,['deviceId','adultId','signingKeyRef','active']) && id(d.deviceId) && id(d.signingKeyRef) && parent.roster.includes(d.adultId) && typeof d.active === 'boolean') || new Set(parent.devices.map(d=>d.deviceId)).size !== parent.devices.length || !validRuntime(parent.runtime,parent.devices));
const eventFields = ['version','suiteId','householdId','parentHead','policyHash','generation','epochId','proposalId','kind','authorDeviceId','frozenAdultRoster','subject','nextPolicy'];
const approvalFields = ['version','householdId','eventHash','parentHead','policyHash','generation','epochId','adultId','deviceId','signature'];
// The caller must authenticate and freeze the parent from the accepted authority record.
// provider.verify(signingKeyRef, bytes, signature) must resolve exactly the frozen public key.
export async function validateSuccessor(parent, event, authorSignature, approvals, provider) {
 try {
  parent = structuredClone(parent); event = structuredClone(event); approvals = structuredClone(approvals);
  if (!validParent(parent)) return deny('INVALID_PARENT');
  if (!keys(event,eventFields) || event.version !== 1 || event.suiteId !== 'candidate-ed25519-xchacha20-sealedbox-v1' || ![event.householdId,event.parentHead,event.policyHash,event.epochId,event.proposalId,event.authorDeviceId].every(id) || !Number.isSafeInteger(event.generation) || event.generation < 0 || !ids(event.frozenAdultRoster) || !['inviteAdult','changePolicy','pairOwnDevice'].includes(event.kind)) return deny('INVALID_INPUT');
  if (event.householdId !== parent.householdId || event.parentHead !== parent.head) return pending('PARENT_UNRESOLVED');
  if (event.policyHash !== parent.policyHash || event.generation !== parent.generation || event.epochId !== parent.epochId || JSON.stringify(event.frozenAdultRoster) !== JSON.stringify(parent.roster)) return deny('CONTEXT_MISMATCH');
  const author = parent.devices.find(d=>d.deviceId === event.authorDeviceId && d.active);
  if (!author) return deny('UNAUTHORIZED_DEVICE');
  if (event.kind === 'inviteAdult' && (!keys(event.subject,['adultId']) || !id(event.subject.adultId) || parent.roster.includes(event.subject.adultId) || event.nextPolicy !== null)) return deny('INVALID_INPUT');
  if (event.kind === 'changePolicy' && (event.subject !== null || !policy(event.nextPolicy,parent.roster.length))) return deny('INVALID_INPUT');
  if (event.kind === 'pairOwnDevice' && (!keys(event.subject,['adultId','deviceId','signingKeyRef']) || event.subject.adultId !== author.adultId || !id(event.subject.deviceId) || !id(event.subject.signingKeyRef) || parent.devices.some(d=>d.deviceId === event.subject.deviceId) || event.nextPolicy !== null)) return deny('INVALID_INPUT');
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
  if (event.kind === 'pairOwnDevice') return pending('CEREMONY_AND_POSSESSION_REQUIRED');
  const required = threshold(parent.policy,parent.roster.length);
  if (voters.size < required) return {...pending('QUORUM_REQUIRED'),eventHash,approvals:voters.size,required};
  // Invitation also needs independent admission/delegation and fresh generation evidence.
  if (event.kind === 'inviteAdult') return {...pending('ADMISSION_AND_PROJECTION_REQUIRED'),eventHash,approvals:voters.size,required};
  return {status:'validated',eventHash,approvals:voters.size,required};
 } catch { return deny('INVALID_PROOF'); }
}
export {domain};
