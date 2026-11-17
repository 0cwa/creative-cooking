// Experimental candidate only: no C1 suite or production interoperability is approved.
export const SUITE = 'candidate-ed25519-xchacha20-sealedbox-v1';
export const LIMIT = 1024 * 1024;
// Hex ciphertext plus bounded JSON header, including worst-case string escaping.
export const ENCODED_LIMIT = 2 * (LIMIT + 256) + 320 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fields = {
  content: ['version','suiteId','scopeId','documentId','documentGeneration','branchHead','policyHashes','epochId','authorDevice','deviceSequence','predecessorRefs','semanticEffectIds','payloadKind'],
  key: ['version','suiteId','scopeId','branchHead','policyHashes','epochId','recipientDevice','keyPurpose','senderDevice'],
};
const lists = new Set(['policyHashes','predecessorRefs','semanticEffectIds','disclosurePolicyHashes','sourceEffectIds']);
const numbers = new Set(['documentGeneration','deviceSequence']);
const id = x => typeof x === 'string' && x.length > 0 && encoder.encode(x).length <= 256;
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x,k));
export function validateHeader(kind, h) {
  const base = fields[kind];
  const keys = kind==='content' && (h?.version===2||h?.version===3) ? [...base,'disclosurePolicyHash','disclosurePolicyHashes','sourceEffectIds',...(h.version===3?['disclosureIncomplete']:[])] : base;
  if (!keys || !exact(h, keys)) throw Error('MALFORMED');
  if (h.version !== 1 && !(kind==='content' && (h.version===2||h.version===3))) throw Error('UNSUPPORTED_VERSION');
  if (h.suiteId !== SUITE) throw Error('UNSUPPORTED_SUITE');
  for (const k of keys.slice(2)) {
    const v = h[k];
    if (k==='disclosureIncomplete') { if(v!==true)throw Error('MALFORMED'); } else if(k==='disclosurePolicyHash' && h.version===3 && v===null) {} else if (lists.has(k)) {
      if (!Array.isArray(v) || v.length > 64 || !v.every(id) || new Set(v).size !== v.length) throw Error('MALFORMED');
    } else if (numbers.has(k)) {
      if (!Number.isSafeInteger(v) || v < 0) throw Error('MALFORMED');
    } else if (!id(v)) throw Error('MALFORMED');
  }
  if((h.version===2||h.version===3) && ((h.version===2&&!h.disclosurePolicyHashes.length) || !h.disclosurePolicyHashes.every((x,i)=>!i||h.disclosurePolicyHashes[i-1]<x) || !h.sourceEffectIds.every((x,i)=>!i||h.sourceEffectIds[i-1]<x)))throw Error('MALFORMED');
  return Object.fromEntries(keys.map(k => [k, lists.has(k) ? [...h[k]] : h[k]]));
}
const hex = b => Array.from(b, x => x.toString(16).padStart(2,'0')).join('');
function unhex(s, min, max) {
  if (typeof s !== 'string' || s.length % 2 || !/^[0-9a-f]*$/.test(s) || s.length < min*2 || s.length > max*2) throw Error('MALFORMED');
  return Uint8Array.from(s.match(/../g) || [], x => parseInt(x,16));
}
const bytes = x => encoder.encode(JSON.stringify(x));
const domain = (purpose, value) => bytes(['creative-cooking/k2-candidate/v1',purpose,value]);
/** Derive the candidate immutable ID from opaque encoded bytes with the same provider hash. */
export async function candidateObjectId(provider, input) {
  if (!(input instanceof Uint8Array)) throw Error('MALFORMED');
  if (input.length > ENCODED_LIMIT) throw Error('TOO_LARGE');
  const snapshot = new Uint8Array(input);
  const digest = await provider.hash(domain('object-id',hex(snapshot)));
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw Error('MALFORMED');
  return hex(digest);
}
// Provider owns private keys and implements reviewed primitive candidates. No private key bytes cross this API.
export function candidateCodec(provider) {
  async function seal(kind, header, value, ref, signingKeyRef) {
    const h = validateHeader(kind, header);
    if (!(value instanceof Uint8Array) || value.length > LIMIT || !id(ref)) throw Error('MALFORMED');
    const aad = domain(kind + '/header',h);
    const plaintext = new Uint8Array(value);
    const encrypted = kind === 'content' ? await provider.encrypt(ref,plaintext,aad) : await provider.wrap(h.recipientDevice,ref,aad);
    if (!(encrypted instanceof Uint8Array) || encrypted.length < 16 || encrypted.length > LIMIT + 256) throw Error('MALFORMED');
    const unsigned = {kind,header:h,encrypted:hex(encrypted)};
    const signature = await provider.sign(signingKeyRef ?? (kind === 'content' ? h.authorDevice : h.senderDevice),domain(kind + '/signature',unsigned));
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw Error('MALFORMED');
    const encoded = bytes({...unsigned,signature:hex(signature)});
    if (encoded.length > ENCODED_LIMIT) throw Error('TOO_LARGE');
    return {id:await candidateObjectId(provider,encoded),bytes:encoded};
  }
  async function open(kind, input, signingKeyRefs) {
    if (!(input instanceof Uint8Array)) throw Error('MALFORMED');
    if (input.length > ENCODED_LIMIT) throw Error('TOO_LARGE');
    input = new Uint8Array(input); // Buffer.slice() aliases; copy before any asynchronous boundary.
    let record;
    try { record = JSON.parse(decoder.decode(input)); } catch { throw Error('MALFORMED'); }
    if (!exact(record,['kind','header','encrypted','signature']) || record.kind !== kind) throw Error('MALFORMED');
    const h = validateHeader(kind,record.header);
    const encrypted = unhex(record.encrypted,16,LIMIT+256), signature = unhex(record.signature,64,64);
    const unsigned = {kind,header:h,encrypted:record.encrypted};
    // Canonical roundtrip also rejects duplicate JSON keys, whitespace and alternate encodings.
    const canonical = bytes({...unsigned,signature:record.signature});
    if (hex(canonical) !== hex(input)) throw Error('MALFORMED');
    const signer=kind === 'content' ? h.authorDevice : h.senderDevice;
    const signingKeyRef=signingKeyRefs === undefined ? signer : Object.hasOwn(signingKeyRefs,signer) ? signingKeyRefs[signer] : null;
    if (!id(signingKeyRef)) throw Error('INVALID_AUTHORITY');
    if (!await provider.verify(signingKeyRef,domain(kind + '/signature',unsigned),signature)) throw Error('INVALID_PROOF');
    const aad = domain(kind + '/header',h);
    const value = kind === 'content' ? await provider.decrypt(h,encrypted,aad) : await provider.unwrap(h,encrypted,aad);
    if (kind === 'content' ? !(value instanceof Uint8Array) : !id(value)) throw Error('INVALID_PROOF');
    if (kind === 'content' && value.length > LIMIT) throw Error('TOO_LARGE');
    return {header:h,value,object:{id:await candidateObjectId(provider,input),bytes:new Uint8Array(input)}};
  }
  return {sealContent:(h,p,r,k)=>seal('content',h,p,r,k), wrapKey:(h,r)=>seal('key',h,new Uint8Array(),r), openContent:(b,keys)=>open('content',b,keys), openKey:b=>open('key',b)};
}
