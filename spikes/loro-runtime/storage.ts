import AsyncStorage from '@react-native-async-storage/async-storage';

const DB_NAME = 'creative-cooking-loro-spike-v1';
const STORE_NAME = 'snapshots';
const KEY = 'recipe';
const NATIVE_KEY = `${DB_NAME}:${KEY}`;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadSnapshot(): Promise<Uint8Array | undefined> {
  if (typeof indexedDB === 'undefined') {
    const stored = await AsyncStorage.getItem(NATIVE_KEY);
    return stored ? new Uint8Array(JSON.parse(stored) as number[]) : undefined;
  }
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(KEY);
    request.onsuccess = () => {
      const stored = request.result as number[] | undefined;
      resolve(stored ? new Uint8Array(stored) : undefined);
      database.close();
    };
    request.onerror = () => {
      database.close();
      reject(request.error);
    };
  });
}

export async function saveSnapshot(bytes: Uint8Array): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    await AsyncStorage.setItem(NATIVE_KEY, JSON.stringify(Array.from(bytes)));
    return;
  }
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(Array.from(bytes), KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Snapshot write aborted'));
  }).finally(() => database.close());
}
