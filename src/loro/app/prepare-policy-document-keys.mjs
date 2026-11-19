import {readVerifiedPolicyDocumentSet} from './stage-policy-document-set.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Prepare wrapped target keys without installing them. The injected reader is
 * trusted to authenticate the complete route and invoke its callback exactly
 * once with that source document's key, without fallback to another document.
 * Its key access must remain callback-scoped. The eventual commit must recheck
 * the staged proof and authority atomically; this function does not select it. */
export async function preparePolicyDocumentKeys({runtime,targetHead,keys,withSourceDocumentKey}) {
 if(typeof withSourceDocumentKey!=='function') throw Error('INVALID_SOURCE_READER');
 const scope=structuredClone(runtime.scope), authority=runtime.authority, storage=runtime.storage, pin=authority.rootPin, provider=authority.provider;
 const initial=await readVerifiedPolicyDocumentSet({runtime,targetHead});
 const manifest=initial.signed.body.observation.manifest;
 const author=initial.parent.devices.find(d=>d.active && d.deviceId===scope.authorDevice);
 if(!author || scope.scopeId!==manifest.householdId || scope.branchHead!==manifest.parentHead ||
   scope.documentId!==manifest.root.documentId || scope.epochId!==manifest.epochId ||
   scope.documentGeneration!==manifest.generation || pin!==manifest.rootPin ||
   runtime.keyRef!==scope.epochId) throw Error('INVALID_AUTHORITY');
 const expected=await runtime.authorize();
 if(expected.scope?.kind!=='household' || expected.scope.id!==scope.scopeId ||
   expected.record?.acceptedParent!==manifest.parentHead || expected.record.revision!==initial.current.revision ||
   expected.record.authorizationSnapshot!==initial.current.authorizationSnapshot) throw Error('INVALID_AUTHORITY');
 const prepared=[];
 for(const row of initial.stage.mapping) {
  const binding={scopeId:scope.scopeId,rootPin:pin,sourceHead:scope.branchHead,targetHead,
   epochId:scope.epochId,generation:scope.documentGeneration,deviceId:scope.authorDevice,
   sourceDocumentId:row.sourceDocumentId,targetDocumentId:row.targetDocumentId};
  const epochId=await selectedSourceHash(provider,'policy-target-key-slot-v1',binding);
  const operationId=await selectedSourceHash(provider,'policy-target-key-operation-v1',binding);
  const identity={version:1,scope:{kind:'household',id:scope.scopeId},deviceId:scope.authorDevice,purpose:'data',epochId};
  let called=false, result;
  await withSourceDocumentKey(structuredClone(binding),async key=>{
   if(called) throw Error('INVALID_SOURCE_READER');
   called=true;
   result=await keys.preparePairedDataKey(operationId,identity,key);
  });
  if(!called || !result) throw Error('INVALID_SOURCE_READER');
  prepared.push({targetDocumentId:row.targetDocumentId,...result});
 }
 const again=await readVerifiedPolicyDocumentSet({runtime,targetHead});
 const current=await runtime.authorize();
 if(!same(runtime.scope,scope) || runtime.authority!==authority || runtime.storage!==storage ||
   authority.rootPin!==pin || authority.provider!==provider || runtime.keyRef!==scope.epochId ||
   !same(expected,current) || !same(initial,again)) throw Error('STALE_SOURCE');
 return prepared;
}
