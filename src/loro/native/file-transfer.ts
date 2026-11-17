import * as DocumentPicker from 'expo-document-picker';
import {File,Paths} from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {exportFile,importFile,MAX_OBJECT} from '../transport/adapter.mjs';
import sodium from './sodium';
const MAX_FILE=Math.ceil(MAX_OBJECT/3)*4+2048;
/** Testable file boundary. Authentication is required before returning an object. */
export async function readEncryptedObject(file:File,verifyObject:(bytes:Uint8Array)=>Promise<{id:string;bytes:Uint8Array}>) {
 if(typeof verifyObject!=='function')throw Error('MALFORMED');
 if(!file.exists||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE)throw Error('TOO_LARGE');
 const raw=await file.bytes();if(raw.length>MAX_FILE)throw Error('TOO_LARGE');const envelope=importFile(raw),verified=await verifyObject(new Uint8Array(envelope.bytes));
 if(!verified||verified.id!==envelope.id||!(verified.bytes instanceof Uint8Array)||verified.bytes.length!==envelope.bytes.length||verified.bytes.some((v,i)=>v!==envelope.bytes[i]))throw Error('INVALID_PROOF');
 return envelope;
}
export function writeEncryptedObject(file:File,object:{id:string;bytes:Uint8Array}) {const bytes=exportFile(object);file.create({overwrite:false});file.write(bytes);}
/** The caller supplies a previously encrypted envelope; plaintext is never exported. */
export async function shareEncryptedObject(object:{id:string;bytes:Uint8Array}) {
 if(!(await Sharing.isAvailableAsync()))throw Error('UNAVAILABLE');
 const file=new File(Paths.cache,`creative-cooking-${sodium.to_hex(sodium.randombytes_buf(16))}.json`);
 writeEncryptedObject(file,object);await Sharing.shareAsync(file.uri,{mimeType:'application/json',UTI:'public.json',dialogTitle:'Share encrypted cooking data'});
}
/** Picked input remains untrusted until verifyObject authenticates it. */
export async function pickEncryptedObject({verifyObject}:{verifyObject:(bytes:Uint8Array)=>Promise<{id:string;bytes:Uint8Array}>}) {
 if(typeof verifyObject!=='function')throw Error('MALFORMED');
 const selection=await DocumentPicker.getDocumentAsync({type:['application/json','text/json'],copyToCacheDirectory:true,multiple:false});if(selection.canceled)return null;
 const asset=selection.assets[0];if(!asset)throw Error('MALFORMED');if(asset.size!==undefined&&asset.size>MAX_FILE)throw Error('TOO_LARGE');
 return readEncryptedObject(new File(asset.uri),verifyObject);
}
