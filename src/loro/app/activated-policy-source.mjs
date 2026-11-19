import {readVerifiedActivatedPolicyDocumentSet} from './read-activated-policy-document-set.mjs';

/** Read only attested inherited provenance for one exact target document and effect.
 * The receipt and its staged baseline are reverified on every call. This is not
 * authorization to edit or disclose, and callers must validate policy lineage. */
export async function readActivatedPolicySource({storage,LoroDoc,pin,provider,scope,deviceId,targetHead,keys,documentId,effectId}) {
 if(typeof documentId!=='string'||!documentId||typeof effectId!=='string'||!effectId)throw Error('SOURCE_PROVENANCE_REQUIRED');
 const verified=await readVerifiedActivatedPolicyDocumentSet({storage,LoroDoc,pin,provider,scope,deviceId,targetHead,keys});
 const row=verified.provenance?.find(value=>value.targetDocumentId===documentId);
 if(!row || !row.identities.some(identity=>identity.effectId===effectId))throw Error('SOURCE_PROVENANCE_REQUIRED');
 const source=row.sources.find(value=>value.effectId===effectId);
 if(!source)throw Error('SOURCE_PROVENANCE_REQUIRED');
 return structuredClone(source);
}

import {verifyAuthority,policyId} from '../authority/chain.mjs';
import {matchesDisclosureService} from '../disclosure/service.mjs';

const editContexts=new WeakMap();
/** A read-only, runtime-bound view of the verified activation's inherited sources. */
export async function activatedPolicyEditContext(runtime,service) {
 const {storage,LoroDoc,scope:s,authority}=runtime;
 const activated=authority?.activatedPolicy, pin=authority?.rootPin, provider=authority?.provider;
 const scope={kind:'household',id:s.scopeId}, deviceId=s.authorDevice;
 if(!activated || !matchesDisclosureService(service,{storage,scope,rootPin:pin,provider,deviceId}))throw Error('INVALID_AUTHORITY');
 const args={storage,LoroDoc,pin,provider,scope,deviceId,targetHead:activated.targetHead,keys:activated.keys};
 const auth=await runtime.authorization();
 const opened=await readVerifiedActivatedPolicyDocumentSet(args);
 if(!opened.provenance)throw Error('SOURCE_PROVENANCE_REQUIRED');
 const row=opened.provenance.find(value=>value.targetDocumentId===s.documentId && value.recipeId===runtime.recipeId);
 if(!row)throw Error('SOURCE_PROVENANCE_REQUIRED');
 const prefix=structuredClone(opened.state);prefix.events.pop();prefix.selections.pop();prefix.activeHead=opened.parent.head;
 const verified=await verifyAuthority(prefix,pin,provider);
 const selected={...structuredClone(opened.parent),head:opened.targetHead,policy:structuredClone(opened.item.event.nextPolicy),policyHash:await policyId(provider,opened.item.event.nextPolicy)};
 selected.runtime.documentId=`policy-${opened.targetHead}`;
 verified.nodes.set(opened.targetHead,selected);
 const context={current:{revision:opened.record.revision,activeHead:opened.targetHead,state:opened.state},verified,resolved:auth};
 const token={};
 editContexts.set(token,{runtime,service,context,documentId:s.documentId,scope:structuredClone(s),args});
 return token;
}

// Tokens cannot be constructed by callers and are only accepted by the explicit
// incomplete local-edit route. Revalidate authority and the receipt for each read.
function requireEditContext(token,runtime,service) {
 const entry=editContexts.get(token);
 if(!entry || entry.runtime!==runtime || entry.service!==service || JSON.stringify(entry.scope)!==JSON.stringify(runtime.scope) ||
  !matchesDisclosureService(service,{storage:entry.args.storage,scope:entry.args.scope,rootPin:entry.args.pin,provider:entry.args.provider,deviceId:entry.args.deviceId}))throw Error('INVALID_AUTHORITY');
 return entry;
}

/** Reauthenticate the receipt and authority for the exact runtime and service. */
export async function verifiedActivatedPolicyEdit(token,runtime,service) {
 const entry=requireEditContext(token,runtime,service);
 const auth=await runtime.authorization();
 const opened=await readVerifiedActivatedPolicyDocumentSet(entry.args);
 if(!opened.verifiedProvenance || !opened.provenance?.some(row=>row.targetDocumentId===entry.documentId && row.recipeId===runtime.recipeId))throw Error('SOURCE_PROVENANCE_REQUIRED');
 await runtime.authorization();
 return {provenance:opened.verifiedProvenance,expectedAuthority:auth.expectedAuthority};
}

export async function activatedPolicyEditSource(token,runtime,service,effect) {
 const entry=requireEditContext(token,runtime,service);
 await runtime.authorization();
 const source=await readActivatedPolicySource({...entry.args,documentId:entry.documentId,effectId:effect});
 for(const hash of source.policyHashes)await service.validateStored(hash,entry.context);
 await runtime.authorization();
 return {policies:source.policyHashes,incomplete:true};
}
