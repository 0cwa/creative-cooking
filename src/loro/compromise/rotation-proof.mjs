// Candidate verification only. Publication and full-domain projection are still required.
import {validateSuccessor,domain} from '../authority/validator.mjs';
import {checkExistingRecipientCeremonies} from '../authority/ceremony.mjs';
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(y=>Object.hasOwn(x,y));
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const sig=x=>typeof x==='string'&&/^[0-9a-f]{128}$/.test(x)?Uint8Array.from(x.match(/../g),b=>parseInt(b,16)):null;
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
/** Separate grant avoids a package/event-hash cycle; parent approval never grants publication. */
export async function checkRotationEvidence({sodium,parent,authorizationSnapshot,item,grant,ceremonies,localDeviceId,provider}) {
 const result=await validateSuccessor(parent,item?.event,item?.authorSignature,item?.approvals,provider);
 if(!['ROTATION_DISTRIBUTION_REQUIRED','RECOVERY_DISTRIBUTION_REQUIRED'].includes(result.reason))throw Error(result.reason||'INVALID_TRANSITION');
 const event=item.event,subject=event.subject,fields=['version','householdId','parentHead','eventHash','newEpochId','newGeneration','documentId','manifestHash','recipients','packageRefs','contentClasses','disclosure','signatures'];
 if(!exact(grant,fields)||grant.version!==1||grant.disclosure!=='current-state-only'||!same(grant.contentClasses,['pantry','recipe','shopping'])||grant.householdId!==parent.householdId||grant.parentHead!==parent.head||grant.eventHash!==result.eventHash||grant.newEpochId!==subject.newEpochId||grant.newGeneration!==subject.newGeneration||grant.documentId!==subject.documentId||typeof grant.manifestHash!=='string'||!grant.manifestHash||!same(grant.recipients,subject.devices.map(d=>d.deviceId))||!Array.isArray(grant.packageRefs)||grant.packageRefs.length!==grant.recipients.length-1||!Array.from({length:grant.packageRefs.length},(_,i)=>Object.hasOwn(grant.packageRefs,i)).every(Boolean)||!grant.packageRefs.every(x=>typeof x==='string'&&x&&new TextEncoder().encode(x).length<=256)||new Set(grant.packageRefs).size!==grant.packageRefs.length||!Array.isArray(grant.signatures)||grant.signatures.length>128)throw Error('INVALID_GRANT');
 const unsigned=Object.fromEntries(fields.filter(x=>x!=='signatures').map(x=>[x,grant[x]])),votes=new Set(),devices=new Set();
 for(const s of grant.signatures){if(!exact(s,['adultId','deviceId','signature']))throw Error('INVALID_GRANT');const d=parent.devices.find(d=>d.active&&d.deviceId===s.deviceId&&d.adultId===s.adultId);if(!d||devices.has(d.deviceId)||!sig(s.signature)||!await provider.verify(d.signingKeyRef,domain('rotation-grant-signature',{grant:unsigned,adultId:s.adultId,deviceId:s.deviceId}),sig(s.signature)))throw Error('INVALID_GRANT');votes.add(s.adultId);devices.add(s.deviceId)}
 const threshold=parent.policy.kind==='fixed'?parent.policy.fixedCount:parent.policy.kind==='unanimous'?parent.roster.length:Math.max(1,parent.roster.length-1);if(votes.size<threshold)throw Error('QUORUM_REQUIRED');
 const local=subject.devices.find(d=>d.deviceId===localDeviceId),parentLocal=parent.devices.find(d=>d.active&&d.deviceId===localDeviceId);if(!local||!parentLocal)throw Error('INVALID_LOCAL_DEVICE');
 const verified=await checkExistingRecipientCeremonies(sodium,parent,authorizationSnapshot,{admissionEventHash:result.eventHash,newEpochId:subject.newEpochId},ceremonies,provider),expected=subject.devices.filter(d=>d.deviceId!==localDeviceId&&(event.kind!=='recoverDevice'||d.deviceId!==subject.deviceId));
 if(!same(verified.map(d=>d.deviceId),expected.map(d=>d.deviceId))||verified.some((d,i)=>d.wrappingKeyRef!==expected[i].wrappingKeyRef)||ceremonies.some(c=>c.context.sponsorDeviceId!==localDeviceId))throw Error('CEREMONY_REQUIRED');
 const grantHash=await provider.hash(domain('rotation-distribution-grant',unsigned));if(!(grantHash instanceof Uint8Array)||grantHash.length!==32)throw Error('INVALID_PROOF');
 return {status:'pending',reason:'FULL_DOMAIN_PROJECTION_AND_ATOMIC_PUBLICATION_REQUIRED',eventHash:result.eventHash,grantHash:hex(grantHash),devices:verified,localDeviceId};
}
