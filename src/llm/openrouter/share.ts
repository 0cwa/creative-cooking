import { Platform } from 'react-native';
import { setOpenRouterKey } from '@/storage/credentialVault';

const SHARE_SESSION_KEY = 'creative-cooking-openrouter-share-v1';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function createOpenRouterShareLink(apiKey: string): Promise<string> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    throw new Error('Provider share links are currently available in the web/PWA build.');
  }
  if (!apiKey.trim()) throw new Error('No OpenRouter key is connected.');

  const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', encryptionKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(apiKey.trim());
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, encryptionKey, toArrayBuffer(plaintext))
  );

  const payload = `v1.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
  const base = process.env.EXPO_PUBLIC_BASE_URL ?? '';
  const url = new URL(`${window.location.origin}${base || ''}/`);
  url.searchParams.set('ort', payload);
  url.hash = new URLSearchParams({ ortk: base64UrlEncode(rawKey) }).toString();
  return url.toString();
}

export async function importSharedOpenRouterKey(): Promise<boolean> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;

  const stored = window.sessionStorage.getItem(SHARE_SESSION_KEY);
  if (!stored) return false;
  window.sessionStorage.removeItem(SHARE_SESSION_KEY);

  const parsed = JSON.parse(stored) as { payload?: string; key?: string | null };
  const payload = parsed.payload?.trim();
  if (!payload) return false;

  // Compatibility for manually constructed ?ort=sk-or-... links. Generated links
  // are encrypted and should be preferred because the raw token is otherwise part
  // of the initial HTTP request URL.
  if (payload.startsWith('sk-or-') && !parsed.key) {
    await setOpenRouterKey(payload);
    return true;
  }

  const [version, ivPart, ciphertextPart] = payload.split('.');
  if (version !== 'v1' || !ivPart || !ciphertextPart || !parsed.key) {
    throw new Error('This OpenRouter share link is invalid or incomplete.');
  }

  const rawKey = base64UrlDecode(parsed.key);
  const iv = base64UrlDecode(ivPart);
  const ciphertext = base64UrlDecode(ciphertextPart);
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext)
  );
  const apiKey = new TextDecoder().decode(plaintext).trim();
  if (!apiKey.startsWith('sk-or-')) throw new Error('The shared credential did not contain a valid OpenRouter key.');

  await setOpenRouterKey(apiKey);
  return true;
}
