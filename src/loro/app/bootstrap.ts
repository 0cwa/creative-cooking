import {open} from '@op-engineering/op-sqlite';
import {randomUUID} from 'expo-crypto';
import {NativeModules} from 'react-native';
import sodium from '../native/sodium';
import {openNativeMaster} from '../native/master';
import {LoroDoc,decodeImportBlobMeta} from '../native/loro';
import {openNativeWorkspaceWith,returnToOriginalNativeWorkspaceWith} from '../native/bootstrap-core.mjs';

const nativeStorage = {
 sodium,LoroDoc,decodeImportBlobMeta,openMaster:openNativeMaster,
 openDatabase:(id:string)=>open({name:`loro-native-${id}.sqlite`})
};

export async function openLocalWorkspace(name:string,create=false,policy?:unknown) {
 const openDirect = NativeModules.WebRTCModule
  ? async (options:Parameters<typeof import('../native/cooking-direct').openNativeCookingDirect>[0]) => {
     const {openNativeCookingDirect} = await import('../native/cooking-direct');
     return openNativeCookingDirect(options);
    }
  : undefined;
 return openNativeWorkspaceWith({
  ...nativeStorage,name,create,policy,randomUUID,openDirect
 });
}

export const returnToOriginalLocalWorkspace = (name:string) => returnToOriginalNativeWorkspaceWith({...nativeStorage,name});
