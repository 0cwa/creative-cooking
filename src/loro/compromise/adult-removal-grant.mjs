import {verifyAdultRemovalDocumentSetManifest} from '../projection/current-document-set.mjs';
import {checkRecipientBinding,digest,exact,grantBody,same,verifySignature} from './revocation.mjs';

const id=value=>typeof value==='string' && value.length>0 && new TextEncoder().encode(value).length<=256;

// Verifies a proposal against independently authenticated parent ancestry. This
// neither publishes the proposal nor verifies possession or document bytes.
export async function verifyAdultRemovalGrant({provider,pin,parent,nodes,state,item,grant,manifest,recipientBindings,requireQuorum=true}) {
  ({parent,nodes,state,item,grant,manifest,recipientBindings}=structuredClone({parent,nodes,state,item,grant,manifest,recipientBindings}));
  if (typeof requireQuorum!=='boolean') throw Error('INVALID_GRANT');
  const checked=await verifyAdultRemovalDocumentSetManifest({provider,pin,parent,nodes,state,item,manifest});
  const subject=item.event.subject, recipients=subject.devices.map(device=>device.deviceId);
  if (!exact(grant,'version,householdId,parentHead,eventHash,newEpochId,newGeneration,documentId,manifestHash,recipients,packageRefs,contentClasses,disclosure,signatures') ||
    grant.version!==3 || grant.householdId!==parent.householdId || grant.parentHead!==parent.head ||
    grant.eventHash!==checked.eventHash || grant.newEpochId!==subject.newEpochId || grant.newGeneration!==subject.newGeneration ||
    grant.documentId!==subject.documentId || grant.manifestHash!==checked.manifestHash || !same(grant.recipients,recipients) ||
    !Array.isArray(grant.packageRefs) || grant.packageRefs.length!==recipients.length ||
    !Array.from(grant.packageRefs).every(id) || new Set(grant.packageRefs).size!==recipients.length ||
    !same(grant.contentClasses,['pantry','recipe','shopping']) || grant.disclosure!=='current-state-only' ||
    !Array.isArray(grant.signatures) || grant.signatures.length!==item.approvals.length) throw Error('INVALID_GRANT');
  if (!Array.isArray(recipientBindings) || recipientBindings.length!==recipients.length ||
    new Set(subject.devices.map(device=>device.wrappingKeyRef)).size!==recipients.length) throw Error('INVALID_RECIPIENT');
  for (let index=0;index<recipients.length;index++) {
    const binding=recipientBindings[index], device=await checkRecipientBinding(parent,binding,provider);
    if (device.deviceId!==recipients[index] || binding.wrappingKey!==subject.devices[index].wrappingKeyRef) throw Error('INVALID_RECIPIENT');
  }
  const body=grantBody(grant);
  for (let index=0;index<item.approvals.length;index++) {
    const {adultId,deviceId}=item.approvals[index], signature=grant.signatures[index];
    const device=parent.devices.find(d=>d.active && d.deviceId===deviceId && d.adultId===adultId);
    if (!exact(signature,'adultId,deviceId,signature') || signature.adultId!==adultId || signature.deviceId!==deviceId ||
      !device || !await verifySignature(provider,device.signingKeyRef,'adult-removal-set-grant-vote-v3',
        {grant:body,adultId,deviceId},signature.signature)) throw Error('INVALID_GRANT');
  }
  if (requireQuorum && !checked.complete) throw Error('QUORUM_REQUIRED');
  return {...checked,grantHash:await digest(provider,'adult-removal-set-distribution-grant-v3',body)};
}
