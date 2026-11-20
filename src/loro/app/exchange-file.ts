import {randomUUID} from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import {Directory,File,FileMode,Paths} from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {pruneExchangeShares} from './exchange-share-cache.mjs';

const maxSharedFileBytes = 16 * 1024 * 1024 + 48;
let sharingFile = false;

export async function chooseExchangeFile({accept,minBytes,maxBytes}:{accept:string[];minBytes:number;maxBytes:number}) {
  const result = await DocumentPicker.getDocumentAsync({type:accept,multiple:false,copyToCacheDirectory:false});
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset.size !== undefined && (asset.size < minBytes || asset.size > maxBytes)) throw Error('INVALID_FILE_SIZE');
  const handle = new File(asset.uri).open(FileMode.ReadOnly);
  try {
    const length = handle.size;
    if (length === null || handle.offset !== 0) throw Error('FILE_READ_UNAVAILABLE');
    if (length === 0 || length < minBytes || length > maxBytes) throw Error('INVALID_FILE_SIZE');
    const bytes = handle.readBytes(length + 1);
    if (bytes.length !== length || handle.offset !== length || handle.size !== length) throw Error('FILE_CHANGED_DURING_READ');
    return bytes;
  } finally {
    handle.close();
  }
}

export async function saveExchangeFile(name:string, mimeType:string, bytes:Uint8Array) {
  if (bytes.length > maxSharedFileBytes) throw Error('INVALID_FILE_SIZE');
  if (sharingFile) throw Error('Another cooking file is being shared.');
  sharingFile = true;
  let directory:Directory|undefined;
  let sharingStarted = false;
  try {
    if (!await Sharing.isAvailableAsync()) throw Error('FILE_SHARING_UNAVAILABLE');
    pruneExchangeShares(Paths.cache.list().filter(entry => entry instanceof Directory), Date.now(), (entry:Directory) => {
      const marker = new File(entry, '.handoff');
      return marker.exists ? marker.modificationTime : null;
    });
    directory = new Directory(Paths.cache, `cooking-share-${randomUUID()}`);
    directory.create();
    const file = new File(directory, name);
    file.create();
    file.write(bytes);
    sharingStarted = true;
    await Sharing.shareAsync(file.uri, {mimeType,dialogTitle:'Share cooking exchange file'});
  } finally {
    try {
      if (directory && sharingStarted) {
        // Start the read grace period when the chooser finishes.
        new File(directory, '.handoff').create();
      } else if (directory?.exists) directory.delete();
    } catch { /* The cache cap still applies if a cleanup fails. */ }
    sharingFile = false;
  }
}
