import {observeSelectedSourceSet} from '../projection/selected-sources.mjs';
import {matchPolicyDocumentSetEvent,verifyPolicyDocumentSet} from '../authority/policy-document-set.mjs';
import {domain,validateSuccessor} from '../authority/validator.mjs';
import {recipeDocumentId} from '../domain/recipe-document.mjs';

const same=(a,b)=>{
 const x=domain('policy-stage-comparison',a),y=domain('policy-stage-comparison',b);
 return x.length===y.length && x.every((v,i)=>v===y[i]);
};

/** Stage a verified policy successor; activation and proof revalidation are separate. */
export async function stageVerifiedPolicyDocumentSet({runtime,item,signed}) {
 item=structuredClone(item); signed=structuredClone(signed);
 const {storage,LoroDoc,authority}=runtime, {provider,rootPin:pin}=authority;
 const captured=await observeSelectedSourceSet(runtime);
 if(!same(captured.signed.manifest,signed?.body?.observation?.manifest)) throw Error('STALE_SOURCE');
 const retained=captured.sources.map(source=>({documentId:source.runtime.scope.documentId,
  revision:source.revision,bytes:source.bytes??new Uint8Array()}));
 const options={storage,scope:captured.guard.expectedAuthority.scope,pin,provider,LoroDoc,signed,retained};
 const verified=await verifyPolicyDocumentSet(options);
 if(verified.selected.head!==captured.guard.binding.branchHead || item?.event?.parentHead!==verified.selected.head) throw Error('STALE_SOURCE');
 await matchPolicyDocumentSetEvent(options,item.event);
 const result=await validateSuccessor(verified.selected,item.event,item.authorSignature,item.approvals,provider);
 if(result.status!=='validated') throw Error(result.reason||'INVALID_PROOF');
 const targetHead=result.eventHash, target={...runtime.scope,branchHead:targetHead,documentId:`policy-${targetHead}`};
 const mapping=[];
 for(const source of captured.sources){
  const recipeId=source.runtime.recipeId??null;
  mapping.push({recipeId,sourceDocumentId:source.runtime.scope.documentId,
   targetDocumentId:recipeId===null?target.documentId:await recipeDocumentId(target,pin,provider,recipeId),
   baseline:source.bytes??new LoroDoc().export({mode:'snapshot'})});
 }
 const proof=domain('staged-policy-document-set-v1',{version:1,item,signed,parent:verified.selected});
 const staged=await storage.stagePolicyDocumentSet({guard:captured.guard,targetHead,proof,mapping});
 if(!staged.ok) throw Error(staged.error.code);
 return {targetHead,mapping};
}
