import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
const utf8 = s => new TextEncoder().encode(s);
const hex = x => Array.from(x,b=>b.toString(16).padStart(2,'0')).join('');
const unhex = s => { if (typeof s !== 'string' || !/^[0-9a-f]{64}$/.test(s)) throw Error('invalid key'); return Uint8Array.from(s.match(/../g),x=>parseInt(x,16)); };
const encode = x => utf8(JSON.stringify(x));
const equal = (a,b) => a === b;
// Fixed ordered tuple: canonical only for this deliberately bounded local fixture.
export function commitment(c) {
 const roles=['initiator','responder'];
 if (!c || !['own-device','invite'].includes(c.action) || !roles.every(r=>c[r]) || !Array.isArray(c.transcript) || c.transcript.length>64 || c.transcript.some(x=>typeof x!=='string'||x.length>4096)) throw Error('invalid ceremony');
 for (const x of [c.household,c.parent]) if(typeof x!=='string'||!x||x.length>1024) throw Error('invalid context');
 for (const r of roles) { unhex(c[r].sign); unhex(c[r].wrap); unhex(c[r].nonce); }
 return hex(sha256(encode(['K1-ceremony-v1', c.household,c.action,c.parent,...roles.map(r=>[r,c[r].sign,c[r].wrap,c[r].nonce]),c.transcript])));
}
export const confirmation = (hash, role, secret) => ed25519.sign(encode(['K1-confirm-v1',role,hash]),secret);
export const acknowledgement = (hash, role, challenge, secret) => ed25519.sign(encode(['K1-possession-v1',role,hash,challenge]),secret);
export async function accept({ceremony, pins, confirmations, challenges, acknowledgements, possession, authority, persist}) {
 const hash=commitment(ceremony);
 if (typeof possession !== 'function' || typeof authority !== 'function' || typeof persist !== 'function') throw Error('missing hooks');
 for (const role of ['initiator','responder']) {
  if (!equal(pins?.[role],hash)) throw Error('out-of-band ceremony mismatch');
  const pk=unhex(ceremony[role].sign);
  if (!confirmations?.[role] || !ed25519.verify(confirmations[role],encode(['K1-confirm-v1',role,hash]),pk)) throw Error('confirmation');
  const challenge=challenges?.[role];
  if (typeof challenge !== 'string' || !/^[0-9a-f]{64}$/.test(challenge) || !acknowledgements?.[role] || !ed25519.verify(acknowledgements[role],encode(['K1-possession-v1',role,hash,challenge]),pk)) throw Error('possession');
 }
 // Hooks are placeholders for externally verified sealed-box challenges, policy, and durable atomic replay protection.
 if (!(await possession(ceremony,hash,challenges))) throw Error('possession denied');
 if (!(await authority(ceremony,hash))) throw Error('authority denied');
 if (!(await persist(hash))) throw Error('replay or persistence failed');
 return { releasePermitted: true, ceremony: hash };
}
