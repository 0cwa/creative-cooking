import {isPolicyDocumentId,validateSuccessor} from '../authority/validator.mjs';
import {isRecipeDocumentId,recipeDocumentId} from '../domain/recipe-document.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {checkDraftRotationSetEntries} from '../projection/current-document-set.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {prepareDraftRotationProjection} from './project-draft-rotation.mjs';
import {exact} from './revocation.mjs';

const digestPattern=/^[0-9a-f]{64}$/;

// This verifies signed proposal commitments only. It grants no authority to
// replay, publish, install, or access keys for the proposed document set.
export async function verifyDraftRotationManifest({provider,pin,parent,nodes,state,item,manifest}) {
 ({parent,nodes,state,item,manifest}=structuredClone({parent,nodes,state,item,manifest}));
 if(!exact(item,'event,authorSignature,approvals') || item.event?.version!==2 || item.event.kind!=='revokeDevice') throw Error('INVALID_REVOCATION');
 const event=item.event, subject=event.subject;
 const checked=await validateSuccessor(parent,event,item.authorSignature,item.approvals,provider);
 if(!['QUORUM_REQUIRED','ROTATION_DISTRIBUTION_REQUIRED'].includes(checked.reason)) throw Error(checked.reason??'INVALID_REVOCATION');
 if(event.authorDeviceId===subject.deviceId || !subject.devices.some(d=>d.deviceId===event.authorDeviceId) ||
    subject.devices.some(d=>d.deviceId===subject.deviceId) || state.activeHead!==parent.head ||
    manifest?.authorizationSnapshot!==await selectedSourceHash(provider,'authority-state',state)) throw Error('INVALID_REVOCATION');
 if(!exact(manifest,'version,rootPin,householdId,parentHead,authorizationSnapshot,revocationEventHash,newDocumentId,newEpochId,newGeneration,sourceSetHash,catalog,entries,draftBindingHash') ||
    !digestPattern.test(manifest.draftBindingHash)) throw Error('INVALID_DOCUMENT_SET');
 if(isRecipeDocumentId(subject.documentId) || isPolicyDocumentId(subject.documentId) ||
    [...nodes.values()].some(n=>n.epochId===subject.newEpochId || n.runtime.documentId===subject.documentId)) throw Error('INVALID_DOCUMENT_SET');
 const {draftBindingHash,...ordered}=manifest;
 await checkDraftRotationSetEntries({pin,parent,item,eventHash:checked.eventHash,manifest:ordered,provider});
 return {eventHash:checked.eventHash,manifestHash:await selectedSourceHash(provider,'draft-rotation-set-manifest-v1',manifest),
  approvals:checked.approvals,required:checked.required,complete:checked.reason==='ROTATION_DISTRIBUTION_REQUIRED'};
}

// Rebuild from the locally authenticated report and draft; only commitments
// and retained recipe identities enter the public proposal.
export async function prepareDraftRotationManifest({runtime,binding,item,allocateSeed}) {
 item=structuredClone(item); binding=structuredClone(binding);
 if(!exact(binding,'draftId,reportHash,suspectDevice,sourceHead,documents')) throw Error('INVALID_DRAFT_SOURCE');
 const subject=item?.event?.subject;
 const destination={parentHead:item?.event?.parentHead,documentId:subject?.documentId,epochId:subject?.newEpochId,generation:subject?.newGeneration};
 if(binding.suspectDevice!==subject?.deviceId) throw Error('INVALID_DRAFT_SOURCE');
 const captured=await prepareDraftRotationProjection({runtime,binding,destination,allocateSeed});
 const {provider,rootPin:pin}=runtime.authority;
 const {record,state,nodes}=await verifyPublicParent(runtime.storage,captured.source.expectedAuthority.scope,pin,provider);
 const parent=nodes.get(state.activeHead);
 if(!parent || parent.head!==binding.sourceHead || record.authorizationSnapshot!==captured.sourceManifest.authorizationSnapshot) throw Error('STALE_SOURCE');
 const checked=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
 if(!['QUORUM_REQUIRED','ROTATION_DISTRIBUTION_REQUIRED'].includes(checked.reason)) throw Error(checked.reason??'INVALID_REVOCATION');
 const target={scopeId:parent.householdId,documentId:subject.documentId,branchHead:checked.eventHash,epochId:subject.newEpochId,documentGeneration:subject.newGeneration};
 const source=captured.sourceManifest;
 const manifest={version:7,rootPin:pin,householdId:parent.householdId,parentHead:parent.head,authorizationSnapshot:record.authorizationSnapshot,
  revocationEventHash:checked.eventHash,newDocumentId:subject.documentId,newEpochId:subject.newEpochId,newGeneration:subject.newGeneration,
  sourceSetHash:await selectedSourceHash(provider,'selected-household-source-set-v1',source),
  catalog:{sourceRevision:source.catalog.revision,sourceHash:source.catalog.hash,targetRevision:captured.documents.length-1,removed:captured.removed},entries:[],
  draftBindingHash:await selectedSourceHash(provider,'draft-rotation-binding-v1',binding)};
 const documents=[];
 for(const entry of captured.documents){
  const documentId=entry.recipeId===null?target.documentId:await recipeDocumentId(target,pin,provider,entry.recipeId);
  const {seed,policyBundle,...sourceEntry}=entry;
  manifest.entries.push({...sourceEntry,documentId,seedId:seed.seedId,peerId:seed.peerId});
  documents.push({documentId,seed,policyBundle});
 }
 const result=await verifyDraftRotationManifest({provider,pin,parent,nodes,state,item,manifest});
 const unchanged=await runtime.storage.checkSelectedHouseholdSources(captured.source);
 if(!unchanged.ok) throw Error(unchanged.error.code);
 return {manifest,documents,source:captured.source,...result};
}
