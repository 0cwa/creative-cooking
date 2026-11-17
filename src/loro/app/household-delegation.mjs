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
 return acceptAdmissionAgreementWithOutcome(storage,structuredClone(scope),pin,provider,structuredClone(agreement));
}
