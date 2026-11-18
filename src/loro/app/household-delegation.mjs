import {readAuthority,verifyAuthority,acceptAdmissionAgreementWithOutcome} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
/** One adult explicitly signs the current-cooking delegation; all adult
 * acceptances are required before the agreement can be retained. */
export async function prepareHouseholdDelegation({storage,scope,pin,provider,adultId,deviceId,explicit}){
 if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');const sc=structuredClone(scope),current=await readAuthority(storage,sc,pin,provider),verified=await verifyAuthority(current.state,pin,provider),parent=verified.nodes.get(current.activeHead),author=parent?.devices.find(d=>d.active&&d.deviceId===deviceId&&d.adultId===adultId);if(!author)throw Error('INVALID_AUTHORITY');
 const agreement={version:1,householdId:sc.id,parentHead:parent.head,policyHash:parent.policyHash,roster:[...parent.roster],delegation:'currentCooking',sourcePolicyHashes:[parent.policyHash]},body={agreement,adultId,deviceId},signature=hex(await provider.sign(author.signingKeyRef,domain('admission-agreement-acceptance',body)));return {version:1,agreement,acceptance:{adultId,deviceId,signature},requiredAdults:[...parent.roster]};
}
/** The authority verifier checks every distinct adult and the selected parent. */
export async function acceptHouseholdDelegation({storage,scope,pin,provider,agreement,explicit}){
 if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
 const sc=structuredClone(scope),input=structuredClone(agreement);
 const ordered=entries=>[...entries].sort((a,b)=>a?.adultId<b?.adultId?-1:a?.adultId>b?.adultId?1:0);
 if(!Array.isArray(input?.acceptances)||input.acceptances.length>64)throw Error('INVALID_INPUT');
 input.acceptances=ordered(input.acceptances);
 // New agreements use the same byte order on each device. An exact retry of
 // an older agreement must still use the order already retained on this device.
 const {state}=await readAuthority(storage,sc,pin,provider);
 const normalized=hex(domain('admission-agreement',input));
 const retained=state.agreements?.find(entry=>entry.parentHead===input.parentHead&&normalized===hex(domain('admission-agreement',{...entry,acceptances:ordered(entry.acceptances)})));
 return acceptAdmissionAgreementWithOutcome(storage,sc,pin,provider,retained??input);
}
