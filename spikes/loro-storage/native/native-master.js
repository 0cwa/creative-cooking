// Candidate exposes wrap/unwrap only; the AES master remains in AndroidKeyStore.
import {NativeModules} from 'react-native';
import {sodium} from './native-sodium';
const module=NativeModules.FixtureMaster;
const encode=b=>sodium.to_base64(b,sodium.base64_variants.ORIGINAL);
const decode=s=>sodium.from_base64(s,sodium.base64_variants.ORIGINAL);
export const nativeMaster={
 ensure:id=>module.ensure(id),
 describe:id=>module.describe(id),
 provision:id=>module.provision(id),
 wrap:async(id,plain,aad)=>decode(await module.wrap(id,encode(plain),encode(aad))),
 unwrap:async(id,wrapped,aad)=>decode(await module.unwrap(id,encode(wrapped),encode(aad))),
 close:()=>{},
};
