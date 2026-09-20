import { Platform } from 'react-native';
import { setOpenRouterKey } from '@/storage/credentialVault';
import { deobfuscateOpenRouterKey, obfuscateOpenRouterKey } from './sharePayload';

export { deobfuscateOpenRouterKey, obfuscateOpenRouterKey } from './sharePayload';

const SHARE_SESSION_KEY = 'creative-cooking-openrouter-share-v1';

export async function createOpenRouterShareLink(apiKey: string): Promise<string> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    throw new Error('Provider share links are currently available in the web/PWA build.');
  }

  const base = process.env.EXPO_PUBLIC_BASE_URL ?? '';
  const url = new URL(`${window.location.origin}${base || ''}/`);
  url.searchParams.set('ort', obfuscateOpenRouterKey(apiKey));
  return url.toString();
}

export async function importSharedOpenRouterKey(): Promise<boolean> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;

  const payload = window.sessionStorage.getItem(SHARE_SESSION_KEY);
  if (!payload) return false;
  window.sessionStorage.removeItem(SHARE_SESSION_KEY);

  await setOpenRouterKey(deobfuscateOpenRouterKey(payload));
  return true;
}
