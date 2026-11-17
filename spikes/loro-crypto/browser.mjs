import { rngProbe } from './rng-test.mjs';
import { recoveryProbe } from './recovery-test.mjs';
import { ceremonyProbe } from './ceremony-test.mjs';
import sodium from 'libsodium-wrappers';
import { run } from './probe.mjs';
import { sealedProbe } from './sealed.mjs';
window.probeResult = Promise.all([run(), sealedProbe(sodium), ceremonyProbe(sodium), recoveryProbe()]).then(([components,sealed,ceremony,recovery]) => { const result={rng:rngProbe(),components,sealed,ceremony,recovery}; document.body.textContent = JSON.stringify(result); return result; }).catch(error => { document.body.textContent = error.stack; throw error; });
