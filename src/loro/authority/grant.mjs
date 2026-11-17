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

// All adults explicitly accept this narrowly scoped delegation at the named
// parent. It is evidence only after it has been retained in verified authority.
export async function checkAdmissionAgreement(parent,agreement,provider) {
 try {
  parent=structuredClone(parent); agreement=structuredClone(agreement);
  const af=['version','householdId','parentHead','policyHash','roster','delegation','sourcePolicyHashes','acceptances'];
  if(!validParent(parent) || !exact(agreement,af) || agreement.version!==1 || agreement.householdId!==parent.householdId || agreement.parentHead!==parent.head || agreement.policyHash!==parent.policyHash || !list(agreement.roster,64) || JSON.stringify(agreement.roster)!==JSON.stringify(parent.roster) || agreement.delegation!=='currentCooking' || !list(agreement.sourcePolicyHashes,64) || JSON.stringify(agreement.sourcePolicyHashes)!==JSON.stringify([parent.policyHash]) || !Array.isArray(agreement.acceptances) || agreement.acceptances.length!==parent.roster.length || !Array.from({length:agreement.acceptances.length},(_,i)=>Object.hasOwn(agreement.acceptances,i)).every(Boolean)) return {status:'deny',reason:'INVALID_INPUT'};
  const unsigned=Object.fromEntries(af.slice(0,-1).map(k=>[k,agreement[k]])), voters=new Set();
  for(const a of agreement.acceptances) {
   if(!exact(a,['adultId','deviceId','signature']) || voters.has(a.adultId)) return {status:'deny',reason:'INVALID_PROOF'};
   const d=parent.devices.find(d=>d.active && d.adultId===a.adultId && d.deviceId===a.deviceId), s=sig(a.signature);
   if(!d || !s || !await provider.verify(d.signingKeyRef,domain('admission-agreement-acceptance',{agreement:unsigned,adultId:a.adultId,deviceId:a.deviceId}),s)) return {status:'deny',reason:'INVALID_PROOF'};
   voters.add(a.adultId);
  }
  if(voters.size!==parent.roster.length) return {status:'deny',reason:'INVALID_PROOF'};
  const digest=await provider.hash(domain('admission-agreement',unsigned));
  if(!(digest instanceof Uint8Array) || digest.length!==32) return {status:'deny',reason:'INVALID_PROOF'};
  return {status:'accepted',delegationHash:hex(digest)};
 } catch {return {status:'deny',reason:'INVALID_PROOF'}}
}

/** Check the signed manifest association; source authorization and projection semantics remain separate. */
export async function checkGrantManifest(parent,grant,manifest,snapshot,provider) {
 try {
  parent=structuredClone(parent); grant=structuredClone(grant); manifest=structuredClone(manifest);
  if(!validParent(parent) || !exact(manifest,['version','sourceDocument','sourceCheckpointHash','sourcePolicyHashes','projectedStateHash','newDocumentId','newGeneration','schemaVersion']) || manifest.version!==1 || ![manifest.sourceDocument,manifest.sourceCheckpointHash,manifest.projectedStateHash,manifest.newDocumentId,manifest.schemaVersion].every(id) || !list(manifest.sourcePolicyHashes,64) || !(snapshot instanceof Uint8Array) || !snapshot.length || snapshot.length>8*1024*1024 || manifest.sourceDocument!==parent.runtime.documentId || manifest.newDocumentId===parent.runtime.documentId || manifest.newGeneration!==grant.newDocumentGeneration || JSON.stringify(manifest.sourcePolicyHashes)!==JSON.stringify(grant.sourcePolicyHashes)) return {status:'deny',reason:'INVALID_MANIFEST'};
  const snapshotDigest=await provider.hash(domain('projection-snapshot',hex(snapshot)));
  const manifestDigest=await provider.hash(domain('projection-manifest',manifest));
  if(!(snapshotDigest instanceof Uint8Array) || snapshotDigest.length!==32 || !(manifestDigest instanceof Uint8Array) || manifestDigest.length!==32 || hex(snapshotDigest)!==manifest.projectedStateHash || hex(manifestDigest)!==grant.projectionManifestHash) return {status:'deny',reason:'INVALID_MANIFEST'};
  return {status:'pending',reason:'SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED'};
 } catch { return {status:'deny',reason:'INVALID_MANIFEST'} }
}
