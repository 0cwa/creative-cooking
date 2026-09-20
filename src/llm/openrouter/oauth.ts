import { Platform } from 'react-native';
import { setOpenRouterKey } from '@/storage/credentialVault';

const VERIFIER_KEY = 'creative-cooking-openrouter-pkce-verifier';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function beginOpenRouterOAuth(): Promise<void> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    throw new Error('OpenRouter OAuth is currently available in the web/PWA build. Use an API key on native for now.');
  }

  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  window.sessionStorage.setItem(VERIFIER_KEY, verifier);
  const base = process.env.EXPO_PUBLIC_BASE_URL ?? '';
  const callback = `${window.location.origin}${base || ''}/`;
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', callback);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(url.toString());
}

export async function finishOpenRouterOAuthFromLocation(): Promise<boolean> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;
  const verifier = window.sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('OpenRouter sign-in verifier was lost. Please connect again.');

  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256'
    })
  });
  const data = (await response.json()) as { key?: string; error?: { message?: string } };
  if (!response.ok || !data.key) throw new Error(data.error?.message ?? 'Could not finish OpenRouter sign-in.');
  await setOpenRouterKey(data.key);
  window.sessionStorage.removeItem(VERIFIER_KEY);
  window.history.replaceState({}, document.title, `${window.location.origin}${window.location.pathname}`);
  return true;
}
