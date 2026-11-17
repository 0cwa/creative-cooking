import { rngProbe } from './rng-test.mjs';
import { recoveryProbe } from './recovery-test.mjs';
import { ceremonyProbe } from './ceremony-test.mjs';
import * as sodium from 'react-native-libsodium';
import { run as components } from './probe.mjs';
import { sealedProbe } from './sealed.mjs';
export async function run() { return { rng: rngProbe(), components: await components(), sealed: await sealedProbe(sodium), ceremony: await ceremonyProbe(sodium), recovery: await recoveryProbe() }; }
