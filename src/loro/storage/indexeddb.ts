import { TransactionalStorage } from './core.ts';
import type { TransactionRunner } from './core.ts';

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve,reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
/** Opens an isolated database; close it before deleting or upgrading it. */
export async function openIndexedDBStorage(name: string, fault?: (boundary: string) => void) {
  const opening = indexedDB.open(name,1);
  opening.onupgradeneeded = () => { opening.result.createObjectStore('records'); };
  const db = await request(opening);
  const run: TransactionRunner = async (write,body) => {
    const transaction = db.transaction('records',write ? 'readwrite' : 'readonly');
    const store = transaction.objectStore('records');
    const done = new Promise<void>((resolve,reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted')); transaction.onerror = () => {}; });
    try {
      const result = await body({keys: async () => (await request(store.getAllKeys())).map(String), get: k => request(store.get(k)), put: async (k,v) => { await request(store.put(v,k)); }});
      await done; return result;
    } catch(e) { try { transaction.abort(); } catch {} await done.catch(() => {}); throw e; }
  };
  return {storage:new TransactionalStorage(run,fault),close:() => db.close()};
}
