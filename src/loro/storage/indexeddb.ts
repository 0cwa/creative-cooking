import {HouseholdRecipientTransaction} from './household-recipient-transaction.ts';
import { recoveryTransaction } from './recovery-transaction.ts';
import { ContinuityRegistry } from '../compromise/continuity.mjs';
import { CompromiseReviews } from '../compromise/review.mjs';
import { LocalKeys } from './local-keys.ts';
import { RecipientRecords } from './recipient.ts';
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
  const compromise=new CompromiseReviews(run,fault),localKeys=(master: ConstructorParameters<typeof LocalKeys>[1], sodium: any, afterCommit?: () => void) => new LocalKeys(run,master,sodium,afterCommit);
  const continuity=new ContinuityRegistry(run,fault);
  return {storage:Object.assign(new TransactionalStorage(run,fault),{compromise,continuity,localKeys,householdRecipient:new HouseholdRecipientTransaction(run,fault)}),recoveryTransaction:recoveryTransaction(run),continuity,compromise,recipient:new RecipientRecords(run,fault),localKeys,close:() => db.close()};
}
