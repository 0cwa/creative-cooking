import {validate as validateCommand,validateOperations,checkPreconditions} from '../domain/registry.mjs';
import {policyBaseline,policyBranchAncestors,verifyPolicyBaseline} from '../authority/policy-baseline.mjs';
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
/** Reverify retained signed envelopes and recursively reconstruct source policy ancestry. */
export function createSourceVerifier({runtime,service,context,allowIncomplete=false}) {
 const verified=new Map(),visiting=new Set(),baselines=new Map();let replayChecked=null;
 const scope=runtime.scope;
 const ancestors=context.verified?.nodes ? policyBranchAncestors(context.verified,scope.branchHead) : [];
 async function authenticateSeed(effect) {
   if(ancestors.length<2)return false;
   const {doc}=await runtime.document();
   return doc.getMap('domain-effects').get(effect)?.version===3;
 }
 async function authenticateUnknown(effect){if(!allowIncomplete)throw Error('SOURCE_PROVENANCE_REQUIRED');if(!replayChecked){const {doc}=await runtime.document(),{replayAuthenticated}=await import('../domain/replay.mjs'),result=await replayAuthenticated({runtime,checkpoint:doc.export({mode:'snapshot'})}),visible=d=>Object.fromEntries(Object.entries(d.toJSON()).filter(([,v])=>v&&typeof v==='object'&&Object.keys(v).length));if(result.held.length||!equal(canonical(visible(result.doc)),canonical(visible(doc))))throw Error('INSUFFICIENT_EVIDENCE');replayChecked=result}const {doc}=await runtime.document();if(!doc.getMap('domain-effects').get(effect))throw Error('SOURCE_PROVENANCE_REQUIRED');const policies=new Set(),command=replayChecked.applied.find(x=>x.command.effectId===effect)?.command;if(command)for(const dependency of command.dependencyEffectIds){const parent=await verifySource(dependency);for(const policy of parent.policies)policies.add(policy)}return {policies:[...policies].sort(),incomplete:true};}

 async function verifySource(effect) {
   if(verified.has(effect))return verified.get(effect);if(visiting.has(effect)||visiting.size+verified.size>=256)throw Error('SOURCE_PROVENANCE_REQUIRED');visiting.add(effect);
   let source=must(await runtime.storage.readDisclosureSource(scope.scopeId,effect)),legacy=false;
   if(!source&&allowIncomplete&&ancestors.length>1){
    source=must(await runtime.storage.readLegacyCookingSource(context.resolved.expectedAuthority,effect));
    legacy=!!source;
   }
   if(!source){
    let seed;
    try{const {verifiedSeedSources}=await import('./seed-source.mjs');seed=await verifiedSeedSources({runtime,service,context})}catch(e){if(e?.message!=='SOURCE_PROVENANCE_REQUIRED')throw e}
    const policies=seed?.entries.get(effect);
    if(policies&&!allowIncomplete)throw Error('SOURCE_MAPPING_UNVERIFIED');
    const unknown=allowIncomplete&&await authenticateSeed(effect) ? {policies:[],incomplete:true} : await authenticateUnknown(effect);
    if(policies)for(const policy of policies)await service.validateStored(policy,context);
    const result=policies ? {...unknown,policies} : unknown;
    visiting.delete(effect);verified.set(effect,result);return result;
   }
   const inherited=source.checkpoint!==scope.branchHead;
   const ancestor=inherited ? ancestors.find(node=>node.head===source.checkpoint) : null;
   const s=ancestor ? {...scope,branchHead:ancestor.head,documentId:ancestor.runtime.documentId,policyHashes:[ancestor.policyHash]} : scope;
   if((inherited&&!ancestor)||source.documentId!==s.documentId||!(source.envelope instanceof Uint8Array))throw Error('SOURCE_PROVENANCE_REQUIRED');
   const opened=await runtime.codec.openContent(source.envelope,context.resolved.signingKeyRefs),h=opened.header;
   if(opened.object.id!==source.objectId||(legacy ? h.version!==1 : ![2,3,4].includes(h.version))||h.scopeId!==s.scopeId||h.documentId!==s.documentId||h.documentGeneration!==s.documentGeneration||h.branchHead!==s.branchHead||h.epochId!==s.epochId||h.suiteId!==s.suiteId||!equal(h.policyHashes,s.policyHashes)||!s.acceptedAuthors.includes(h.authorDevice)||!equal(h.semanticEffectIds,[effect])||!legacy&&!equal(h.disclosurePolicyHashes,source.policyHashes))throw Error('INVALID_SOURCE_PROOF');
   let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(opened.value))}catch{throw Error('INVALID_SOURCE_PROOF')};const command=validateCommand(payload?.command);if(payload.version!==1||!Array.isArray(payload.update)||command.effectId!==effect||command.commandId!==source.commandId||!legacy&&!equal([...command.dependencyEffectIds].sort(),h.sourceEffectIds)||(command.data.author!==undefined&&command.data.author!==h.authorDevice))throw Error('INVALID_SOURCE_PROOF');
   if(!payload.update.every(x=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('INVALID_SOURCE_PROOF');const update=Uint8Array.from(payload.update),meta=runtime.inspectUpdate(update);if(meta.peer!==s.authorPeers[h.authorDevice]||!equal(meta.predecessors,h.predecessorRefs))throw Error('INVALID_SOURCE_PROOF');const {doc}=await runtime.document();let prior;try{prior=doc.forkAt(meta.frontiers)}catch{throw Error('SOURCE_PROVENANCE_REQUIRED')}const verifier=prior.forkAt(meta.frontiers),start=verifier.oplogVersion(),checked=verifier.import(update);if(checked.pending?.size)throw Error('SOURCE_PROVENANCE_REQUIRED');validateOperations(command,verifier.exportJsonUpdates(start,undefined,false).changes);checkPreconditions(prior,command,{importing:true});
   if(inherited){
    const provider=runtime.authority.provider;
    const {historyHash}=await policyBaseline(verifier,provider);
    for(const child of ancestors.slice(0,ancestors.indexOf(ancestor))){
     const edge=context.verified.policyParents.get(child.head);
     if(!edge)throw Error('SOURCE_PROVENANCE_REQUIRED');
     let baseline=baselines.get(child.head);
     if(!baseline){
      baseline=await verifyPolicyBaseline(doc,runtime.LoroDoc,edge.baseline,provider);
      baselines.set(child.head,baseline);
     }
     let committed;
     try{committed=baseline.forkAt(verifier.frontiers());}catch{throw Error('SOURCE_PROVENANCE_REQUIRED');}
     if((await policyBaseline(committed,provider)).historyHash!==historyHash)throw Error('INVALID_SOURCE_PROOF');
    }
   }
   const governing=legacy ? null : h.disclosurePolicyHash;
   const ancestry=new Set(governing===null?[]:[governing]);
   let incomplete=legacy||h.version===3||h.version===4&&h.disclosureIncomplete===true;
   if(governing!==null)await service.validateStored(governing,context);
   if(incomplete&&!allowIncomplete)throw Error('INCOMPLETE_PROVENANCE');
   for(const dep of command.dependencyEffectIds){
    const parent=await verifySource(dep);
    if(parent.incomplete&&!incomplete)throw Error('INVALID_SOURCE_PROOF');
    incomplete||=!!parent.incomplete;
    for(const policy of parent.policies)ancestry.add(policy);
   }
   const values=[...ancestry].sort();
   if(!legacy&&!equal(values,h.disclosurePolicyHashes))throw Error('INVALID_SOURCE_PROOF');
   for(const policy of values)await service.validateStored(policy,context);
   visiting.delete(effect);const result={command,policies:values,incomplete};verified.set(effect,result);return result;
  }
 return verifySource;
}
