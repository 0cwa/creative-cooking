import {capturePolicySourceEvidence} from './capture-policy-source-evidence.mjs';
import {readVerifiedPolicyDocumentSet} from './stage-policy-document-set.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {authorityBytes,snapshotId} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';

const same=(a,b)=>{const x=domain('policy-provenance-compare',a),y=domain('policy-provenance-compare',b);return x.length===y.length&&x.every((v,i)=>v===y[i]);};
const hex=bytes=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');

/** Build only from authenticated captured evidence. The exact guard must be committed. */
export async function buildPolicyProvenanceReceipt({runtime,targetHead,service,sodium,guard,next}) {
 guard=structuredClone(guard); next=structuredClone(next);
 const {provider,rootPin:pin}=runtime.authority, deviceId=runtime.scope.authorDevice;
 const evidence=await capturePolicySourceEvidence({runtime,targetHead,service,sodium});
 if(await selectedSourceHash(provider,'policy-source-guard-v1',guard)!==evidence.body.guardHash) throw Error('STALE_SOURCE');
 const verified=await readVerifiedPolicyDocumentSet({runtime,targetHead});
 if(evidence.body.rows.length!==verified.stage.mapping.length || evidence.body.rows.some((row,i)=>{
  const mapped=verified.stage.mapping[i];
  return row.recipeId!==mapped.recipeId || row.sourceDocumentId!==mapped.sourceDocumentId || row.targetDocumentId!==mapped.targetDocumentId || row.sources.some(source=>source.incomplete!==true);
 })) throw Error('INVALID_SOURCE');
 const expected=verified.current, scope=expected.scope;
 if(scope.kind!=='household' || scope.id!==runtime.scope.scopeId || guard.binding.rootPin!==pin ||
   guard.binding.scopeId!==scope.id || guard.binding.branchHead!==expected.acceptedParent ||
   !same(guard.expectedAuthority.record,{revision:expected.revision,acceptedParent:expected.acceptedParent,authorizationSnapshot:expected.authorizationSnapshot}) ||
   !same(guard.expectedAuthority.scope,scope)) throw Error('INVALID_AUTHORITY');
 let parent,state;
 try {parent=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(expected.authorityState));state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(next.authorityState));} catch {throw Error('INVALID_AUTHORITY');}
 const selection=state.selections?.at(-1), signer=verified.parent.devices.find(d=>d.active&&d.deviceId===deviceId);
 if(!selection || !signer || Object.keys(selection).sort().join(',')!=='deviceId,from,index,signature,to' ||
   selection.from!==expected.acceptedParent || selection.to!==targetHead || selection.deviceId!==deviceId ||
   selection.index!==parent.selections.length || !/^[a-f0-9]{128}$/.test(selection.signature)) throw Error('INVALID_SELECTION');
 const {signature,...selectionBody}=selection;
 if(!await provider.verify(signer.signingKeyRef,domain('select-head',{root:pin,householdId:scope.id,...selectionBody}),Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)))) throw Error('INVALID_SELECTION');
 const extension=structuredClone(parent); extension.events.push(verified.item); extension.selections.push(selection); extension.activeHead=targetHead;
 const expectedNext={...expected,revision:expected.revision+1,acceptedParent:targetHead,authorizationSnapshot:await snapshotId(provider,extension),authorityState:authorityBytes(extension)};
 if(!same(next,expectedNext)||!same(state,extension)) throw Error('INVALID_AUTHORITY');
 const body={version:1,scope,pin,deviceId,sourceHead:expected.acceptedParent,targetHead,
  sourceSnapshot:expected.authorizationSnapshot,nextSnapshot:next.authorizationSnapshot,guardHash:evidence.body.guardHash,
  stageProofHash:await selectedSourceHash(provider,'policy-provenance-stage-proof-v1',verified.stage.proof),rows:evidence.body.rows};
 const statement=domain('policy-provenance-receipt-v1',body);
 if(!statement.length || statement.length>MAX_SELECTED_SET_BYTES) throw Error('TOO_LARGE');
 const signed=await provider.sign(signer.signingKeyRef,statement);
 if(!(signed instanceof Uint8Array)||signed.length!==64||!await provider.verify(signer.signingKeyRef,statement,signed)) throw Error('INVALID_PROOF');
 const checked=await runtime.storage.checkSelectedHouseholdSources(guard);
 if(!checked.ok) throw Error(checked.error.code);
 return {statement,signature:hex(signed)};
}
