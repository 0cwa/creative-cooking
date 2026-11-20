import {readVerifiedPolicyDocumentSet} from './stage-policy-document-set.mjs';
import {observeSelectedSourceSet,selectedSourceHash} from '../projection/selected-sources.mjs';
import {policyBaseline} from '../authority/policy-baseline.mjs';
import {domain} from '../authority/validator.mjs';
import {inspectOwnDeviceSnapshot,verifyOwnDeviceDocumentCopy,must} from '../pairing/household-own-device.mjs';

const same=(a,b)=>{const x=domain('policy-source-compare',a),y=domain('policy-source-compare',b);return x.length===y.length&&x.every((v,i)=>v===y[i]);};

/** Capture restrictions only. The guard commitment must be re-created and checked
 * inside activation; the signed statement alone cannot establish currentness. */
export async function capturePolicySourceEvidence({runtime,targetHead,service,sodium}) {
 const {storage,LoroDoc,authority}=runtime, {provider,rootPin:pin}=authority;
 const initial=await readVerifiedPolicyDocumentSet({runtime,targetHead});
 const captured=await observeSelectedSourceSet(runtime,{verifyCheckpointHistory:true});
 if(!same(captured.signed.manifest,initial.signed.body.observation.manifest))throw Error('STALE_SOURCE');
 const context=await service.authority(), rows=[], effects=new Set(), commands=new Set();
 const parentState=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(initial.current.authorityState));
 for(const [i,source] of captured.sources.entries()) {
  const mapping=initial.stage.mapping[i], documentId=source.runtime.scope.documentId;
  if(!mapping||mapping.sourceDocumentId!==documentId||mapping.recipeId!==(source.runtime.recipeId??null))throw Error('INVALID_SOURCE');
  const snapshot=source.bytes??new LoroDoc().export({mode:'snapshot'});
  const staged=new LoroDoc(); if(staged.import(mapping.baseline).pending?.size)throw Error('INVALID_SOURCE');
  const baseline=await policyBaseline(source.doc,provider);
  if(!same(baseline,await policyBaseline(staged,provider)))throw Error('INVALID_SOURCE');
  const retained=must(await storage.readProjectionSeed(captured.guard.expectedAuthority,documentId));
  const seed=retained?.seed??{seedId:'empty',identities:[]}, seedSnapshot=retained?.snapshot??null;
  const {identities}=inspectOwnDeviceSnapshot({LoroDoc,snapshot,seed,seedSnapshot});
  for(const identity of identities) {
   if(effects.has(identity.effectId)||commands.has(identity.commandId))throw Error('INVALID_SOURCE');
   effects.add(identity.effectId); commands.add(identity.commandId);
  }
  const sources=must(await storage.readOwnDeviceSourcePolicies(captured.guard.expectedAuthority,documentId,identities.map(x=>x.effectId)));
  const policies=new Map();
  for(const hash of new Set(sources.flatMap(x=>x.policyHashes))) for(let next=hash;next&&!policies.has(next);) {
   const policy=await service.validateStored(next,context); policies.set(next,policy);
   if(policies.size>64)throw Error('TOO_LARGE'); next=policy.policy.predecessor;
  }
  const records=[...policies.values()].sort((a,b)=>a.policyHash<b.policyHash?-1:1);
  await verifyOwnDeviceDocumentCopy({sodium,provider,LoroDoc,copy:{snapshot,seed,seedSnapshot,sources,policies:records},pin,parentState,
   authorDevice:runtime.scope.authorDevice,householdId:runtime.scope.scopeId,baseline});
  rows.push({recipeId:mapping.recipeId,sourceDocumentId:documentId,targetDocumentId:mapping.targetDocumentId,baseline,
   identities,sources:sources.map(row=>({...row,incomplete:true})),policies:records});
 }
 const guardHash=await selectedSourceHash(provider,'policy-source-guard-v1',captured.guard);
 const again=await readVerifiedPolicyDocumentSet({runtime,targetHead});
 if(!same(initial,again))throw Error('STALE_SOURCE');
 must(await storage.checkSelectedHouseholdSources(captured.guard));
 const body={version:1,targetHead,guardHash,rows};
 return {body,statement:domain('policy-source-evidence-v1',body)};
}
