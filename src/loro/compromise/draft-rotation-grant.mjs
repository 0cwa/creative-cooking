import {verifyDraftRotationManifest} from './draft-rotation-manifest.mjs';
import {checkRecipientBinding,digest,exact,grantBody,same,verifySignature} from './revocation.mjs';

const id=value=>typeof value==='string' && value.length>0 && new TextEncoder().encode(value).length<=256;

// Proposal review only: no publication, installation, or key access follows.
export async function verifyDraftRotationGrant({provider,pin,parent,nodes,state,item,grant,manifest,recipientBindings,requireQuorum=true}) {
 ({parent,nodes,state,item,grant,manifest,recipientBindings}=structuredClone({parent,nodes,state,item,grant,manifest,recipientBindings}));
 if(typeof requireQuorum!=='boolean') throw Error('INVALID_GRANT');
 const checked=await verifyDraftRotationManifest({provider,pin,parent,nodes,state,item,manifest});
 const subject=item.event.subject,recipients=subject.devices.map(d=>d.deviceId);
 if(!exact(grant,'version,householdId,parentHead,eventHash,newEpochId,newGeneration,documentId,manifestHash,recipients,packageRefs,contentClasses,disclosure,signatures') ||
  grant.version!==1 || grant.householdId!==parent.householdId || grant.parentHead!==parent.head || grant.eventHash!==checked.eventHash ||
  grant.newEpochId!==subject.newEpochId || grant.newGeneration!==subject.newGeneration || grant.documentId!==subject.documentId ||
  grant.manifestHash!==checked.manifestHash || !same(grant.recipients,recipients) || !Array.isArray(grant.packageRefs) ||
  grant.packageRefs.length!==recipients.length || !Array.from(grant.packageRefs).every(id) || new Set(grant.packageRefs).size!==recipients.length ||
  !same(grant.contentClasses,['pantry','recipe','shopping']) || grant.disclosure!=='current-state-only' ||
  !Array.isArray(grant.signatures) || grant.signatures.length!==item.approvals.length) throw Error('INVALID_GRANT');
 if(!Array.isArray(recipientBindings) || recipientBindings.length!==recipients.length ||
  new Set(subject.devices.map(d=>d.wrappingKeyRef)).size!==recipients.length) throw Error('INVALID_RECIPIENT');
 for(let i=0;i<recipients.length;i++){
  const binding=recipientBindings[i],device=await checkRecipientBinding(parent,binding,provider);
  if(device.deviceId!==recipients[i] || binding.wrappingKey!==subject.devices[i].wrappingKeyRef) throw Error('INVALID_RECIPIENT');
 }
 // Bind the signed recipient attestations themselves, not only their keys.
 const body=grantBody(grant), bindingsHash=await digest(provider,'draft-rotation-recipient-bindings-v1',recipientBindings);
 for(let i=0;i<item.approvals.length;i++){
  const {adultId,deviceId}=item.approvals[i],signature=grant.signatures[i];
  const device=parent.devices.find(d=>d.active && d.deviceId===deviceId && d.adultId===adultId);
  if(!exact(signature,'adultId,deviceId,signature') || signature.adultId!==adultId || signature.deviceId!==deviceId || !device ||
   !await verifySignature(provider,device.signingKeyRef,'draft-rotation-set-grant-vote-v1',{grant:body,bindingsHash,adultId,deviceId},signature.signature)) throw Error('INVALID_GRANT');
 }
 if(requireQuorum && !checked.complete) throw Error('QUORUM_REQUIRED');
 return {...checked,grantHash:await digest(provider,'draft-rotation-set-grant-v1',{grant:body,bindingsHash})};
}
