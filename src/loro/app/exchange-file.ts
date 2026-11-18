import {randomUUID} from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import {Directory,File,FileMode,Paths} from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function chooseExchangeFile({accept,minBytes,maxBytes}:{accept:string[];minBytes:number;maxBytes:number}) {
  const result = await DocumentPicker.getDocumentAsync({type:accept,multiple:false,copyToCacheDirectory:false});
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset.size !== undefined && (asset.size < minBytes || asset.size > maxBytes)) throw Error('INVALID_FILE_SIZE');
  const handle = new File(asset.uri).open(FileMode.ReadOnly);
  try {
    const bytes = handle.readBytes(maxBytes + 1);
    if (bytes.length < minBytes || bytes.length > maxBytes) throw Error('INVALID_FILE_SIZE');
    return bytes;
  } finally {
    handle.close();
  }
}

export async function saveExchangeFile(name:string, mimeType:string, bytes:Uint8Array) {
  if (!await Sharing.isAvailableAsync()) throw Error('FILE_SHARING_UNAVAILABLE');
  const directory = new Directory(Paths.cache, `cooking-share-${randomUUID()}`);
  directory.create();
  const file = new File(directory, name);
  file.create();
  file.write(bytes);
  // The receiving app may read its URI after the share chooser closes.
  await Sharing.shareAsync(file.uri, {mimeType,dialogTitle:'Share cooking exchange file'});
}
