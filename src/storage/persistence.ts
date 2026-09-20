import { Platform } from 'react-native';

const REQUESTED_KEY = 'creative-cooking-persistence-requested-v1';

export type PersistenceInfo = {
  supported: boolean;
  persistent: boolean;
  usage?: number;
  quota?: number;
};

export async function getPersistenceInfo(): Promise<PersistenceInfo> {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.storage) {
    return { supported: Platform.OS !== 'web', persistent: Platform.OS !== 'web' };
  }

  const persistent = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  const estimate = navigator.storage.estimate ? await navigator.storage.estimate() : {};
  return {
    supported: Boolean(navigator.storage.persist),
    persistent,
    usage: estimate.usage,
    quota: estimate.quota
  };
}

export async function requestPersistentStorage(): Promise<PersistenceInfo> {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return getPersistenceInfo();
  }
  await navigator.storage.persist();
  return getPersistenceInfo();
}

export async function requestPersistentStorageOnce(): Promise<PersistenceInfo> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return getPersistenceInfo();

  const alreadyRequested = window.localStorage.getItem(REQUESTED_KEY) === '1';
  const current = await getPersistenceInfo();
  if (alreadyRequested || current.persistent || !current.supported) return current;

  window.localStorage.setItem(REQUESTED_KEY, '1');
  return requestPersistentStorage();
}
