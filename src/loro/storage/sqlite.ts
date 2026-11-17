import { StorageFailure, TransactionalStorage } from './core.ts';
import type { TransactionRunner } from './core.ts';

/** The subset of op-sqlite's synchronous connection API used here. */
export interface SQLiteConnection { executeSync(sql: string, params?: any[]): { rows?: any[] } }
const encode = (v: unknown) => JSON.stringify(v, (_k,x) => x instanceof Uint8Array ? {__storageBytes:Array.from(x)} : x);
const decode = (v: string) => { try { return JSON.parse(v, (_k,x) => x && typeof x === 'object' && Object.keys(x).length === 1 && Array.isArray(x.__storageBytes) ? new Uint8Array(x.__storageBytes) : x); } catch { throw new StorageFailure('CORRUPT'); } };
/** Uses BEGIN IMMEDIATE to serialize writers across connections and processes. */
export function openSQLiteStorage(db: SQLiteConnection, fault?: (boundary: string) => void) {
  db.executeSync('CREATE TABLE IF NOT EXISTS loro_records (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  let pending = Promise.resolve();
  const run: TransactionRunner = (write,body) => {
    const execute = async () => {
      db.executeSync(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const result = await body({
          get: async k => { const row = db.executeSync('SELECT value FROM loro_records WHERE key = ?', [k]).rows?.[0]; return row === undefined ? undefined : decode(row.value); },
          put: async (k,v) => { db.executeSync('INSERT INTO loro_records (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[k,encode(v)]); },
        });
        db.executeSync('COMMIT'); return result;
      } catch(e) { try { db.executeSync('ROLLBACK'); } catch {} throw e; }
    };
    const result = pending.then(execute); pending = result.then(() => {},() => {}); return result;
  };
  return new TransactionalStorage(run,fault);
}
