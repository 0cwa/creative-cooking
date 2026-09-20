import { Platform } from 'react-native';
import { setOpenRouterKey } from '@/storage/credentialVault';

const SHARE_SESSION_KEY = 'creative-cooking-openrouter-share-v1';
const OPENROUTER_PREFIX = 'sk-or-v1-';

function reverse(value: string): string {
  return Array.from(value).reverse().join('');
}

export function obfuscateOpenRouterKey(apiKey: string): string {
  const key = apiKey.trim();
  if (!key.startsWith(OPENROUTER_PREFIX)) {
    throw new Error('Only standard OpenRouter keys can be shared this way.');
  }

  // This is intentionally only obfuscation, not encryption. Stripping the known
  // prefix makes the URL shorter; reversing the high-entropy body prevents naive
  // scrapers that look for "sk-or-" from recognizing it.
  return reverse(key.slice(OPENROUTER_PREFIX.length));
}

export function deobfuscateOpenRouterKey(payload: string): string {
  const value = payload.trim();
  if (!value) throw new Error('This OpenRouter share link is empty.');

  // Keep compatibility with old/manual links containing the complete key.
  if (value.startsWith('sk-or-')) return value;

  return `${OPENROUTER_PREFIX}${reverse(value)}`;
}

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

  const apiKey = deobfuscateOpenRouterKey(payload);
  if (!apiKey.startsWith('sk-or-')) {
    throw new Error('The shared credential did not contain a valid OpenRouter key.');
  }

  await setOpenRouterKey(apiKey);
  return true;
}
