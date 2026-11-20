// Narrow household disclosure-policy v2 candidate. Existing authority roots
// contain no disclosure acceptance; this module never infers one.
const enc=new TextEncoder();
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const bytes=x=>enc.encode(JSON.stringify(canonical(x)));
const domain=(kind,value)=>bytes(['creative-cooking/disclosure-v2',kind,value]);
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const id=x=>typeof x==='string'&&x.length>0&&enc.encode(x).length<=256;
const exact=(o,ks)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===ks.length&&ks.every(k=>Object.hasOwn(o,k));
const sorted=a=>Array.isArray(a)&&a.length>0&&a.length<=128&&a.every((x,i)=>Object.hasOwn(a,i)&&id(x)&&(!i||a[i-1]<x));
const sig=s=>typeof s==='string'&&/^[0-9a-f]{128}$/.test(s)?Uint8Array.from(s.match(/../g),x=>parseInt(x,16)):null;
export const hash=async(provider,kind,value)=>{const h=await provider.hash(domain(kind,value));if(!(h instanceof Uint8Array)||h.length!==32)throw Error('INVALID_PROOF');return hex(h)};
const threshold=(policy,n)=>policy.kind==='unanimous'?n:policy.kind==='fixed'?policy.fixedCount:Math.max(1,n-1);
export function validatePolicy(p) {
 if(!exact(p,['version','scope','checkpoint','predecessor','activation','controller','requirements','access','rules'])||p.version!==2||!exact(p.scope,['kind','id'])||p.scope.kind!=='shared'||!id(p.scope.id)||!id(p.checkpoint)||(p.predecessor!==null&&!id(p.predecessor))||!exact(p.activation,['kind','after'])||p.activation.kind!=='prospective'||p.activation.after!==p.checkpoint||!exact(p.controller,['kind','ids'])||p.controller.kind!=='household'||!sorted(p.controller.ids)||!exact(p.requirements,['kind','electorate','threshold'])||p.requirements.kind!=='quorum'||!sorted(p.requirements.electorate)||JSON.stringify(p.controller.ids)!==JSON.stringify(p.requirements.electorate)||!Number.isSafeInteger(p.requirements.threshold)||p.requirements.threshold<1||p.requirements.threshold>p.requirements.electorate.length||!Array.isArray(p.access)||!p.access.length||p.access.length>64||!Array.isArray(p.rules)||!p.rules.length||p.rules.length>64)throw Error('MALFORMED');
 for(const a of p.access)if(!exact(a,['actions','recipients','destinations','contentClasses','purposes'])||!sorted(a.actions)||!sorted(a.recipients)||!sorted(a.destinations)||!sorted(a.contentClasses)||!sorted(a.purposes)||a.actions.some(x=>x!=='disclose')||a.contentClasses.some(x=>x!=='shared-cooking')||a.destinations.some(x=>!['onDevice','external','networkLocal'].includes(x)))throw Error('MALFORMED');
 const ids=new Set();for(const r of p.rules){if(!exact(r,['id','recipient','purposes','contentClasses','destinations','enforcement'])||!id(r.id)||ids.has(r.id)||!id(r.recipient)||!sorted(r.purposes)||!sorted(r.contentClasses)||!sorted(r.destinations)||!['preference','block'].includes(r.enforcement))throw Error('MALFORMED');ids.add(r.id)}
 if(bytes(p).length>131072)throw Error('TOO_LARGE');
 return structuredClone(p);
}
/** `authority` must be obtained by replaying the pinned household chain, never
 * constructed from the policy or its signers. `selected` is the verified node. */
export async function validatePolicyAcceptance({policy,approvals,previous,authority,provider}) {
 policy=validatePolicy(policy);approvals=structuredClone(approvals);
 const {scopeId,head,selected}=authority??{};
 if(!selected||scopeId!==policy.scope.id||head!==policy.checkpoint||selected.head!==head||selected.householdId!==scopeId||JSON.stringify(selected.roster)!==JSON.stringify(policy.controller.ids))throw Error('INVALID_AUTHORITY');
 const expected=threshold(selected.policy,selected.roster.length);
 if(policy.requirements.threshold!==expected)throw Error('INVALID_AUTHORITY');
 if(previous===null){if(policy.predecessor!==null||selected.roster.length!==1)throw Error('INITIAL_POLICY_REQUIRES_SOLE_ADULT');}
 else {previous=validatePolicy(previous);if(policy.predecessor!==await hash(provider,'policy',previous)||previous.scope.id!==scopeId)throw Error('INVALID_PREDECESSOR');}
 if(!Array.isArray(approvals)||approvals.length>128)throw Error('MALFORMED');
 const policyHash=await hash(provider,'policy',policy),priorElectorate=previous?.requirements.electorate??selected.roster,priorRequired=previous?.requirements.threshold??1,voters=new Set();
 for(const a of approvals){if(!exact(a,['version','policyHash','scope','checkpoint','adultId','deviceId','signature'])||a.version!==2||a.policyHash!==policyHash||!exact(a.scope,['kind','id'])||a.scope.kind!=='shared'||a.scope.id!==scopeId||a.checkpoint!==head||!id(a.adultId)||!id(a.deviceId))throw Error('MALFORMED');const device=selected.devices.find(d=>d.active&&d.deviceId===a.deviceId&&d.adultId===a.adultId);const signature=sig(a.signature);if(!device||!selected.roster.includes(a.adultId)||!signature||voters.has(a.adultId)||!await provider.verify(device.signingKeyRef,domain('acceptance',{version:2,policyHash,scope:a.scope,checkpoint:head,adultId:a.adultId,deviceId:a.deviceId}),signature))throw Error('INVALID_PROOF');voters.add(a.adultId)}
 if([...voters].filter(x=>priorElectorate.includes(x)).length<priorRequired||[...voters].filter(x=>selected.roster.includes(x)).length<expected)throw Error('QUORUM_REQUIRED');return {policy,policyHash,approvals};
}
export const acceptanceBytes=(a)=>domain('acceptance',a);
export const reviewBytes=(r)=>domain('review',r);
export const seedManifestBytes=(r)=>domain('seed-manifest',r);
