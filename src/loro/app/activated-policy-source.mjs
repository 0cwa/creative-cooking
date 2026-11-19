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
