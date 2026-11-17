import { rngProbe } from './rng-test.mjs';
import { recoveryProbe } from './recovery-test.mjs';
import { ceremonyProbe } from './ceremony-test.mjs';
import sodium from 'libsodium-wrappers';
import { run } from './probe.mjs';
import { sealedProbe } from './sealed.mjs';
console.log(JSON.stringify({rng:rngProbe(), components:await run(), sealed:await sealedProbe(sodium), ceremony:await ceremonyProbe(sodium), recovery:await recoveryProbe()}, null, 2));
