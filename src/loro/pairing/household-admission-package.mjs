import { checkExistingRecipientCeremonies, checkHouseholdCeremonies } from '../authority/ceremony.mjs';
import { domain } from '../authority/validator.mjs';

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

export function decodeAdmissionEvidence(value) {
  if (Array.isArray(value)) return value.map(decodeAdmissionEvidence);
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && typeof value.__bytes === 'string' && /^(?:[0-9a-f]{2})*$/.test(value.__bytes)) {
    return Uint8Array.from(value.__bytes.match(/../g) ?? [], byte => parseInt(byte, 16));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeAdmissionEvidence(entry)]));
}

/** Build the packet context from the signed admission, the accepted parent and
 * the device-specific transcript. Local session/secret checks remain separate. */
export async function admissionPackage({ sodium, provider, parent, authorizationSnapshot, item, recipientDevice }) {
  const { grant, manifest, localDeviceId, ceremonies, existingCeremonies } = item.admission;
  const index = grant.recipientDevices.indexOf(recipientDevice);
  const kind = index < 0 ? 'existing' : 'newcomer';
  const evidence = decodeAdmissionEvidence(kind === 'existing' ? existingCeremonies : ceremonies);
  const verify = kind === 'existing' ? checkExistingRecipientCeremonies : checkHouseholdCeremonies;
  const devices = await verify(sodium, parent, authorizationSnapshot, grant, evidence, provider);
  const device = devices.find(entry => entry.deviceId === recipientDevice);
  const proof = evidence.find(entry => entry.context.recipientDeviceId === recipientDevice);
  if (!device || !proof || proof.context.sponsorDeviceId !== localDeviceId) throw Error('INVALID_PROOF');

  const digest = async (purpose, value) => {
    const bytes = await provider.hash(domain(purpose, value));
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw Error('INVALID_PROOF');
    return hex(bytes);
  };
  const unsigned = Object.fromEntries(Object.entries(grant).filter(([key]) => key !== 'signatures'));
  const releaseId = kind === 'existing'
    ? await digest('existing-key-envelope', { admissionEventHash: grant.admissionEventHash, deviceId: recipientDevice })
    : grant.keyEnvelopeRefs[index];
  const context = {
    version: 1, transcriptHash: device.transcriptHash, releaseId, scopeKind: 'household', scopeId: parent.householdId,
    purpose: 'data', epochId: grant.newEpochId, generation: grant.newDocumentGeneration, senderDevice: localDeviceId,
    senderSigningKey: hex(proof.transcript.initiator.signingPublicKey), senderWrappingKey: hex(proof.transcript.initiator.wrappingPublicKey),
    recipientDevice, recipientSigningKey: hex(proof.transcript.responder.signingPublicKey), recipientWrappingKey: device.wrappingKeyRef,
    policyHash: item.event.policyHash, grantHash: await digest('current-state-grant', unsigned), projectionId: manifest.newDocumentId,
    manifestHash: grant.projectionManifestHash
  };
  return { kind, context, proof, guardId: device.guardId };
}
