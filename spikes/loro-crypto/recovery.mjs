import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { split, combine } from 'shamir-secret-sharing';
const enc = v => new TextEncoder().encode(JSON.stringify(v));
const aad = (m,h,i) => enc(['K1-recovery-v1',m.owner,m.scope,m.generation,m.threshold,m.holders.length,h,i]);
function validate(m) {
 if (!m || typeof m.owner !== 'string' || !m.owner || m.scope !== 'personal' || !Number.isSafeInteger(m.generation) || m.generation < 1 || !Array.isArray(m.holders) || m.holders.length < 1 || m.holders.length > 255 || m.holders.some(h=>typeof h!=='string'||!h) || new Set(m.holders).size !== m.holders.length || !Number.isInteger(m.threshold) || m.threshold<1 || m.threshold>m.holders.length || (m.threshold===1 && m.holders.length!==1)) throw Error('invalid recovery metadata');
}
const random = n => { if(typeof globalThis.crypto?.getRandomValues !== 'function') throw Error('secure RNG unavailable'); return crypto.getRandomValues(new Uint8Array(n)); };
export async function createRecovery(m, holderKeys, data) {
 validate(m); const recovery=random(32), shares=m.threshold===1?[recovery]:await split(recovery,m.holders.length,m.threshold);
 const payloadNonce=random(24), payload=xchacha20poly1305(recovery,payloadNonce,enc(['K1-payload-v1',m.owner,m.scope,m.generation,m.threshold,m.holders])).encrypt(data);
 const envelopes=m.holders.map((holder,index)=>{const nonce=random(24), key=holderKeys[holder]; if(!(key instanceof Uint8Array)||key.length!==32) throw Error('holder key'); return {holder,index:index+1,nonce,box:xchacha20poly1305(key,nonce,aad(m,holder,index+1)).encrypt(shares[index])};});
 return {payloadNonce,payload,envelopes};
}
export async function recover(m,pkg,selected,holderKeys) {
 validate(m); if (!Array.isArray(selected) || selected.length < m.threshold || selected.length > m.holders.length || new Set(selected).size !== selected.length) throw Error('insufficient or duplicate holders');
 const shares=selected.map(holder=>{ const index=m.holders.indexOf(holder)+1; if(!index) throw Error('unknown holder'); const found=pkg.envelopes.filter(e=>e.holder===holder); if(found.length!==1 || found[0].index!==index) throw Error('invalid holder envelope'); const e=found[0], key=holderKeys[holder]; if(!(key instanceof Uint8Array)||key.length!==32) throw Error('holder key'); return xchacha20poly1305(key,e.nonce,aad(m,holder,index)).decrypt(e.box); });
 const recovery=m.threshold===1?shares[0]:await combine(shares);
 return xchacha20poly1305(recovery,pkg.payloadNonce,enc(['K1-payload-v1',m.owner,m.scope,m.generation,m.threshold,m.holders])).decrypt(pkg.payload);
}
