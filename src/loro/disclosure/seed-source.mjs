import {checkGrantManifest} from '../authority/grant.mjs';
import {policyBranchAncestors} from '../authority/policy-baseline.mjs';
import {verifyPolicyProjection} from './policy-seed.mjs';
import {authorityBytes} from '../authority/chain.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
const sameBytes=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((byte,index)=>byte===b[index]);

async function verifiedDocumentSetSeed(runtime,context,publication,policySeed) {
 const {scope,LoroDoc,authority:{provider,rootPin:pin}}=runtime;
 const {state,activeHead}=context.current,head=publication.nextAuthority.acceptedParent;
 // Only the installed selection can attest to a recipe in a separate
 // document. Checkout/rotation have no document-set transition yet.
 const item=state.events.find(event=>event.admission?.grant.admissionEventHash===head);
 const {manifest,grant,operationId}=item?.admission??{};
 const index=manifest?.entries?.findIndex(entry=>entry.documentId===scope.documentId);
 const entry=manifest?.entries?.[index],document=publication.documents[index],retained=publication.documentSet.seeds[index];
 if(head!==activeHead||head!==scope.branchHead||manifest?.version!==5||manifest.householdId!==scope.scopeId||
   manifest.newEpochId!==scope.epochId||manifest.newGeneration!==scope.documentGeneration||operationId!==publication.operationId||
   !entry||document?.documentId!==entry.documentId||retained?.documentId!==entry.documentId||
   publication.manifest.id!==grant.projectionManifestHash||policySeed.bundleHash!==entry.policyBundleHash||
   retained.seed.seedId!==entry.seedId||policySeed.bundle.version!==4||
   !sameBytes(publication.manifest.bytes,authorityBytes(manifest)))throw Error('INVALID_SEED_PROOF');
 const snapshot=document.bytes;
 const hex=Array.from(snapshot,byte=>byte.toString(16).padStart(2,'0')).join('');
 if(await selectedSourceHash(provider,'projection-snapshot',hex)!==entry.snapshotHash)throw Error('INVALID_SEED_PROOF');
 const seedDoc=new LoroDoc();
 seedDoc.import(snapshot);
 const seed={version:1,seedId:retained.seed.seedId,peerId:entry.peerId,snapshot,identities:retained.seed.identities};
 const proof=await verifyPolicyProjection({provider,pin,state,seed,bundle:policySeed.bundle,
  expectedBundleHash:entry.policyBundleHash,expectedSourceHead:manifest.parentHead,
  expectedSourceDocument:entry.sourceDocumentId,expectedSourceRevision:entry.sourceRevision,
  LoroDoc,selectedRecipeId:entry.recipeId??undefined,allowEmpty:true});
 return {entries:new Map(proof.entries.map(effect=>[effect.effectId,effect.policyHashes])),seedDoc,sourceMapping:'signed-attestation-only'};
}
/** A v2 seed is usable for disclosure only after the selected pinned admission,
 * signed manifest, exact snapshot and accepted policy artifacts all verify. */
export async function verifiedSeedSources({runtime,service,context}) {
 const s=runtime.scope,found=must(await runtime.storage.readProjectionPolicySeed(context.resolved.expectedAuthority,s.documentId));if(!found)throw Error('SOURCE_PROVENANCE_REQUIRED');
 const {publication,policySeed}=found,state=context.current.state,head=publication.nextAuthority?.acceptedParent;
 if(publication.documentSet)return verifiedDocumentSetSeed(runtime,context,publication,policySeed);
 const origin=policyBranchAncestors(context.verified,context.current.activeHead).find(node=>node.head===head),documentId=origin?.runtime.documentId;
 const item=state.events.find(e=>e.event&&e.admission&&e.event.subject?.documentId===documentId&&e.event.parentHead===policySeed.bundle.sourceHead),manifest=item?.admission?.manifest,grant=item?.admission?.grant,parent=context.verified.nodes.get(policySeed.bundle.sourceHead);
 if(!origin||!item||!manifest||![2,3,4].includes(manifest.version)||!parent||publication.documents?.length!==1||publication.documents[0].documentId!==documentId||publication.manifest?.id!==grant?.projectionManifestHash||policySeed.bundleHash!==manifest.policyBundleHash)throw Error('INVALID_SEED_PROOF');
 const checked=await checkGrantManifest(parent,grant,manifest,publication.documents[0].bytes,service.provider??runtime.authority.provider);if(checked.reason!=='SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED')throw Error('INVALID_SEED_PROOF');
 const seedDoc=new runtime.LoroDoc();seedDoc.import(publication.documents[0].bytes);const seed={version:1,seedId:publication.seed.seedId,peerId:policySeed.bundle.peerId,snapshot:publication.documents[0].bytes,identities:publication.seed.identities,purchaseIds:Object.keys(seedDoc.getMap('purchases').toJSON()).sort()};
 const proof=await verifyPolicyProjection({provider:runtime.authority.provider,pin:runtime.authority.rootPin,state,seed,bundle:policySeed.bundle,expectedBundleHash:manifest.policyBundleHash,expectedSourceHead:item.event.parentHead,expectedSourceDocument:manifest.sourceDocument,expectedSourceRevision:manifest.sourceRevision,LoroDoc:runtime.LoroDoc});return {entries:new Map(proof.entries.map(e=>[e.effectId,e.policyHashes])),seedDoc,sourceMapping:'signed-attestation-only'};
}
