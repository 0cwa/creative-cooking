// Cryptographic proof checking only. This does not establish accepted delegation,
// source disclosure, recipient possession, or authority to publish a projection.
import {domain, validParent} from './validator.mjs';
const fields=['version','householdId','parentHead','admissionEventHash','sourcePolicyHashes','delegationHash','recipientAdult','recipientDevices','contentClasses','projectionManifestHash','newDocumentGeneration','newEpochId','keyEnvelopeRefs','signatures'];
const exact=(x,ks)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===ks.length && ks.every(k=>Object.hasOwn(x,k));
const id=x=>typeof x==='string' && x.length>0 && new TextEncoder().encode(x).length<=256;
const list=(a,max=128)=>Array.isArray(a) && a.length>0 && a.length<=max && Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean) && a.every(id) && a.every((v,i)=>!i || a[i-1]<v);
const sig=s=>typeof s==='string' && /^[0-9a-f]{128}$/.test(s) ? Uint8Array.from(s.match(/../g),x=>parseInt(x,16)) : null;
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const threshold=(p,n)=>p.kind==='fixed'?p.fixedCount:p.kind==='unanimous'?n:Math.max(1,n-1);
/** The caller must independently authenticate parent and resolve every additional admission proof. */
export async function checkGrantSignatures(parent,grant,provider) {
 try {
  parent=structuredClone(parent); grant=structuredClone(grant);
  if(!validParent(parent) || !exact(grant,fields) || grant.version!==1 || ![grant.householdId,grant.parentHead,grant.admissionEventHash,grant.delegationHash,grant.recipientAdult,grant.projectionManifestHash,grant.newEpochId].every(id) || !list(grant.sourcePolicyHashes,64) || !list(grant.recipientDevices) || !list(grant.contentClasses,3) || !grant.contentClasses.every(c=>['recipe','pantry','shopping'].includes(c)) || !list(grant.keyEnvelopeRefs) || !Number.isSafeInteger(grant.newDocumentGeneration) || grant.newDocumentGeneration<=parent.generation || grant.newEpochId===parent.epochId || grant.householdId!==parent.householdId || grant.parentHead!==parent.head || parent.roster.includes(grant.recipientAdult) || !Array.isArray(grant.signatures) || !grant.signatures.length || grant.signatures.length>128 || !Array.from({length:grant.signatures.length},(_,i)=>Object.hasOwn(grant.signatures,i)).every(Boolean)) return {status:'deny',reason:'INVALID_INPUT'};
  const unsigned=Object.fromEntries(fields.slice(0,-1).map(k=>[k,grant[k]]));
  const digest=await provider.hash(domain('current-state-grant',unsigned));
  if(!(digest instanceof Uint8Array) || digest.length!==32) return {status:'deny',reason:'INVALID_PROOF'};
  const voters=new Set(), devices=new Set();
  for(const proof of grant.signatures) {
   if(!exact(proof,['adultId','deviceId','signature']) || !id(proof.adultId) || !id(proof.deviceId) || devices.has(proof.deviceId)) return {status:'deny',reason:'INVALID_PROOF'};
   const device=parent.devices.find(d=>d.active && d.deviceId===proof.deviceId && d.adultId===proof.adultId), signature=sig(proof.signature);
   if(!device || !signature || !await provider.verify(device.signingKeyRef,domain('current-state-grant-signature',{grant:unsigned,adultId:proof.adultId,deviceId:proof.deviceId}),signature)) return {status:'deny',reason:'INVALID_PROOF'};
   devices.add(proof.deviceId); voters.add(proof.adultId);
  }
  const required=threshold(parent.policy,parent.roster.length);
  if(voters.size<required) return {status:'pending',reason:'QUORUM_REQUIRED',approvals:voters.size,required};
  return {status:'pending',reason:'ADMISSION_EVIDENCE_REQUIRED',grantHash:hex(digest),approvals:voters.size,required};
 } catch { return {status:'deny',reason:'INVALID_PROOF'}; }
}
