import {readAuthority,snapshotId,verifyAuthority} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {requirePublicRecipeHistory} from '../projection/current-document-set.mjs';
import {observeSelectedSourceSet} from '../projection/selected-sources.mjs';
const enc=new TextEncoder(),hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
/** Public authority proof only. A recipient must verify the root and selected
 * head independently; this bundle never grants a key or admits a device. */
export async function exportHouseholdParent({storage,scope,pin,provider,runtime}){
 const sc=structuredClone(scope),authority=await readAuthority(storage,sc,pin,provider);
 if(authority.state.events.some(({admission})=>admission?.manifest?.version===5&&admission.manifest.entries.length>1)){
  if(runtime?.storage!==storage||runtime.authority?.rootPin!==pin)throw Error('INVALID_AUTHORITY');
  const {sources,guard}=await observeSelectedSourceSet(runtime);
  const expected=guard.expectedAuthority;
  if(expected.scope.id!==sc.id||expected.record.acceptedParent!==authority.activeHead||expected.record.revision!==authority.revision||
     expected.record.authorizationSnapshot!==await snapshotId(provider,authority.state))throw Error('CONFLICT');
  const live=new Set();
  for(const {runtime,doc} of sources.slice(1)){
   const recipe=doc.getMap(`recipe:${encodeURIComponent(runtime.recipeId)}`);
   if(recipe.get('removed')!==true&&!recipe.get('removedAt'))live.add(runtime.recipeId);
  }
  requirePublicRecipeHistory(authority.state,live);
 }
 return {version:1,scope:sc,rootPin:pin,selectedHead:authority.activeHead,state:structuredClone(authority.state)};
}
/** Verify a public parent against both independently confirmed pins. */
export async function verifyHouseholdParentRecord({provider,bundle,confirmedRootPin,confirmedSelectedHead,explicit}){
 const input=structuredClone(bundle);if(explicit!==true||!input||Object.keys(input).sort().join(',')!=='rootPin,scope,selectedHead,state,version'||input.version!==1||input.scope?.kind!=='household'||!input.scope.id||typeof confirmedRootPin!=='string'||typeof confirmedSelectedHead!=='string'||input.rootPin!==confirmedRootPin||input.selectedHead!==confirmedSelectedHead||input.state?.activeHead!==confirmedSelectedHead||input.state?.root?.householdId!==input.scope.id)throw Error('CONFIRMATION_REQUIRED');
 await verifyAuthority(input.state,confirmedRootPin,provider);const bytes=enc.encode(JSON.stringify(canonical(input.state))),hash=await provider.hash(domain('authority-state',canonical(input.state)));if(!(hash instanceof Uint8Array)||hash.length!==32)throw Error('INVALID_AUTHORITY');
 return {scope:input.scope,revision:0,acceptedParent:confirmedSelectedHead,authorizationSnapshot:hex(hash),authorityState:bytes};
}
export async function acceptHouseholdParent({storage,...input}){
 const record=await verifyHouseholdParentRecord(input);
 const result=await storage.retainPublicHouseholdParent(record);
 if(!result.ok)throw Error(result.error?.code??result.error);
 return result.value;
}
