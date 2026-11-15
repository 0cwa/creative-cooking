import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { StoredAccountSession } from './contracts';

const CONFIG_KEY = 'creative-cooking-account-api-url-v1';
const POWERSYNC_CONFIG_KEY = 'creative-cooking-powersync-service-url-v1';
const NATIVE_SESSION_KEY = 'creative-cooking-account-session-v1';
const WEB_DATABASE = 'creative-cooking-account';
const WEB_DATABASE_VERSION = 1;
const WEB_SESSION_STORE = 'session';
const WEB_SESSION_KEY = 'current';

let browserDatabase: Promise<IDBDatabase> | null = null;

function openBrowserDatabase(): Promise<IDBDatabase> {
  if (browserDatabase) return browserDatabase;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('This browser does not provide IndexedDB for secure session storage.'));
  }

  browserDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open(WEB_DATABASE, WEB_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WEB_SESSION_STORE)) {
        database.createObjectStore(WEB_SESSION_STORE);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        browserDatabase = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      browserDatabase = null;
      reject(new Error(`Account session storage could not be opened: ${request.error?.name ?? 'unknown error'}.`));
    };
    request.onblocked = () => {
      browserDatabase = null;
      reject(new Error('Account session storage is blocked by another tab. Close other Creative Cooking tabs and retry.'));
    };
  });
  return browserDatabase;
}

async function readBrowserSession(): Promise<StoredAccountSession | null> {
  const database = await openBrowserDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(WEB_SESSION_STORE, 'readonly');
    const request = transaction.objectStore(WEB_SESSION_STORE).get(WEB_SESSION_KEY);
    request.onsuccess = () => resolve(isStoredSession(request.result) ? request.result : null);
    request.onerror = () => reject(new Error(`Account session could not be read: ${request.error?.name ?? 'unknown error'}.`));
    transaction.onabort = () => reject(new Error(`Account session read was aborted: ${transaction.error?.name ?? 'unknown error'}.`));
  });
}

async function writeBrowserSession(session: StoredAccountSession | null): Promise<void> {
  const database = await openBrowserDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(WEB_SESSION_STORE, 'readwrite');
    const store = transaction.objectStore(WEB_SESSION_STORE);
    if (session) store.put(session, WEB_SESSION_KEY);
    else store.delete(WEB_SESSION_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error(`Account session could not be saved: ${transaction.error?.name ?? 'unknown error'}.`));
    transaction.onabort = () => reject(new Error(`Account session write was aborted: ${transaction.error?.name ?? 'unknown error'}.`));
  });
}

function isStoredSession(value: unknown): value is StoredAccountSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<StoredAccountSession>;
  return typeof session.apiUrl === 'string'
    && typeof session.token === 'string'
    && typeof session.expiresAt === 'string'
    && typeof session.email === 'string';
}

export async function getStoredApiUrl(): Promise<string> {
  return (await AsyncStorage.getItem(CONFIG_KEY)) ?? '';
}

export async function setStoredApiUrl(apiUrl: string): Promise<void> {
  if (apiUrl) await AsyncStorage.setItem(CONFIG_KEY, apiUrl);
  else await AsyncStorage.removeItem(CONFIG_KEY);
}

export async function getStoredPowerSyncUrl(): Promise<string> {
  return (await AsyncStorage.getItem(POWERSYNC_CONFIG_KEY)) ?? '';
}

export async function setStoredPowerSyncUrl(value: string): Promise<void> {
  if (value) await AsyncStorage.setItem(POWERSYNC_CONFIG_KEY, value);
  else await AsyncStorage.removeItem(POWERSYNC_CONFIG_KEY);
}

export async function getStoredSession(): Promise<StoredAccountSession | null> {
  if (Platform.OS === 'web') return readBrowserSession();
  const SecureStore = await import('expo-secure-store');
  const value = await SecureStore.getItemAsync(NATIVE_SESSION_KEY);
  if (!value) return null;
  try {
    const session: unknown = JSON.parse(value);
    return isStoredSession(session) ? session : null;
  } catch {
    return null;
  }
}

export async function setStoredSession(session: StoredAccountSession | null): Promise<void> {
  if (Platform.OS === 'web') {
    await writeBrowserSession(session);
    return;
  }
  const SecureStore = await import('expo-secure-store');
  if (session) {
    await SecureStore.setItemAsync(NATIVE_SESSION_KEY, JSON.stringify(session));
  } else {
    await SecureStore.deleteItemAsync(NATIVE_SESSION_KEY);
  }
}
