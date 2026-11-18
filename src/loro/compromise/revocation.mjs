// Product household rotation. The enrolled Ed25519 key authenticates each
// device's chosen wrapping key. The signed grant binds the fresh audience.
import {domain, admissionThreshold, isRemoval, validateSuccessor} from '../authority/validator.mjs';
import {projectCurrentSeed, verifyCurrentSeed} from './current-seed.mjs';

export const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
export const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const encode = value => new TextEncoder().encode(JSON.stringify(canonical(value)));
export const unsigned = ({signature, ...body}) => body;
export const grantBody = ({signatures, ...body}) => body;
export const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === fields.split(',').sort().join(',');
const key = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 256;
export async function digest(provider, purpose, value) {
  const hash = await provider.hash(domain(purpose, value));
  if (!(hash instanceof Uint8Array) || hash.length !== 32) throw Error('INVALID_PROOF');
  return hex(hash);
}
export async function verifySignature(provider, signingKey, purpose, body, signature) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return false;
  return provider.verify(signingKey, domain(purpose, body), Uint8Array.from(signature.match(/../g), part => parseInt(part, 16)));
}
export async function checkRecipientBinding(parent, binding, provider) {
  if (!exact(binding,'version,scopeId,parentHead,deviceId,wrappingKey,signature') || binding.version !== 1 ||
      binding.scopeId !== parent.householdId || binding.parentHead !== parent.head || !key(binding.wrappingKey)) throw Error('INVALID_RECIPIENT');
  const device = parent.devices.find(d => d.active && d.deviceId === binding.deviceId);
  if (!device || !parent.runtime.acceptedRecipients.includes(device.deviceId) ||
      !await verifySignature(provider, device.signingKeyRef, 'revocation-recipient', unsigned(binding), binding.signature)) throw Error('INVALID_RECIPIENT');
  return device;
}

export const ADULT_REMOVAL_SOURCE='adult-removal-source';

export async function verifyRevocation({provider,parent,item,grant,manifest,recipientBindings,requireQuorum=true}) {
  if (!exact(item,'event,authorSignature,approvals') || !isRemoval(item.event?.kind)) throw Error('INVALID_REVOCATION');
  const check = await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
  if (!['QUORUM_REQUIRED','ROTATION_DISTRIBUTION_REQUIRED'].includes(check.reason)) throw Error(check.reason);
  const event = item.event, s = event.subject, publisher = event.authorDeviceId;
  if (publisher === s.deviceId || !s.devices.some(d => d.deviceId === publisher)) throw Error('INVALID_REVOCATION');
  const adultRemoval=event.kind==='removeAdult';
  const commonFields='version,scopeId,authorizationSnapshot,sourceDocumentId,sourceRevision,sourceHash,newDocumentId,newGeneration,newEpochId,draftHash,seedId,seedPeerId,seedSchemaVersion,seedIdentitiesHash';
  if (!exact(manifest,adultRemoval?commonFields+',kind':commonFields+',reviewId,evidenceDocumentId,evidenceGeneration,reportHash,selectionHash,archiveHash') ||
      manifest.version !== 1 || (adultRemoval&&manifest.kind!==ADULT_REMOVAL_SOURCE) || manifest.seedSchemaVersion !== 4 || manifest.scopeId !== parent.householdId ||
      manifest.sourceDocumentId !== parent.runtime.documentId || (manifest.sourceRevision!==null && (!Number.isSafeInteger(manifest.sourceRevision) || manifest.sourceRevision < 0)) ||
      manifest.newDocumentId !== s.documentId || manifest.newGeneration !== s.newGeneration || manifest.newEpochId !== s.newEpochId ||
      !id(manifest.seedId) || ![manifest.authorizationSnapshot,manifest.sourceHash,manifest.draftHash,manifest.seedIdentitiesHash].every(key) ||
      typeof manifest.seedPeerId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(manifest.seedPeerId) || BigInt(manifest.seedPeerId)>18446744073709551615n ||
      [...Object.values(parent.runtime.authorPeers),...s.devices.map(d=>d.peerId)].includes(manifest.seedPeerId)) throw Error('INVALID_MANIFEST');
  if (!adultRemoval && (![manifest.reviewId,manifest.evidenceDocumentId].every(id) ||
      !Number.isSafeInteger(manifest.evidenceGeneration) || manifest.evidenceGeneration < 0 ||
      ![manifest.reportHash,manifest.selectionHash,manifest.archiveHash].every(key))) throw Error('INVALID_MANIFEST');
  const others = s.devices.filter(d => d.deviceId !== publisher);
  if (!exact(grant,'version,householdId,parentHead,eventHash,newEpochId,newGeneration,documentId,manifestHash,recipients,packageRefs,contentClasses,disclosure,signatures') ||
      grant.version !== 2 || grant.householdId !== parent.householdId || grant.parentHead !== parent.head || grant.eventHash !== check.eventHash ||
      grant.newEpochId !== s.newEpochId || grant.newGeneration !== s.newGeneration || grant.documentId !== s.documentId ||
      grant.manifestHash !== await digest(provider,'rotation-manifest',manifest) ||
      !same(grant.recipients,s.devices.map(d=>d.deviceId)) || !Array.isArray(grant.packageRefs) ||
      grant.packageRefs.length !== others.length || new Set(grant.packageRefs).size !== others.length ||
      !Array.from(grant.packageRefs).every(id) || grant.disclosure !== 'current-state-only' ||
      !same(grant.contentClasses,['pantry','recipe','shopping']) || !Array.isArray(grant.signatures) ||
      grant.signatures.length !== item.approvals.length) throw Error('INVALID_GRANT');
  if (!Array.isArray(recipientBindings) || recipientBindings.length !== s.devices.length ||
      new Set(s.devices.map(d=>d.wrappingKeyRef)).size !== s.devices.length) throw Error('INVALID_RECIPIENT');
  for (const [index, binding] of recipientBindings.entries()) {
    const device = await checkRecipientBinding(parent,binding,provider), target = s.devices[index];
    if (device.deviceId !== target.deviceId || binding.wrappingKey !== target.wrappingKeyRef) throw Error('INVALID_RECIPIENT');
  }
  const body = grantBody(grant), voters = new Set();
  for (const [index, signature] of grant.signatures.entries()) {
    const {adultId,deviceId} = item.approvals[index];
    const device = parent.devices.find(d=>d.active && d.deviceId===deviceId && d.adultId===adultId);
    if (!exact(signature,'adultId,deviceId,signature') || signature.adultId!==adultId || signature.deviceId!==deviceId ||
        !await verifySignature(provider,device.signingKeyRef,'rotation-grant-signature',{grant:body,adultId,deviceId},signature.signature)) throw Error('INVALID_GRANT');
    voters.add(adultId);
  }
  const required = admissionThreshold(parent.policy,parent.roster.length), complete = voters.size>=required;
  if (requireQuorum && !complete) throw Error('QUORUM_REQUIRED');
  return {complete, approvals:voters.size, required, eventHash:check.eventHash, grantHash:await digest(provider,'rotation-distribution-grant',body)};
}

export async function revocationPackage({provider,parent,item,recipientDevice}) {
  const {grant,localDeviceId,recipientBindings} = item.rotation;
  const devices = item.event.subject.devices, sender=devices.find(d=>d.deviceId===localDeviceId);
  const index=devices.filter(d=>d.deviceId!==localDeviceId).findIndex(d=>d.deviceId===recipientDevice);
  if (index<0 || !sender) throw Error('INVALID_RECIPIENT');
  const recipient=devices.find(d=>d.deviceId===recipientDevice), releaseId=grant.packageRefs[index];
  const transcriptHash=await digest(provider,'revocation-package-binding',{
    eventHash:grant.eventHash, sender:recipientBindings.find(d=>d.deviceId===localDeviceId),
    recipient:recipientBindings.find(d=>d.deviceId===recipientDevice)
  });
  return {guardId:await digest(provider,'revocation-package-guard',{transcriptHash,releaseId}),context:{
    version:1,transcriptHash,releaseId,scopeKind:'household',scopeId:parent.householdId,purpose:'data',
    epochId:grant.newEpochId,generation:grant.newGeneration,senderDevice:localDeviceId,senderSigningKey:sender.signingKeyRef,
    senderWrappingKey:sender.wrappingKeyRef,recipientDevice,recipientSigningKey:recipient.signingKeyRef,
    recipientWrappingKey:recipient.wrappingKeyRef,policyHash:parent.policyHash,
    grantHash:await digest(provider,'rotation-distribution-grant',grantBody(grant)),projectionId:grant.documentId,manifestHash:grant.manifestHash
  }};
}

export async function verifyRevocationSeed({provider,LoroDoc,parent,item,manifest,snapshot,seed}) {
  if (seed?.seedId !== manifest.seedId || !(snapshot instanceof Uint8Array) || snapshot.length>1048576 ||
      await digest(provider,'rotation-draft-snapshot',hex(snapshot))!==manifest.draftHash ||
      await digest(provider,'projection-seed-identities',seed.identities)!==manifest.seedIdentitiesHash) throw Error('INVALID_SEED');
  const {peers} = verifyCurrentSeed({LoroDoc,snapshot,seed,schemaVersion:4});
  if (peers.some(peer=>peer!==manifest.seedPeerId || [...Object.values(parent.runtime.authorPeers),...item.event.subject.devices.map(d=>d.peerId)].includes(peer))) throw Error('INVALID_SEED');
}


/** Ordinary removal advances the reviewed live values into an independent document. */
export function projectRemovalSeed({LoroDoc, source, seedId, peerId}) {
  return projectCurrentSeed({LoroDoc,source:source?.bytes??new LoroDoc().export({mode:'snapshot'}),seedId,peerId,schemaVersion:4});
}
