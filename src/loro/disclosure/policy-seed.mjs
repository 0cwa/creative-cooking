// Scratch v2 source-side building block. The publication grant must bind the
// returned digest and recipient installation must independently verify it.
import {projectCurrentSeed,verifyCurrentSeed} from '../compromise/current-seed.mjs';
import {createSourceVerifier} from './source-proof.mjs';
import {hash,validatePolicyAcceptance} from './policy.mjs';
import {verifyAuthority} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {recipeDocumentId} from '../domain/recipe-document.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''),cmp=(a,b)=>a<b?-1:a>b?1:0;
export async function preparePolicyProjection({runtime,service,provider,seedId,peerId,version=2,selectedSource,omittedRecipeIds,childRecipeIngredients}){
 if(![2,3,4].includes(version))throw Error('UNSUPPORTED_VERSION');const {context}=version===2?await service.active():{context:await service.authority()},{doc,revision,storedBytes}=await runtime.document();if(revision===null)throw Error('SOURCE_UNAVAILABLE');
 if(selectedSource && (version!==4 || selectedSource.revision!==revision || selectedSource.bytes.length!==storedBytes?.length ||
   !selectedSource.bytes.every((byte,index)=>byte===storedBytes[index])))throw Error('SOURCE_CHANGED');
 let selectedSeedEffects=null;
 if(selectedSource?.admitted){
  const {verifiedSeedSources}=await import('./seed-source.mjs');
  const {policyBaseline,verifyPolicyBaseline}=await import('../authority/policy-baseline.mjs');
  const retained=await verifiedSeedSources({runtime,service,context});
  await verifyPolicyBaseline(doc,runtime.LoroDoc,await policyBaseline(retained.seedDoc,provider),provider);
  selectedSeedEffects=new Map();
  for(const [effectId,policies] of retained.entries){
   const marker=retained.seedDoc.getMap('domain-effects').get(effectId);
   if(marker?.version!==3||!equal(Array.from(domain('seed-marker',marker)),
    Array.from(domain('seed-marker',doc.getMap('domain-effects').get(effectId)))))throw Error('INVALID_SEED_PROOF');
   selectedSeedEffects.set(effectId,{seedId:marker.seedId,policies,incomplete:true,sourceDependencies:[]});
  }
 }
 const projected=projectCurrentSeed({LoroDoc:runtime.LoroDoc,source:selectedSource?.bytes??doc.export({mode:'snapshot'}),seedId,peerId,includeLocalMapping:true,schemaVersion:version===4?4:1,omittedRecipeIds,childRecipeIngredients}),verify=createSourceVerifier({runtime,service,context,allowIncomplete:version>=3,selectedDocument:selectedSource&&runtime.recipeId!==null?doc:null,selectedSeedEffects}),policies=new Map(),entries=[];
 for(const mapping of projected.localMapping){const proof=await verify(mapping.oldEffectId);entries.push({effectId:mapping.effectId,policyHashes:[...proof.policies],...(version>=3?{incomplete:!!proof.incomplete}:{})});for(const id of proof.policies){let record=await service.validateStored(id,context);while(record){if(policies.has(record.policyHash))break;policies.set(record.policyHash,record);record=record.policy.predecessor?await service.validateStored(record.policy.predecessor,context):null}}}
 entries.sort((a,b)=>cmp(a.effectId,b.effectId));const {localMapping,...seed}=projected;const bundle={version,scopeId:runtime.scope.scopeId,sourceHead:runtime.scope.branchHead,sourceDocumentId:runtime.scope.documentId,sourceRevision:revision,seedId,peerId,snapshotHash:await hash(provider,'seed-snapshot',Array.from(seed.snapshot)),entries,policies:[...policies.values()].sort((a,b)=>cmp(a.policyHash,b.policyHash))};return {seed,bundle,bundleHash:await hash(provider,'projection-policy-bundle',bundle)};
}
/** Validates signed acceptance artifacts against the independently pinned parent
 * authority. Grant/manifest binding and atomic installation are still separate. */
export async function verifyPolicyProjection({provider,pin,state,seed,bundle,expectedBundleHash,expectedSourceHead,expectedSourceDocument,expectedSourceRevision,LoroDoc,selectedRecipeId,allowEmpty=false}){
 seed=structuredClone(seed);bundle=structuredClone(bundle);state=structuredClone(state);if(!bundle||Object.keys(bundle).sort().join(',')!=='entries,peerId,policies,scopeId,seedId,snapshotHash,sourceDocumentId,sourceHead,sourceRevision,version'||![2,3,4].includes(bundle.version)||bundle.sourceHead!==expectedSourceHead||bundle.sourceDocumentId!==expectedSourceDocument||bundle.sourceRevision!==expectedSourceRevision||!Number.isSafeInteger(bundle.sourceRevision)||bundle.sourceRevision<0||!Array.isArray(bundle.entries)||bundle.entries.length>256||!Array.isArray(bundle.policies)||bundle.policies.length>64||await hash(provider,'projection-policy-bundle',bundle)!==expectedBundleHash)throw Error('INVALID_PROOF');
 const authority=await verifyAuthority(state,pin,provider),parent=authority.nodes.get(bundle.sourceHead);if(!parent||parent.householdId!==bundle.scopeId)throw Error('INVALID_AUTHORITY');
 const sourceDocument=selectedRecipeId===undefined?parent.runtime.documentId:await recipeDocumentId({
   scopeId:parent.householdId,branchHead:parent.head,documentId:parent.runtime.documentId,
   documentGeneration:parent.generation,epochId:parent.epochId,
 },pin,provider,selectedRecipeId);
 if(sourceDocument!==bundle.sourceDocumentId)throw Error('INVALID_AUTHORITY');
 const parents=new Map();for(const item of state.events){const digest=await provider.hash(domain('event',item.event));if(!(digest instanceof Uint8Array)||digest.length!==32)throw Error('INVALID_PROOF');parents.set(hex(digest),item.event.parentHead)}const ancestors=new Set();for(let h=bundle.sourceHead;h&&!ancestors.has(h);h=parents.get(h))ancestors.add(h);
 if(!seed||seed.version!==1||seed.seedId!==bundle.seedId||seed.peerId!==bundle.peerId||await hash(provider,'seed-snapshot',Array.from(seed.snapshot))!==bundle.snapshotHash)throw Error('INVALID_SEED');const checkedSeed=verifyCurrentSeed({LoroDoc,snapshot:seed.snapshot,seed,schemaVersion:bundle.version===4?4:1});if((!allowEmpty||checkedSeed.peers.length!==0)&&(checkedSeed.peers.length!==1||checkedSeed.peers[0]!==seed.peerId))throw Error('INVALID_SEED');const ids=seed.identities.map(x=>x.effectId).sort(cmp),actual=bundle.entries.map(x=>x.effectId);if(!equal(ids,actual)||new Set(actual).size!==actual.length)throw Error('INVALID_SEED');
 const records=new Map();for(const record of bundle.policies){if(!record||Object.keys(record).sort().join(',')!=='approvals,policy,policyHash'||records.has(record.policyHash)||await hash(provider,'policy',record.policy)!==record.policyHash||!ancestors.has(record.policy.checkpoint))throw Error('INVALID_PROOF');records.set(record.policyHash,record)}if(!equal([...records.keys()],[...records.keys()].sort(cmp)))throw Error('INVALID_PROOF');
 const accepted=new Set(),visiting=new Set();async function verifyPolicy(id){if(accepted.has(id))return;if(visiting.has(id)||visiting.size>=64)throw Error('INVALID_PREDECESSOR');const record=records.get(id);if(!record)throw Error('POLICY_UNRESOLVED');visiting.add(id);const previous=record.policy.predecessor?records.get(record.policy.predecessor):null;if(record.policy.predecessor){if(!previous)throw Error('POLICY_UNRESOLVED');await verifyPolicy(record.policy.predecessor);let h=record.policy.checkpoint,found=false,seen=new Set();while(h&&!seen.has(h)){if(h===previous.policy.checkpoint){found=true;break}seen.add(h);h=parents.get(h)}if(!found)throw Error('INVALID_PREDECESSOR')}await validatePolicyAcceptance({policy:record.policy,approvals:record.approvals,previous:previous?.policy??null,authority:{scopeId:bundle.scopeId,head:record.policy.checkpoint,selected:authority.nodes.get(record.policy.checkpoint)},provider});visiting.delete(id);accepted.add(id)}
 for(const entry of bundle.entries){if(!entry||Object.keys(entry).sort().join(',')!==(bundle.version>=3?'effectId,incomplete,policyHashes':'effectId,policyHashes')||(bundle.version>=3&&typeof entry.incomplete!=='boolean')||!Array.isArray(entry.policyHashes)||(!entry.policyHashes.length&&(bundle.version<3||!entry.incomplete))||entry.policyHashes.length>64||entry.policyHashes.some((x,i)=>typeof x!=='string'||!x||(i>0&&entry.policyHashes[i-1]>=x)))throw Error('INVALID_PROOF');for(const id of entry.policyHashes)await verifyPolicy(id)}if(accepted.size!==records.size)throw Error('INVALID_PROOF');return {seedId:seed.seedId,entries:structuredClone(bundle.entries)};
}

/** Producer-side validation derives the exact mapping again from the authenticated
 * live source; publication must CAS the returned document revision. */
export async function verifySourcePolicyProjection({runtime,service,provider,seed,bundle,bundleHash}) {
 const generated=await preparePolicyProjection({runtime,service,provider,seedId:seed.seedId,peerId:seed.peerId,version:bundle.version});if(generated.bundleHash!==bundleHash||!equal(generated.bundle,bundle)||!equal(Array.from(generated.seed.snapshot),Array.from(seed.snapshot))||!equal(generated.seed.identities,seed.identities))throw Error('SOURCE_MISMATCH');return {sourceDocument:{documentId:bundle.sourceDocumentId,revision:bundle.sourceRevision},seedId:bundle.seedId};
}
