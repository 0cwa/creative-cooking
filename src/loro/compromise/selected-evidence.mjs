import {observeSelectedSourceSet} from '../projection/selected-sources.mjs';
import {authenticateEvidence} from './authenticated-evidence.mjs';
import {REVIEW_LIMITS} from './review.mjs';
import {commandRecipeId} from '../domain/recipe-document.mjs';
import {validateOperations} from '../domain/registry.mjs';

// Verifies only the supplied current-head candidates; this is not a history or
// a compromise boundary. Bytes are copied before any asynchronous work.
export async function verifySelectedEvidence(runtime,candidates) {
 if(!Array.isArray(candidates)||candidates.length>REVIEW_LIMITS.objects||Array.from({length:candidates.length},(_,i)=>Object.hasOwn(candidates,i)).some(x=>!x))throw Error('TOO_LARGE');
 let total=0;
 const batch=candidates.map(item=>{
  if(!item||typeof item.sourceId!=='string'||!item.sourceId||typeof item.objectId!=='string'||!item.objectId||typeof item.documentId!=='string'||!item.documentId||!(item.bytes instanceof Uint8Array)||!item.bytes.length)throw Error('MALFORMED');
  total+=item.bytes.length;
  if(item.bytes.length>REVIEW_LIMITS.objectBytes||total>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');
  return {...item,bytes:new Uint8Array(item.bytes)};
 });
 const {sources,guard}=await observeSelectedSourceSet(runtime);
 const routes=new Map(sources.map(source=>[source.runtime.scope.documentId,source]));
 const results=[];
 for(const item of batch){
  const source=routes.get(item.documentId);
  if(!source){results.push({sourceId:item.sourceId,objectId:item.objectId,documentId:item.documentId,status:'unavailable'});continue;}
  const target=source.runtime,recipeId=target.recipeId??null;
  try {
   const authority=await target.authorization();
   const evidence=await authenticateEvidence(target,'household',{...authority,scope:target.scope},item);
   target.assertRecipeCommand(evidence.command,{replay:true});
   if(recipeId===null&&commandRecipeId(evidence.command)!==null)throw Error('INVALID_RECIPE_DOCUMENT');
   const prior=source.doc.forkAt(evidence.meta.frontiers),start=prior.oplogVersion();
   if(prior.import(evidence.update).pending?.size)throw Error('INSUFFICIENT_EVIDENCE');
   validateOperations(evidence.command,prior.exportJsonUpdates(start,undefined,false).changes);
   results.push({status:'verified',documentId:item.documentId,recipeId,bytes:item.bytes,evidence});
  } catch(error) {results.push({sourceId:item.sourceId,objectId:item.objectId,documentId:item.documentId,recipeId,status:'rejected',reason:error?.message??'INVALID_EVIDENCE'});}
 }
 const checked=await runtime.storage.checkSelectedHouseholdSources(guard);
 if(!checked.ok)throw Error(checked.error.code);
 return {results,guard};
}
