import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const OPENROUTER_KEY = 'creative-cooking-openrouter-key';

function getWebStorage(): Storage | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return window.localStorage;
}

export async function getOpenRouterKey(): Promise<string | null> {
  const web = getWebStorage();
  if (web) return web.getItem(OPENROUTER_KEY);
  return SecureStore.getItemAsync(OPENROUTER_KEY);
}

export async function setOpenRouterKey(value: string): Promise<void> {
  const web = getWebStorage();
  if (web) {
    web.setItem(OPENROUTER_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(OPENROUTER_KEY, value);
}

export async function clearOpenRouterKey(): Promise<void> {
  const web = getWebStorage();
  if (web) {
    web.removeItem(OPENROUTER_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(OPENROUTER_KEY);
}
