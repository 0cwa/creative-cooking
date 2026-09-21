import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { ProviderId } from '@/domain/types';

const LEGACY_OPENROUTER_KEY = 'creative-cooking-openrouter-key';

function storageKey(providerId: ProviderId): string {
  return providerId === 'openrouter'
    ? LEGACY_OPENROUTER_KEY
    : `creative-cooking-${providerId}-key`;
}

function getWebStorage(): Storage | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return window.localStorage;
}

export async function getProviderKey(providerId: ProviderId): Promise<string | null> {
  const key = storageKey(providerId);
  const web = getWebStorage();
  if (web) return web.getItem(key);
  return SecureStore.getItemAsync(key);
}

export async function setProviderKey(providerId: ProviderId, value: string): Promise<void> {
  const key = storageKey(providerId);
  const web = getWebStorage();
  if (web) {
    web.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function clearProviderKey(providerId: ProviderId): Promise<void> {
  const key = storageKey(providerId);
  const web = getWebStorage();
  if (web) {
    web.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

// Compatibility helpers keep OpenRouter OAuth/share code isolated from the generic vault.
export function getOpenRouterKey(): Promise<string | null> {
  return getProviderKey('openrouter');
}

export function setOpenRouterKey(value: string): Promise<void> {
  return setProviderKey('openrouter', value);
}

export function clearOpenRouterKey(): Promise<void> {
  return clearProviderKey('openrouter');
}
