import {activatedPolicyEditContext,verifiedActivatedPolicyEdit} from './activated-policy-source.mjs';
import {createSourceVerifier} from '../disclosure/source-proof.mjs';
import {validate} from '../domain/registry.mjs';

const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
/** Local, first-generation edits based exclusively on copied receipt effects. */
export async function commitActivatedRecipeField({runtime,service,input}) {
 input=structuredClone(input);
 const command=validate(input.command);
 if(command.kind!=='recipe-field')throw Error('INVALID_AUTHORITY');
 const token=await activatedPolicyEditContext(runtime,service);
 const verify=createSourceVerifier({runtime,service,localEditContext:token,allowIncomplete:true});
 const dependencies=[...command.dependencyEffectIds].sort(),policies=new Set();
 for(const effect of dependencies)for(const hash of (await verify(effect)).policies)policies.add(hash);
 const expectedActiveHash=must(await runtime.storage.readDisclosureActive(runtime.scope.scopeId));
 const prepared=await runtime.prepareActivatedRecipeField(input,token,service);
 // The generic preparation replay does not authenticate stored ciphertext.
 if(prepared.previous)throw Error('CONFLICT');
 const auth=await runtime.authorization();
 const opened=await runtime.codec.openContent(prepared.commit.outbound[0].object.bytes,auth.signingKeyRefs);
 const header={...opened.header,version:3,disclosurePolicyHash:null,disclosurePolicyHashes:[...policies].sort(),sourceEffectIds:dependencies,disclosureIncomplete:true};
 prepared.commit.outbound[0].object=await runtime.codec.sealContent(header,opened.value,runtime.keyRef,auth.signingKeyRefs[runtime.scope.authorDevice]);
 const verified=await verifiedActivatedPolicyEdit(token,runtime,service);
 if(JSON.stringify(verified.expectedAuthority)!==JSON.stringify(prepared.commit.expectedAuthority))throw Error('STALE_AUTHORITY');
 return must(await runtime.storage.commitLocalWithDisclosurePolicy(prepared.commit,null,expectedActiveHash,undefined,[],verified.provenance));
}
