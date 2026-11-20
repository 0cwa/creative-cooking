import {HouseholdRecipientTransaction} from './household-recipient-transaction.ts';
import { recoveryTransaction } from './recovery-transaction.ts';
import { ContinuityRegistry } from '../compromise/continuity.mjs';
import { CompromiseReviews } from '../compromise/review.mjs';
import { LocalKeys } from './local-keys.ts';
import { RecipientRecords } from './recipient.ts';
import { denseArray, StorageFailure, TransactionalStorage } from './core.ts';
import type { TransactionRunner } from './core.ts';

/** The subset of op-sqlite's synchronous connection API used here. */
export interface SQLiteConnection { executeSync(sql: string, params?: any[]): { rows?: any[] } }
const encode = (v: unknown) => JSON.stringify(v, (_k,x) => x instanceof Uint8Array ? {__storageBytes:Array.from(x)} : x);
const decode = (v: string) => { try { return JSON.parse(v, (_k,x) => {
  if (x && typeof x === 'object' && Object.hasOwn(x,'__storageBytes')) {
    if (Object.keys(x).length !== 1 || !denseArray(x.__storageBytes, (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 255)) throw new Error('invalid byte marker');
    return new Uint8Array(x.__storageBytes);
  }
  return x;
}); } catch { throw new StorageFailure('CORRUPT'); } };
// All transactions on the same connection must finish before the next begins.
const connectionQueue = new WeakMap<SQLiteConnection,Promise<void>>();
export function scheduleSQLite<T>(db: SQLiteConnection, execute: () => Promise<T>|T): Promise<T> {
  const result = (connectionQueue.get(db) ?? Promise.resolve()).then(execute);
  connectionQueue.set(db,result.then(() => {}, () => {}));
  return result;
}

/** Uses BEGIN IMMEDIATE to serialize writers across connections and processes. */
export function openSQLiteTransaction(db: SQLiteConnection): TransactionRunner {
  db.executeSync('CREATE TABLE IF NOT EXISTS loro_records (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  return (write,body) => {
    const execute = async () => {
      db.executeSync(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const result = await body({
          keys: async () => (db.executeSync('SELECT key FROM loro_records').rows ?? []).map(row => row.key),
          get: async k => { const row = db.executeSync('SELECT value FROM loro_records WHERE key = ?', [k]).rows?.[0]; return row === undefined ? undefined : decode(row.value); },
          put: async (k,v) => { db.executeSync('INSERT INTO loro_records (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[k,encode(v)]); },
          delete: async k => { db.executeSync('DELETE FROM loro_records WHERE key = ?', [k]); },
        });
        db.executeSync('COMMIT'); return result;
      } catch(e) { try { db.executeSync('ROLLBACK'); } catch {} throw e; }
    };
    return scheduleSQLite(db,execute);
  };
}

export function openSQLiteStorage(db: SQLiteConnection, fault?: (boundary: string) => void) {
  const run = openSQLiteTransaction(db);
  return Object.assign(new TransactionalStorage(run,fault), {householdRecipient:new HouseholdRecipientTransaction(run,fault),recoveryTransaction:recoveryTransaction(run),continuity:new ContinuityRegistry(run,fault),compromise:new CompromiseReviews(run,fault),recipient:new RecipientRecords(run,fault),localKeys:(master: ConstructorParameters<typeof LocalKeys>[1], sodium: any, afterCommit?: () => void) => new LocalKeys(run,master,sodium,afterCommit)});
}
