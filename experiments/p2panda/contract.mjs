// Opaque, transport-independent boundary. No recipe or application state types.
const MAGIC = new Uint8Array([0x43, 0x43, 0x46, 0x52]); // CCFR
const MAX_DOCUMENT_ID = 1024;
const MAX_PAYLOAD = 1024 * 1024;

export function encodeFrame({ documentId, bytes }) {
  if (typeof documentId !== 'string' || !documentId || !(bytes instanceof Uint8Array)) {
    throw new TypeError('A frame needs a documentId and Uint8Array bytes');
  }
  const id = new TextEncoder().encode(documentId);
  if (id.length > MAX_DOCUMENT_ID || bytes.length > MAX_PAYLOAD) {
    throw new RangeError('Frame exceeds experimental size bounds');
  }
  const result = new Uint8Array(11 + id.length + bytes.length);
  result.set(MAGIC);
  const view = new DataView(result.buffer);
  view.setUint8(4, 1);
  view.setUint16(5, id.length);
  view.setUint32(7, bytes.length);
  result.set(id, 11);
  result.set(bytes, 11 + id.length);
  return result;
}

export function decodeFrame(raw) {
  if (!(raw instanceof Uint8Array) || raw.length < 11 || !MAGIC.every((v, i) => raw[i] === v)) {
    throw new Error('Invalid frame magic/length');
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint8(4);
  const idSize = view.getUint16(5);
  const bytesSize = view.getUint32(7);
  if (version !== 1 || idSize === 0 || idSize > MAX_DOCUMENT_ID ||
      bytesSize > MAX_PAYLOAD || raw.length !== 11 + idSize + bytesSize) {
    throw new Error('Invalid frame version or bounds');
  }
  return {
    documentId: new TextDecoder('utf-8', { fatal: true }).decode(raw.slice(11, 11 + idSize)),
    bytes: raw.slice(11 + idSize)
  };
}

// Contract fake only: not a p2panda adapter, not a persistence engine.
export function createMemoryEndpoint() {
  const listeners = new Set();
  return {
    async send(frame) {
      const clone = decodeFrame(encodeFrame(frame));
      for (const callback of listeners) callback({ documentId: clone.documentId, bytes: clone.bytes.slice() });
    },
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
