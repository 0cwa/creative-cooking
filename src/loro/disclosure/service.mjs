import {readAuthority,verifyAuthority,resolveInstalledSetAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {validatePolicyAcceptance,hash} from './policy.mjs';
const MAX_POLICY_HISTORY=64;
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
/** Authority is always reconstructed from the pinned chain; policy input cannot
 * choose its electorate, key resolver or selected authority head. */
export function disclosureService({storage,scope,rootPin,provider,deviceId,installedSet=null}) {
 if(scope?.kind!=='household'||!scope.id||!rootPin||!deviceId)throw Error('INVALID_AUTHORITY');
 async function authority() {
  const resolved=installedSet
   ? await resolveInstalledSetAuthority({storage,scope,pin:rootPin,provider,authorDevice:deviceId,
     operationId:installedSet.operationId,sodium:installedSet.sodium,LoroDoc:installedSet.LoroDoc,paired:installedSet.paired})
   : await resolveRuntimeAuthority(storage,scope,rootPin,provider,deviceId);
  const paired=resolved.pairedAuthority;
  const current=paired?{revision:paired.record.revision,activeHead:paired.state.activeHead,state:paired.state}:await readAuthority(storage,scope,rootPin,provider);
  const verified=paired?paired.verified:await verifyAuthority(current.state,rootPin,provider);
  if(current.activeHead!==resolved.scope.branchHead||current.revision!==resolved.expectedAuthority.record.revision)throw Error('CONFLICT');
  return {current,verified,resolved};
 }
 async function validateStored(policyHash,context,seen=new Set()) {
  if(seen.has(policyHash)||seen.size>=MAX_POLICY_HISTORY)throw Error('INVALID_PREDECESSOR');seen.add(policyHash);
  const saved=must(await storage.readDisclosurePolicy(scope.id,policyHash))??(typeof storage.readArchivedDisclosurePolicy==='function'?must(await storage.readArchivedDisclosurePolicy(scope.id,policyHash)):null);if(!saved||saved.policyHash!==policyHash||await hash(provider,'policy',saved.policy)!==policyHash)throw Error('POLICY_UNRESOLVED');
  const previous=saved.policy.predecessor?await validateStored(saved.policy.predecessor,context,seen):null;
  const parents=new Map();for(const item of context.current.state.events){const digest=await provider.hash(domain('event',item.event));if(!(digest instanceof Uint8Array)||digest.length!==32)throw Error('INVALID_PROOF');parents.set(Array.from(digest,x=>x.toString(16).padStart(2,'0')).join(''),item.event.parentHead)}let head=context.current.activeHead;const ancestors=new Set();while(head&&!ancestors.has(head)){ancestors.add(head);head=parents.get(head)}
  const selected=context.verified.nodes.get(saved.policy.checkpoint);if(!selected||!ancestors.has(saved.policy.checkpoint))throw Error('POLICY_UNRESOLVED');if(previous){let parentHead=saved.policy.checkpoint,found=false;const seenHeads=new Set();while(parentHead&&!seenHeads.has(parentHead)){if(parentHead===previous.policy.checkpoint){found=true;break}seenHeads.add(parentHead);parentHead=parents.get(parentHead)}if(!found)throw Error('POLICY_UNRESOLVED')}
  await validatePolicyAcceptance({policy:saved.policy,approvals:saved.approvals,previous:previous?.policy??null,authority:{scopeId:scope.id,head:saved.policy.checkpoint,selected},provider});return saved;
 }
 async function active() {const context=await authority(),id=must(await storage.readDisclosureActive(scope.id));if(!id||!must(await storage.readDisclosurePolicy(scope.id,id)))throw Error('POLICY_UNRESOLVED');const record=await validateStored(id,context);if(record.policy.checkpoint!==context.current.activeHead)throw Error('POLICY_UNRESOLVED');return {context,record};}
 async function publish(policy,approvals) {const history=new Set(),context=await authority(),old=must(await storage.readDisclosureActive(scope.id)),previous=old?await validateStored(old,context,history):null,selected=context.verified.nodes.get(context.current.activeHead);const candidateHash=await hash(provider,'policy',policy);if(old===candidateHash){if(JSON.stringify(previous.policy)!==JSON.stringify(policy)||JSON.stringify(previous.approvals)!==JSON.stringify(approvals))throw Error('CONFLICT');return {...previous,replayed:true}}if(history.size>=MAX_POLICY_HISTORY)throw Error('INVALID_PREDECESSOR');const record=await validatePolicyAcceptance({policy,approvals,previous:previous?.policy??null,authority:{scopeId:scope.id,head:context.current.activeHead,selected},provider});if(policy.predecessor!==old)throw Error('CONFLICT');must(await storage.publishDisclosurePolicy({expectedAuthority:context.resolved.expectedAuthority,expectedPolicyHash:old,record}));return record;}
 async function historicalSigningRefs(head) {const {verified}=await authority(),node=verified.nodes.get(head);if(!node)throw Error('INVALID_AUTHORITY');return Object.fromEntries(node.devices.filter(d=>d.active).map(d=>[d.deviceId,d.signingKeyRef]));}
 return {authority,active,publish,validateStored,historicalSigningRefs};
}
