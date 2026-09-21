import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

function nativeOnly(): void {
  if (Platform.OS === 'web') {
    throw new Error('This file transfer action is only available in the native app.');
  }
}

export async function shareNativeBackup(json: string): Promise<void> {
  nativeOnly();

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('The system share sheet is unavailable on this device.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File(Paths.cache, `creative-cooking-backup-${timestamp}.json`);
  file.create({ overwrite: true });
  file.write(json);

  await Sharing.shareAsync(file.uri, {
    dialogTitle: 'Share Creative Cooking backup',
    mimeType: 'application/json',
    UTI: 'public.json'
  });
}

export async function pickNativeBackup(): Promise<string | null> {
  nativeOnly();

  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/json', 'text/plain'],
    copyToCacheDirectory: true,
    multiple: false
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) throw new Error('No backup file was selected.');

  const file = new File(asset.uri);
  return file.text();
}
