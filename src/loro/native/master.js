import {NativeModules} from 'react-native';
import sodium from './sodium';
export function openNativeMaster(namespace) {
 const module=NativeModules.LoroMaster;if(!module)throw Error('NATIVE_MASTER_UNAVAILABLE');
 const alias=id=>JSON.stringify(['creative-cooking/master/v1',namespace,id]);
 const enc=b=>sodium.to_base64(b,sodium.base64_variants.ORIGINAL);
 const dec=s=>sodium.from_base64(s,sodium.base64_variants.ORIGINAL);
 return {exists:id=>module.exists(alias(id)),ensure:id=>module.ensure(alias(id)),provision:id=>module.provision(alias(id)),wrap:async(id,p,a)=>dec(await module.wrap(alias(id),enc(p),enc(a))),unwrap:async(id,p,a)=>dec(await module.unwrap(alias(id),enc(p),enc(a))),close:()=>{}};
}
