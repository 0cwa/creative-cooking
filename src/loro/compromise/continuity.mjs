import {readContinuityHead} from '../storage/continuity-head.ts';
// Durable household continuity registration. Registration is not recovery or admission.
import {readAuthority,verifyAuthority} from '../authority/chain.mjs';
import {continuityBindingBytes,continuityBindingHash} from '../recovery/readmission.mjs';
const key=(...parts)=>JSON.stringify(parts),id=x=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=256;
const exact=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===ks.length&&ks.every(k=>Object.hasOwn(x,k));
const signature=x=>typeof x==='string'&&/^[0-9a-f]{128}$/.test(x)?Uint8Array.from(x.match(/../g),v=>parseInt(v,16)):null;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function verifyBinding({sodium,storage,scope,pin,provider,binding,bindingSignature,requireCurrent}){
 if(!exact(binding,['version','householdId','owner','checkpoint','signerDevice','generation','continuityKey'])||binding.version!==1||scope?.kind!=='household'||binding.householdId!==scope.id||![binding.owner,binding.checkpoint,binding.signerDevice].every(id)||!Number.isSafeInteger(binding.generation)||binding.generation<0||typeof binding.continuityKey!=='string'||!/^[0-9a-f]{64}$/.test(binding.continuityKey)||!signature(bindingSignature))throw Error('INVALID_BINDING');
 const authority=await readAuthority(storage,scope,pin,provider),verified=await verifyAuthority(authority.state,pin,provider),node=verified.nodes.get(binding.checkpoint),signer=node?.devices.find(d=>d.active&&d.deviceId===binding.signerDevice&&d.adultId===binding.owner),selected=new Set([pin,...authority.state.selections.map(x=>x.to)]);
 if(!node||!selected.has(binding.checkpoint)||(requireCurrent&&binding.checkpoint!==authority.activeHead)||!signer||!await provider.verify(signer.signingKeyRef,continuityBindingBytes(binding),signature(bindingSignature)))throw Error('INVALID_PROOF');
 return {authority,bindingHash:continuityBindingHash(sodium,binding)};
}
export class ContinuityRegistry {
 constructor(run,fault){if(typeof run!=='function')throw Error('MALFORMED');this.run=run;this.fault=fault}
 async register({sodium,storage,scope,pin,provider,expectedAuthority,binding,bindingSignature}){
  binding=structuredClone(binding);const {authority,bindingHash}=await verifyBinding({sodium,storage,scope,pin,provider,binding,bindingSignature,requireCurrent:true});
  if(!expectedAuthority||expectedAuthority.scope?.kind!==scope.kind||expectedAuthority.scope?.id!==scope.id||expectedAuthority.record?.revision!==authority.revision||expectedAuthority.record?.acceptedParent!==authority.activeHead)throw Error('STALE_AUTHORITY');
  return this.run(true,async tx=>{const a=await tx.get(key('pairing-authority',scope.kind,scope.id)),v=expectedAuthority.record;if(!a||a.revision!==v.revision||a.acceptedParent!==v.acceptedParent||a.authorizationSnapshot!==v.authorizationSnapshot)throw Error('STALE_AUTHORITY');const headKey=key('continuity-head',scope.id,binding.owner),slot=key('continuity-binding',scope.id,binding.owner,String(binding.generation)),checked=await readContinuityHead(tx,scope.id,binding.owner),old=checked.ok?checked.value?.head:undefined,prior=await tx.get(slot),record={version:1,binding,bindingSignature,bindingHash};if(!checked.ok)throw Error('CORRUPT');if(prior!==undefined){if(!same(prior,record)||!old||old.generation!==binding.generation||old.bindingHash!==bindingHash)throw Error('CONFLICT');return {bindingHash,replayed:true}}if((!old&&binding.generation!==0)||(old&&binding.generation!==old.generation+1))throw Error('CONFLICT');await tx.put(slot,record);this.fault?.('write');await tx.put(headKey,{generation:binding.generation,bindingHash});this.fault?.('write');return {bindingHash,replayed:false}})
 }
 async current({sodium,storage,scope,pin,provider,owner}){if(!id(owner))throw Error('INVALID_BINDING');const pair=await this.run(false,async tx=>{const checked=await readContinuityHead(tx,scope.id,owner);if(!checked.ok)throw Error('CORRUPT');return checked.value});if(!pair)return null;const r=pair.record;if(!r||r.version!==1||r.binding?.owner!==owner||r.binding.generation!==pair.head.generation||r.bindingHash!==pair.head.bindingHash)throw Error('CORRUPT');const proof=await verifyBinding({sodium,storage,scope,pin,provider,binding:r.binding,bindingSignature:r.bindingSignature,requireCurrent:false});if(proof.bindingHash!==r.bindingHash)throw Error('CORRUPT');return structuredClone(r)}
}
