import {open} from '@op-engineering/op-sqlite';
import {randomUUID} from 'expo-crypto';
import {NativeModules} from 'react-native';
import sodium from '../native/sodium';
import {openNativeMaster} from '../native/master';
import {LoroDoc,decodeImportBlobMeta} from '../native/loro';
import {openNativeWorkspaceWith} from '../native/bootstrap-core.mjs';

export async function openLocalWorkspace(name:string,create=false) {
 const direct = NativeModules.WebRTCModule ? (await import('../native/cooking-direct')).openNativeCookingDirect : undefined;
 return openNativeWorkspaceWith({
  name,create,sodium,LoroDoc,decodeImportBlobMeta,openMaster:openNativeMaster,randomUUID,
  openDirect:direct,openDatabase:(id:string)=>open({name:`loro-native-${id}.sqlite`})
 });
}
