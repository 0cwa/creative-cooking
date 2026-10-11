// Runs unchanged in an ordinary static browser and Node 22.
// This tests a plaintext-blind HTTP mailbox, NOT browser p2panda/Iroh.
const SPACE_RE = /^[0-9a-f]{32,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
function asBytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
  return value;
}
async function aesKey(raw, usage) {
  if (asBytes(raw).length !== 32) throw new Error('Expected 256-bit space key');
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

export async function seal(plaintext, spaceKey) {
  asBytes(plaintext);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await aesKey(spaceKey, 'encrypt'), plaintext));
  const output = new Uint8Array(1 + iv.length + ciphertext.length);
  output[0] = 1;
  output.set(iv, 1);
  output.set(ciphertext, 13);
  return output;
}
export async function open(ciphertext, spaceKey) {
  asBytes(ciphertext);
  if (ciphertext.length < 30 || ciphertext[0] !== 1) throw new Error('Invalid ciphertext header');
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ciphertext.slice(1, 13) },
    await aesKey(spaceKey, 'decrypt'), ciphertext.slice(13));
  return new Uint8Array(plain);
}
export async function sha256hex(bytes) {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', asBytes(bytes))))
    .map(x => x.toString(16).padStart(2, '0')).join('');
}
function path(base, spaceId, id = '') {
  if (!SPACE_RE.test(spaceId) || (id && !HASH_RE.test(id))) throw new Error('Invalid space/frame ID');
  return base.replace(/\/$/, '') + '/v1/spaces/' + spaceId + '/frames' + (id ? '/' + id : '');
}
export async function upload(baseUrl, spaceId, ciphertext) {
  const id = await sha256hex(ciphertext);
  const response = await fetch(path(baseUrl, spaceId, id), {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: ciphertext
  });
  if (!response.ok) throw new Error('Gateway upload HTTP ' + response.status);
  return id;
}
export async function catchUp(baseUrl, spaceId, spaceKey) {
  const list = await fetch(path(baseUrl, spaceId));
  if (!list.ok) throw new Error('Gateway list HTTP ' + list.status);
  const ids = await list.json();
  if (!Array.isArray(ids)) throw new Error('Invalid gateway index');
  const result = [];
  for (const id of ids) {
    const response = await fetch(path(baseUrl, spaceId, id));
    if (!response.ok) throw new Error('Gateway download HTTP ' + response.status);
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    if (await sha256hex(ciphertext) !== id) throw new Error('Gateway frame corrupted');
    result.push({ id, bytes: await open(ciphertext, spaceKey) });
  }
  return result;
}
