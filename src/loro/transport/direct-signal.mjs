import {domain} from '../authority/validator.mjs';
import {digest} from './adapter.mjs';

export const MAX_SIGNAL = 48 * 1024;
export const directDomain = (purpose, value) => domain(`cooking-direct-v1/${purpose}`, value);
export const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const signature = value => typeof value === 'string' && /^[0-9a-f]{128}$/.test(value)
  ? Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16)) : null;
export const objectId = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const encoder = new TextEncoder();
const deviceId = value => typeof value === 'string' && /^[a-z0-9-]{1,100}$/.test(value);
const identity = value => exact(value, ['deviceId', 'signingKey']) && deviceId(value.deviceId) && objectId(value.signingKey);
const sessionId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const offerFields = ['version', 'kind', 'scopeId', 'head', 'sessionId', 'initiator', 'responder', 'sdp'];

function validSdp(sdp) {
  if (typeof sdp !== 'string' || sdp.length > MAX_SIGNAL) return false;
  const lines = sdp.split(/\r?\n/);
  const media = lines.filter(line => line.startsWith('m='));
  return lines[0] === 'v=0' && media.length === 1 &&
    /^m=application [1-9][0-9]* (UDP\/DTLS\/SCTP webrtc-datachannel|DTLS\/SCTP [0-9]+)$/.test(media[0]) &&
    lines.some(line => /^a=fingerprint:sha-256 (?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(line)) &&
    lines.some(line => line.startsWith('a=ice-ufrag:')) && lines.some(line => line.startsWith('a=ice-pwd:'));
}

export function readSignal(text, kind) {
  if (typeof text !== 'string' || text.length > MAX_SIGNAL || encoder.encode(text).length > MAX_SIGNAL) throw Error('SIGNAL_TOO_LARGE');
  let message;
  try { message = JSON.parse(text); } catch { throw Error('INVALID_SIGNAL'); }
  const fields = kind === 'offer' ? offerFields : [...offerFields, 'offerHash'];
  if (!exact(message, [...fields, 'signature']) || message.version !== 1 || message.kind !== kind ||
    !deviceId(message.scopeId) || !objectId(message.head) || !sessionId(message.sessionId) ||
    !identity(message.initiator) || !identity(message.responder) || message.initiator.deviceId === message.responder.deviceId ||
    message.initiator.signingKey === message.responder.signingKey || !validSdp(message.sdp) || !signature(message.signature) ||
    (kind === 'answer' && !objectId(message.offerHash))) throw Error('INVALID_SIGNAL');
  return message;
}

export async function signSignal(provider, signal, key) {
  const bytes = await provider.sign(key, directDomain(signal.kind, signal));
  const message = {...signal, signature: hex(bytes)};
  readSignal(JSON.stringify(message), signal.kind);
  return message;
}

export async function verifySignal(provider, message, key) {
  const {signature: value, ...signal} = message;
  if (!await provider.verify(key, directDomain(signal.kind, signal), signature(value))) throw Error('INVALID_SIGNAL_SIGNATURE');
}

export const signalHash = (message, sha256 = digest) => sha256(directDomain('signed-signal', message));
export const transcriptHash = (offer, answer, sha256 = digest) => sha256(directDomain('transcript', {offer, answer}));
export const comparisonCode = hash => hash.slice(0, 32).match(/.{4}/g).join('-').toUpperCase();

export const currentDescriptions = connection => [connection.currentLocalDescription, connection.currentRemoteDescription];

export function requireNegotiated(connection, offer, answer, initiator, readDescriptions = currentDescriptions) {
  // Only stable descriptions represent the applied offer and answer.
  if (connection.signalingState !== 'stable') throw Error('NEGOTIATED_SIGNAL_MISMATCH');
  const [local, remote] = initiator ? [offer, answer] : [answer, offer];
  const [actualLocal, actualRemote] = readDescriptions(connection);
  if (actualLocal?.type !== local.kind || actualRemote?.type !== remote.kind ||
    actualLocal.sdp !== local.sdp || actualRemote.sdp !== remote.sdp) throw Error('NEGOTIATED_SIGNAL_MISMATCH');
}
