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

/** Authenticate a staged set while its independently pinned source is current.
 * The returned records must be compared again in the eventual atomic transaction. */
export async function readVerifiedPolicyDocumentSet({runtime,targetHead}) {
 const {storage,LoroDoc,authority}=runtime, {provider,rootPin:pin}=authority;
 const loaded=await storage.readStagedPolicyDocumentSet(runtime.scope.scopeId,targetHead);
 if(!loaded.ok) throw Error(loaded.error.code);
 if(!loaded.value) throw Error('STAGE_NOT_FOUND');
 return verifyStagedPolicyDocumentSet({storage,LoroDoc,pin,provider,stage:loaded.value,scope:runtime.scope,targetHead});
}

/** Verify immutable stage evidence against the caller's pinned storage view. */
export async function verifyStagedPolicyDocumentSet({storage,LoroDoc,pin,provider,stage,scope,targetHead}) {
 stage=structuredClone(stage);
 scope=structuredClone(scope);
 let envelope;
 try { envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stage.proof)); }
 catch { throw Error('INVALID_STAGED_PROOF'); }
 if(!Array.isArray(envelope) || envelope.length!==3 || envelope[0]!=='creative-cooking/authority-candidate/v1' ||
   envelope[1]!=='staged-policy-document-set-v1' || !envelope[2] || typeof envelope[2]!=='object' ||
   Array.isArray(envelope[2]) || Object.keys(envelope[2]).sort().join(',')!=='item,parent,signed,version' ||
   envelope[2].version!==1 || !sameBytes(domain(envelope[1],envelope[2]),stage.proof)) throw Error('INVALID_STAGED_PROOF');
 const {item,signed,parent}=envelope[2], manifest=signed?.body?.observation?.manifest;
 if(!manifest || stage.mapping.length!==manifest.children?.length+1) throw Error('INVALID_STAGED_PROOF');
 const claims=[manifest.root,...manifest.children];
 const retained=stage.mapping.map((row,i)=>({documentId:row.sourceDocumentId,revision:claims[i].revision,
   bytes:claims[i].checkpointHash===null?new Uint8Array():row.baseline}));
 // An absent root is stored as a real empty snapshot, not arbitrary bytes.
 if(manifest.root.checkpointHash===null) {
  const doc=new LoroDoc();
  try { if(doc.import(stage.mapping[0].baseline).pending?.size) throw Error(); }
  catch { throw Error('INVALID_STAGED_PROOF'); }
  const {policyBaseline}=await import('../authority/policy-baseline.mjs');
  if(!same(await policyBaseline(doc,provider),await policyBaseline(new LoroDoc(),provider))) throw Error('INVALID_STAGED_PROOF');
 }
 const options={storage,scope:{kind:'household',id:scope.scopeId},pin,provider,LoroDoc,signed,retained};
 const verified=await verifyPolicyDocumentSet(options);
 if(verified.record.revision!==manifest.authorityRevision || verified.record.authorizationSnapshot!==manifest.authorizationSnapshot ||
   verified.selected.head!==stage.sourceHead || !same(parent,verified.selected)) throw Error('STALE_SOURCE');
 await matchPolicyDocumentSetEvent(options,item?.event);
 const result=await validateSuccessor(verified.selected,item.event,item.authorSignature,item.approvals,provider);
 if(result.status!=='validated') throw Error(result.reason||'INVALID_PROOF');
 if(result.eventHash!==targetHead || stage.targetHead!==targetHead) throw Error('INVALID_STAGED_PROOF');
 const target={...scope,branchHead:targetHead,documentId:`policy-${targetHead}`};
 for(let i=0;i<stage.mapping.length;i++) {
  const row=stage.mapping[i], claim=claims[i], recipeId=i===0?null:claim.recipeId;
  const expected=recipeId===null?target.documentId:await recipeDocumentId(target,pin,provider,recipeId);
  if(row.recipeId!==recipeId || row.sourceDocumentId!==claim.documentId || row.targetDocumentId!==expected) throw Error('INVALID_STAGED_PROOF');
 }
 return structuredClone({targetHead,item,signed,parent:verified.selected,stage,current:verified.record});
}

const sameBytes=(a,b)=>a.length===b.length && a.every((byte,i)=>byte===b[i]);
