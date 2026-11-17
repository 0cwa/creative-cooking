import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { split, combine } from 'shamir-secret-sharing';

const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g) || [], x => parseInt(x, 16));
const utf8 = s => new TextEncoder().encode(s);
const eq = (a,b) => hex(a) === hex(b);
function assert(v, m) { if (!v) throw Error(m); }
function rejects(fn, m) { try { fn(); } catch { return; } throw Error('accepted ' + m); }
function random(n, source = globalThis.crypto) { if (!source || typeof source.getRandomValues !== 'function') throw Error('secure RNG unavailable'); return source.getRandomValues(new Uint8Array(n)); }
const seal = (key, nonce, data, aad) => xchacha20poly1305(key, nonce, aad).encrypt(data);
const open = (key, nonce, data, aad) => xchacha20poly1305(key, nonce, aad).decrypt(data);
const derive = (secret, context) => hkdf(sha256, secret, utf8('K1 component probe salt'), utf8(context), 32);
export async function run() {
 const checks = [];
 const test = (name, fn) => { fn(); checks.push(name); };
 const seed = unhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
 const pub = unhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
 const signature = unhex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'+'5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
 test('RFC 8032 Ed25519 vector', () => { assert(eq(ed25519.getPublicKey(seed),pub),'public key'); assert(eq(ed25519.sign(new Uint8Array(),seed),signature),'signature'); assert(ed25519.verify(signature,new Uint8Array(),pub),'verify'); });
 test('signature corruption',()=> { const s=signature.slice(); s[0]^=1; assert(!ed25519.verify(s,new Uint8Array(),pub),'bad signature'); });
 const a=unhex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
 const b=unhex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
 const ap=x25519.getPublicKey(a), bp=x25519.getPublicKey(b), shared=x25519.getSharedSecret(a,bp);
 test('RFC 7748 X25519 vector',()=> { assert(hex(ap)==='8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a','public'); assert(hex(shared)==='4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742','shared'); assert(eq(shared,x25519.getSharedSecret(b,ap)),'agreement'); });
 test('fixed XChaCha20-Poly1305 cross-runtime fixture',()=> { const result=seal(new Uint8Array(32),new Uint8Array(24),utf8('K1 vector'),utf8('K1 AAD')); assert(hex(result)==='33afb6ff8043f910ab0d80ae8bb89ad07e7d7ec0d42a50c374','ciphertext'); });
 const key=derive(shared,'wrap/v1'), nonce=random(24), data=random(32), aad=utf8('owner=alice;scope=personal;generation=1');
 const box=seal(key,nonce,data,aad);
 test('X25519 HKDF XChaCha key envelope',()=>assert(eq(open(derive(x25519.getSharedSecret(b,ap),'wrap/v1'),nonce,box,aad),data),'unwrap'));
 test('AEAD wrong key, context, tag and truncated ciphertext',()=> { const bad=box.slice(); bad[0]^=1; for(const f of [()=>open(random(32),nonce,box,aad),()=>open(key,nonce,box,utf8('other')),()=>open(key,nonce,bad,aad),()=>open(key,nonce,box.slice(0,10),aad),()=>open(derive(shared,'wrong-domain'),nonce,box,aad)]) rejects(f,'invalid envelope'); });
 test('RNG absent fails closed',()=>rejects(()=>random(32,null),'missing RNG'));
 const recovery=random(32), rn=random(24), rad=utf8('recovery/v1;owner=alice;scope=personal;generation=1;threshold=1;holder=alice;index=1');
 const wrapped=seal(recovery,rn,data,rad);
 test('one holder authenticated recovery envelope',()=> { assert(eq(open(recovery,rn,wrapped,rad),data),'recovery'); rejects(()=>open(recovery,rn,wrapped,utf8('recovery/v1;owner=bob')),'wrong owner'); });
 const shares=await split(recovery,3,2); const restored=await combine([shares[0],shares[2]]);
 test('2-of-3 Shamir and authenticated reconstruction',()=> { assert(eq(open(restored,rn,wrapped,rad),data),'reconstruction'); });
 const altered=shares[0].slice(); altered[0]^=1;
 let alteredRejected=false; try { const wrong=await combine([altered,shares[2]]); try { open(wrong,rn,wrapped,rad); } catch { alteredRejected=true; } } catch { alteredRejected=true; } assert(alteredRejected,'altered share accepted');
 checks.push('altered share rejected or fails authentication');
 for (const bad of [[shares[0]],[shares[0],shares[0]],[shares[0].slice(0,2),shares[1]]]) { let rejected=false; try { const candidate=await combine(bad); try { open(candidate,rn,wrapped,rad); } catch { rejected=true; } } catch { rejected=true; } assert(rejected,'invalid shares accepted'); }
 checks.push('insufficient, duplicate and truncated shares rejected or fail authentication');
 return {checks, lengths:{ed25519Public:pub.length,signature:signature.length,x25519Public:ap.length,shared:shared.length,nonce:nonce.length,tag:box.length-data.length}, features:{getRandomValues:typeof globalThis.crypto?.getRandomValues,subtle:typeof globalThis.crypto?.subtle,wasm:typeof globalThis.WebAssembly} };
}
