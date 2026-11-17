import {open} from '@op-engineering/op-sqlite';
import sodium from '../native/sodium';
import {openNativeMaster} from '../native/master';
import {LoroDoc,decodeImportBlobMeta} from '../native/loro';
import {openNativeWorkspaceWith} from '../native/bootstrap-core.mjs';

/** Android candidate; the app must include the native module and binding dependencies. */
export function openLocalWorkspace(name:string,create=false):Promise<any> {
 return openNativeWorkspaceWith({name,create,sodium,LoroDoc,decodeImportBlobMeta,openMaster:openNativeMaster,openDatabase:(id:string)=>open({name:`loro-native-${id}.sqlite`})});
}
