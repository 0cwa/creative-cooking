import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PersistedState } from '@/domain/types';

const STATE_KEY = 'creative-cooking-state-v1';
const DB_NAME = 'creative-cooking';
const DB_VERSION = 1;
const STORE_NAME = 'app-state';

let databasePromise: Promise<IDBDatabase> | null = null;

function storageError(action: string, error: unknown): Error {
  const cause = error instanceof DOMException || error instanceof Error ? error : null;
  if (cause?.name === 'QuotaExceededError') {
    return new Error('Browser storage is full. Creative Cooking could not save your latest changes. Export a backup and free some browser storage, then retry.');
  }
  const detail = cause?.message ? ` ${cause.message}` : '';
  return new Error(`Creative Cooking could not ${action} its IndexedDB data.${detail}`);
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser, so Creative Cooking cannot safely persist app data.'));
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };

    request.onerror = () => {
      databasePromise = null;
      reject(storageError('open', request.error));
    };

    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('Creative Cooking storage is blocked by another open tab. Close other Creative Cooking tabs and retry.'));
    };
  });

  return databasePromise;
}

async function readIndexedState(database: IDBDatabase): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);

    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
    request.onerror = () => reject(storageError('read', request.error));
    transaction.onabort = () => reject(storageError('read', transaction.error));
  });
}

async function writeIndexedState(database: IDBDatabase, raw: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(raw, STATE_KEY);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(storageError('save', transaction.error));
    transaction.onabort = () => reject(storageError('save', transaction.error));
  });
}

function parseState(raw: string | null): Partial<PersistedState> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<PersistedState>;
  } catch {
    return null;
  }
}

export async function loadState(): Promise<Partial<PersistedState> | null> {
  const database = await openDatabase();
  const indexedRaw = await readIndexedState(database);
  if (indexedRaw) return parseState(indexedRaw);

  const legacyRaw = await AsyncStorage.getItem(STATE_KEY);
  const legacyState = parseState(legacyRaw);
  if (!legacyRaw || !legacyState) return legacyState;

  // Write first, then clean up the legacy localStorage-backed AsyncStorage value.
  // If cleanup fails, IndexedDB still wins on every subsequent load.
  await writeIndexedState(database, legacyRaw);
  try {
    await AsyncStorage.removeItem(STATE_KEY);
  } catch {
    // Safe to ignore: migration has already committed to IndexedDB.
  }
  return legacyState;
}

export async function saveState(state: PersistedState): Promise<void> {
  const database = await openDatabase();
  await writeIndexedState(database, JSON.stringify(state));
}
