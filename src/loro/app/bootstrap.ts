import {open} from '@op-engineering/op-sqlite';
import {randomUUID} from 'expo-crypto';
import {NativeModules} from 'react-native';
import sodium from '../native/sodium';
import {openNativeMaster} from '../native/master';
import {LoroDoc,decodeImportBlobMeta} from '../native/loro';
import {openNativeWorkspaceWith} from '../native/bootstrap-core.mjs';

export async function openLocalWorkspace(name:string,create=false) {
 const openDirect = NativeModules.WebRTCModule
  ? async (options:Parameters<typeof import('../native/cooking-direct').openNativeCookingDirect>[0]) => {
     const {openNativeCookingDirect} = await import('../native/cooking-direct');
     return openNativeCookingDirect(options);
    }
  : undefined;
 return openNativeWorkspaceWith({
  name,create,sodium,LoroDoc,decodeImportBlobMeta,openMaster:openNativeMaster,randomUUID,
  openDirect,openDatabase:(id:string)=>open({name:`loro-native-${id}.sqlite`})
 });
}
