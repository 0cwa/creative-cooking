import {checkGrantManifest} from '../authority/grant.mjs';
import {verifyPolicyProjection} from './policy-seed.mjs';
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
/** A v2 seed is usable for disclosure only after the selected pinned admission,
 * signed manifest, exact snapshot and accepted policy artifacts all verify. */
export async function verifiedSeedSources({runtime,service,context}) {
 const s=runtime.scope,found=must(await runtime.storage.readProjectionPolicySeed(context.resolved.expectedAuthority,s.documentId));if(!found)throw Error('SOURCE_PROVENANCE_REQUIRED');const {publication,policySeed}=found,state=context.current.state,head=publication.nextAuthority?.acceptedParent,item=state.events.find(e=>e.event&&e.admission&&e.event.subject?.documentId===s.documentId&&e.event.parentHead===policySeed.bundle.sourceHead),manifest=item?.admission?.manifest,grant=item?.admission?.grant,parent=context.verified.nodes.get(policySeed.bundle.sourceHead);
 if(!item||!manifest||![2,3].includes(manifest.version)||!parent||head!==context.current.activeHead||publication.documents?.length!==1||publication.documents[0].documentId!==s.documentId||publication.manifest?.id!==grant?.projectionManifestHash||policySeed.bundleHash!==manifest.policyBundleHash)throw Error('INVALID_SEED_PROOF');
 const checked=await checkGrantManifest(parent,grant,manifest,publication.documents[0].bytes,service.provider??runtime.authority.provider);if(checked.reason!=='SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED')throw Error('INVALID_SEED_PROOF');
 const seedDoc=new runtime.LoroDoc();seedDoc.import(publication.documents[0].bytes);const seed={version:1,seedId:publication.seed.seedId,peerId:policySeed.bundle.peerId,snapshot:publication.documents[0].bytes,identities:publication.seed.identities,purchaseIds:Object.keys(seedDoc.getMap('purchases').toJSON()).sort()};
 const proof=await verifyPolicyProjection({provider:runtime.authority.provider,pin:runtime.authority.rootPin,state,seed,bundle:policySeed.bundle,expectedBundleHash:manifest.policyBundleHash,expectedSourceHead:item.event.parentHead,expectedSourceDocument:manifest.sourceDocument,expectedSourceRevision:manifest.sourceRevision,LoroDoc:runtime.LoroDoc});return {entries:new Map(proof.entries.map(e=>[e.effectId,e.policyHashes])),seedDoc,sourceMapping:'signed-attestation-only'};
}
