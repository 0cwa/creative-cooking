import { rngProbe } from './rng-test.mjs';
import { recoveryProbe } from './recovery-test.mjs';
import { ceremonyProbe } from './ceremony-test.mjs';
import sodium from 'libsodium-wrappers';
import { run } from './probe.mjs';
import { sealedProbe } from './sealed.mjs';
window.probeResult = Promise.all([run(), sealedProbe(sodium), ceremonyProbe(sodium), recoveryProbe()]).then(([components,sealed,ceremony,recovery]) => { const result={rng:rngProbe(),components,sealed,ceremony,recovery}; document.body.textContent = JSON.stringify(result); return result; }).catch(error => { document.body.textContent = error.stack; throw error; });
// Manual exchange bridge for the isolated runtime fixture; test keys and messages only.
window.k1Exchange = async (operation, value) => {
 await sodium.ready;
 const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
 const unhex = text => Uint8Array.from(text.match(/../g), x => parseInt(x,16));
 const key = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(7));
 if (operation === 'seal') return hex(sodium.crypto_box_seal(new TextEncoder().encode('K1 sealed box cross-runtime fixture'),key.publicKey));
 if (operation === 'open') return new TextDecoder().decode(sodium.crypto_box_seal_open(unhex(value),key.publicKey,key.privateKey));
 throw Error('unknown exchange operation');
};
