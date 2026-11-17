import {readAuthority,verifyAuthority} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
const enc=new TextEncoder(),hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
/** Public authority proof only. A recipient must verify the root and selected
 * head independently; this bundle never grants a key or admits a device. */
export async function exportHouseholdParent({storage,scope,pin,provider}){
 const sc=structuredClone(scope),authority=await readAuthority(storage,sc,pin,provider);
 return {version:1,scope:sc,rootPin:pin,selectedHead:authority.activeHead,state:structuredClone(authority.state)};
}
/** Accept a public parent only after the user separately confirms both pins. */
export async function acceptHouseholdParent({storage,provider,bundle,confirmedRootPin,confirmedSelectedHead,explicit}){
 const input=structuredClone(bundle);if(explicit!==true||!input||Object.keys(input).sort().join(',')!=='rootPin,scope,selectedHead,state,version'||input.version!==1||input.scope?.kind!=='household'||!input.scope.id||typeof confirmedRootPin!=='string'||typeof confirmedSelectedHead!=='string'||input.rootPin!==confirmedRootPin||input.selectedHead!==confirmedSelectedHead||input.state?.activeHead!==confirmedSelectedHead||input.state?.root?.householdId!==input.scope.id)throw Error('CONFIRMATION_REQUIRED');
 await verifyAuthority(input.state,confirmedRootPin,provider);const bytes=enc.encode(JSON.stringify(canonical(input.state))),hash=await provider.hash(domain('authority-state',canonical(input.state)));if(!(hash instanceof Uint8Array)||hash.length!==32)throw Error('INVALID_AUTHORITY');
 const record={scope:input.scope,revision:0,acceptedParent:confirmedSelectedHead,authorizationSnapshot:hex(hash),authorityState:bytes},old=await storage.readPairingAuthority(input.scope);if(!old.ok)throw Error(old.error);if(old.value){if(old.value.revision!==0||old.value.acceptedParent!==record.acceptedParent||old.value.authorizationSnapshot!==record.authorizationSnapshot||hex(old.value.authorityState)!==hex(bytes))throw Error('CONFLICT');return {replayed:true}}
 const result=await storage.compareAndSwapPairingAuthority({expectedRevision:null,record});if(!result.ok)throw Error(result.error?.code??result.error);return {replayed:false};
}
