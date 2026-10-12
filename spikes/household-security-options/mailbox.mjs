// Disposable protocol fixture. Not reviewed, not a production encryption format.
import { webcrypto, createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const { subtle } = webcrypto;
const fields = ['version', 'household', 'author', 'epoch', 'message', 'nonce', 'ciphertext', 'signature'];
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const bytes = value => Buffer.from(value, 'base64url');
const header = frame => ({ version: frame.version, household: frame.household, author: frame.author,
  epoch: frame.epoch, message: frame.message, nonce: frame.nonce });
const encode = value => Buffer.from(JSON.stringify(value));
const signed = frame => encode({ ...header(frame), ciphertext: frame.ciphertext });

export const groupKey = () => subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
export const deviceKeys = () => subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);

export async function encryptFrame({ household, author, epoch, plaintext, key, signer }) {
  const frame = { version: 1, household, author, epoch, message: webcrypto.randomUUID(),
    nonce: b64(webcrypto.getRandomValues(new Uint8Array(12))) };
  frame.ciphertext = b64(await subtle.encrypt({ name: 'AES-GCM', iv: bytes(frame.nonce),
    additionalData: encode(header(frame)), tagLength: 128 }, key, plaintext));
  frame.signature = b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, signed(frame)));
  return frame;
}

function validateShape(frame) {
  if (!frame || Object.keys(frame).length !== fields.length || fields.some(field => !Object.hasOwn(frame, field)))
    throw new Error('Frame fields denied');
  if (frame.version !== 1 || !Number.isSafeInteger(frame.epoch) || frame.epoch < 1) throw new Error('Version or epoch denied');
  for (const field of ['household', 'author', 'message']) {
    if (typeof frame[field] !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(frame[field])) throw new Error('Identifier denied');
  }
  for (const field of ['nonce', 'ciphertext', 'signature']) {
    if (typeof frame[field] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(frame[field])) throw new Error('Encoding denied');
  }
  if (bytes(frame.nonce).length !== 12 || bytes(frame.signature).length !== 64
    || bytes(frame.ciphertext).length < 16 || bytes(frame.ciphertext).length > 1024 * 1024)
    throw new Error('Frame size denied');
}

export async function decryptFrame(frame, key, signer) {
  validateShape(frame);
  if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signer, bytes(frame.signature), signed(frame)))
    throw new Error('Signature denied');
  return Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: bytes(frame.nonce),
    additionalData: encode(header(frame)), tagLength: 128 }, key, bytes(frame.ciphertext)));
}

// Policy is trusted input in this fixture. No account auth, invitation, capability,
// group-key envelopes, policy distribution or concurrent admin changes are implemented.
export class Mailbox {
  constructor(root, policies) { this.root = root; this.policies = policies; }
  async authorize(household, author, epoch) {
    const policy = this.policies.get(household);
    if (!policy || !policy.writers.has(author) || policy.epoch !== epoch) throw new Error('Household membership or epoch denied');
    return policy.writers.get(author);
  }
  async receive(scope, frame, { failBeforeCommit = false } = {}) {
    validateShape(frame);
    if (scope !== frame.household) throw new Error('Routing denied');
    const signer = await this.authorize(scope, frame.author, frame.epoch);
    if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signer, bytes(frame.signature), signed(frame)))
      throw new Error('Signature denied');
    const encoded = encode(frame);
    const digest = createHash('sha256').update(encoded).digest('hex');
    const directory = join(this.root, scope);
    await mkdir(directory, { recursive: true });
    const parent = await open(this.root, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    const destination = join(directory, `${frame.message}.json`);
    try {
      const existing = await readFile(destination);
      if (!existing.equals(encoded)) throw new Error('Message ID reused');
      return { message: frame.message, digest, durable: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Single writer only: serialization and durable policy are explicit missing gates.
    const temporary = join(directory, `.${webcrypto.randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
    try {
      if (failBeforeCommit) throw new Error('Injected storage failure');
      await rename(temporary, destination);
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) { await rm(temporary, { force: true }); throw error; }
    return { message: frame.message, digest, durable: true };
  }
  async read(scope, author, message) {
    const policy = this.policies.get(scope);
    if (!policy || !policy.readers.has(author)) throw new Error('Reader denied');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(message)) throw new Error('Message identifier denied');
    return JSON.parse(await readFile(join(this.root, scope, `${message}.json`), 'utf8'));
  }
}
