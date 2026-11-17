import {acceptanceBytes,hash} from './policy.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
/** Builds, but does not accept, a policy from the verified household node.
 * @param {{service:any,endpoint?:string|null,enforcement?:string}} options
 */
export async function prepareInitialPolicy({service,endpoint=null,enforcement='preference'}) {
 if(!['preference','block'].includes(enforcement))throw Error('MALFORMED');
 const {current,verified}=await service.authority(),selected=verified.nodes.get(current.activeHead);if(!selected||selected.roster.length!==1)throw Error('INITIAL_POLICY_REQUIRES_SOLE_ADULT');
 const access=[{actions:['disclose'],recipients:['on-device'],destinations:['onDevice'],contentClasses:['shared-cooking'],purposes:['cooking']}];
 if(endpoint!==null){let url;try{url=new URL(endpoint)}catch{throw Error('MALFORMED')};if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.href!==endpoint)throw Error('MALFORMED');access.push({actions:['disclose'],recipients:[endpoint],destinations:['external'],contentClasses:['shared-cooking'],purposes:['cooking']});}
 return {version:2,scope:{kind:'shared',id:selected.householdId},checkpoint:current.activeHead,predecessor:null,activation:{kind:'prospective',after:current.activeHead},controller:{kind:'household',ids:[...selected.roster]},requirements:{kind:'quorum',electorate:[...selected.roster],threshold:1},access,rules:[{id:'prefer-on-device',recipient:'on-device',purposes:['cooking'],contentClasses:['shared-cooking'],destinations:['onDevice'],enforcement}]};
}
/** UI must invoke only after the adult explicitly accepts the displayed policy. */
export async function acceptInitialPolicy({service,provider,deviceId,policy,explicit}) {
 if(explicit!==true)throw Error('EXPLICIT_ACCEPTANCE_REQUIRED');policy=structuredClone(policy);const {current,verified,resolved}=await service.authority(),node=verified.nodes.get(current.activeHead),device=node?.devices.find(d=>d.active&&d.deviceId===deviceId);if(!device||node.roster.length!==1||device.adultId!==node.roster[0]||policy.checkpoint!==current.activeHead)throw Error('INVALID_AUTHORITY');
 const policyHash=await hash(provider,'policy',policy),unsigned={version:2,policyHash,scope:policy.scope,checkpoint:policy.checkpoint,adultId:device.adultId,deviceId},signature=await provider.sign(resolved.signingKeyRefs[deviceId],acceptanceBytes(unsigned));if(!(signature instanceof Uint8Array)||signature.length!==64)throw Error('INVALID_PROOF');return service.publish(policy,[{...unsigned,signature:hex(signature)}]);
}
