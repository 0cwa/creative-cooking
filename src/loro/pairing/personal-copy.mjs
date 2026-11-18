import {domain} from '../authority/validator.mjs';
import {assertCommandScope} from '../domain/personal-codec.mjs';

export const MAX_PERSONAL_SNAPSHOT = 2 * 1024 * 1024;
export const MAX_PERSONAL_PAIRING_FILE = 7 * 1024 * 1024;
export const MAX_PERSONAL_PAIRING_MESSAGE = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});

export function pairingText(sodium, value) {
 return JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? {bytesHex:sodium.to_hex(item)} : item);
}

export function parsePairingText(sodium, text, limit = MAX_PERSONAL_PAIRING_MESSAGE) {
 if (typeof text !== 'string' || text.length > limit || encoder.encode(text).length > limit) throw Error('TOO_LARGE');
 return JSON.parse(text, (_key, item) => {
  if (!item || typeof item !== 'object' || Object.keys(item).length !== 1 || !Object.hasOwn(item, 'bytesHex')) return item;
  if (typeof item.bytesHex !== 'string' || item.bytesHex.length % 2 || /[^0-9a-f]/.test(item.bytesHex)) throw Error('INVALID_FILE');
  return sodium.from_hex(item.bytesHex);
 });
}

export const pairingDigest = (sodium, bytes) => sodium.to_hex(sodium.crypto_generichash(32, bytes));

/** The snapshot stays inside the recipient's sealed box. The sponsor signs the
 * ciphertext in the exact local transcript, including role and key fingerprints. */
export function sealPersonalCopy(sodium, hash, participant, signingSecret, value) {
 const plain = encoder.encode(pairingText(sodium, value));
 try {
  if (plain.length + 112 > MAX_PERSONAL_PAIRING_FILE) throw Error('TOO_LARGE');
  const cipher = sodium.crypto_box_seal(plain, participant.wrappingPublicKey);
  const signature = sodium.crypto_sign_detached(domain('personal-device-file', [hash, pairingDigest(sodium, cipher)]), signingSecret);
  const file = new Uint8Array(signature.length + cipher.length);
  file.set(signature);
  file.set(cipher, signature.length);
  return file;
 } finally { plain.fill(0); }
}

export function verifyPersonalCopyFile(sodium, file, hash, sender) {
 if (!(file instanceof Uint8Array) || file.length <= 112 || file.length > MAX_PERSONAL_PAIRING_FILE) throw Error('INVALID_FILE');
 const cipher = file.subarray(64);
 if (!sodium.crypto_sign_verify_detached(file.subarray(0,64),
  domain('personal-device-file', [hash, pairingDigest(sodium, cipher)]), sender)) throw Error('INVALID_FILE');
 return cipher;
}

export function openPersonalCopy(sodium, file, hash, transcript, wrappingSecret) {
 const cipher = verifyPersonalCopyFile(sodium, file, hash, transcript.initiator.signingPublicKey);
 const plain = sodium.crypto_box_seal_open(cipher, transcript.responder.wrappingPublicKey, wrappingSecret);
 try { return parsePairingText(sodium, decoder.decode(plain), MAX_PERSONAL_PAIRING_FILE); }
 finally { plain.fill(0); }
}

/** Retain semantic identities already present in the copied document. */
export function personalCopyIdentities(doc) {
 const markers = Object.entries(doc.getMap('domain-effects').toJSON());
 if (markers.length > 4096) throw Error('TOO_LARGE');
 return markers.map(([effectId, marker]) => {
  const command = marker?.command;
  if (!command || command.effectId !== effectId || typeof command.commandId !== 'string' || !command.commandId || encoder.encode(command.commandId).length>256) throw Error('INVALID_SOURCE');
  assertCommandScope(command.kind, 'personal');
  return {commandId:command.commandId,effectId};
 });
}

export function inspectPersonalCopy(LoroDoc, sodium, bytes, peerId) {
 if (bytes !== null && (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_PERSONAL_SNAPSHOT)) throw Error('TOO_LARGE');
 const doc = new LoroDoc();
 if (bytes && doc.import(bytes).pending?.size) throw Error('INVALID_SOURCE');
 if (Object.keys(doc.toJSON()).some(name => !['personal-preferences','personal-conversations','personal-conversation-deletions','domain-effects'].includes(name) &&
    !name.startsWith('personal-messages:') && !name.startsWith('chef-proposal:'))) throw Error('INVALID_SOURCE');
 if (doc.oplogVersion().toJSON().has(peerId)) throw Error('INVALID_PEER');
 return {frontier:doc.frontiers().map(({peer,counter}) => `${peer}:${counter}`).sort(),
  hash:bytes===null ? null : pairingDigest(sodium,bytes), identities:personalCopyIdentities(doc)};
}

/** A completed retry may encounter later edits. Authenticate containment without
 * replacing them, then CAS the checked document inside the receipt transaction. */
export function assertContainsPersonalCopy(LoroDoc, original, latest) {
 if (!original) return;
 if (!latest) throw Error('CORRUPT');
 const before=new LoroDoc(), after=new LoroDoc();
 before.import(original);
 after.import(latest);
 const prefix=after.forkAt(before.frontiers());
 const history=doc=>JSON.stringify(doc.exportJsonUpdates(undefined,undefined,false));
 if(history(prefix)!==history(before))throw Error('CORRUPT');
}
