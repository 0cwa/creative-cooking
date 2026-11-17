import AsyncStorage from '@react-native-async-storage/async-storage';
import sodium from './sodium';
import {openLocalWorkspace} from '../app/bootstrap';
import {createNativeChoiceStore} from './choice-core.mjs';
/** Workspace names only: private material remains in the wrapped key catalog. */
export const nativeChoiceStore=createNativeChoiceStore({read:(k:string)=>AsyncStorage.getItem(k),write:(k:string,v:string)=>AsyncStorage.setItem(k,v),random:()=>sodium.to_hex(sodium.randombytes_buf(16)),openWorkspace:openLocalWorkspace}) as {open:()=>Promise<any|null>;create:()=>Promise<any>};
