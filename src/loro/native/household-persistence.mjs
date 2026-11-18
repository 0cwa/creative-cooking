import {resolveRuntimeAuthority} from '../authority/chain.mjs';
import {validPairingScope} from '../contracts/pairing.ts';
import {selectedHousehold} from '../app/household-selection.mjs';
import {openSQLiteTransaction} from '../storage/sqlite.ts';
import {openNativeSequences} from './sequences.mjs';

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
const household = scope => validPairingScope(scope) && scope.kind === 'household';
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const pinKey = id => JSON.stringify(['pin', id]);
const pinAad = id => enc.encode(`creative-cooking/household-pin/v1/${id}`);
const validPin = value => value && Object.keys(value).sort().join(',') === 'head,pin,scope,version' &&
  value.version === 1 && household(value.scope) && hash(value.pin) && hash(value.head);

const queues = new Map();
function lockWorkspace(name, operation, use) {
  const key = JSON.stringify([name, operation]);
  const result = (queues.get(key) ?? Promise.resolve()).then(use);
  const settled = result.then(() => {}, () => {});
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return result;
}

export function openNativeHouseholdPersistence({name, openDatabase, master, storage, provider, sodium, deviceId}) {
  // This connection is separate from the document and sequence transactions.
  const db = openDatabase(`${name}-pairing`);
  try {
    const run = openSQLiteTransaction(db);
    const pins = {
      list: () => run(false, async tx => {
        const values = [];
        for (const key of await tx.keys()) {
          const [kind, id] = JSON.parse(key);
          if (kind !== 'pin') continue;
          values.push(await readPin(tx, id));
        }
        return values;
      }),
      save(value) {
        value = structuredClone(value);
        if (!validPin(value)) throw Error('MALFORMED');
        const id = value.scope.id;
        return run(true, async tx => {
          const previous = await readPin(tx, id);
          if (previous) {
            if (previous.pin !== value.pin || previous.head !== value.head) throw Error('PIN_CONFLICT');
            return;
          }
          await tx.put(pinKey(id), await master.wrap('workspace-master', enc.encode(JSON.stringify(value)), pinAad(id)));
        });
      }
    };
    async function readPin(tx, id) {
      const raw = await tx.get(pinKey(id));
      if (raw === undefined) return null;
      let value;
      try { value = JSON.parse(dec.decode(await master.unwrap('workspace-master', raw, pinAad(id)))); }
      catch { throw Error('PIN_CATALOG_CORRUPT'); }
      if (!validPin(value) || value.scope.id !== id) throw Error('PIN_CATALOG_CORRUPT');
      return value;
    }

    const store = {
      transaction(fn, {readOnly = false} = {}) {
        if (typeof readOnly !== 'boolean') throw Error('MALFORMED');
        return run(!readOnly, async tx => {
          const key = '["ceremony"]', states = await tx.get(key) ?? {};
          let changed = false;
          const value = fn({
            get: k => Object.hasOwn(states, k) ? structuredClone(states[k]) : undefined,
            put(k, entry) {
              if (readOnly) throw Error('READ_ONLY');
              Object.defineProperty(states, k, {value:structuredClone(entry), enumerable:true, configurable:true, writable:true});
              changed = true;
            }
          });
          if (value && typeof value.then === 'function') throw Error('ASYNC_TRANSACTION');
          if (changed) await tx.put(key, states);
          return value;
        });
      }
    };

    // Pending enrollment can resume after an interrupted installation, but an
    // active counter is never recreated. The counter is bound to this receipt.
    function joined({scope, pin, operationId}, mode) {
      scope = structuredClone(scope);
      if (!household(scope) || !hash(pin) || !/^receive-[0-9a-f]{64}$/.test(operationId)) throw Error('MALFORMED');
      return lockWorkspace(name, 'enrollment', async () => {
        const found = await storage.householdRecipient.find(scope.id, operationId);
        if (!found.ok) throw Error('INVALID_ADMISSION');
        const key = JSON.stringify(['enrollment', scope.id]);
        let enrollment = await run(false, tx => tx.get(key));
        if (!enrollment) {
          if (mode !== 'prepare' || found.value) throw Error('MISSING_ENROLLMENT');
          const established = await storage.householdRecipient.hasDevice(scope.id, deviceId);
          if (!established.ok || established.value) throw Error('MISSING_ENROLLMENT');
          enrollment = {version:1, stage:'pending', scopeId:scope.id, pin, deviceId, operationId};
          await run(true, tx => tx.put(key, enrollment));
        }
        if (enrollment.version !== 1 || !['pending', 'active'].includes(enrollment.stage) ||
          enrollment.scopeId !== scope.id || enrollment.pin !== pin || enrollment.deviceId !== deviceId ||
          enrollment.operationId !== operationId) throw Error('ENROLLMENT_CONFLICT');
        if (mode === 'prepare') {
          if (enrollment.stage !== 'pending' && !found.value) throw Error('MISSING_ADMISSION');
          return null;
        }
        if (!found.value) throw Error('MISSING_ADMISSION');
        if (mode === 'open' && enrollment.stage !== 'active') throw Error('INCOMPLETE_ENROLLMENT');
        const resolved = await resolveRuntimeAuthority(storage, scope, pin, provider, deviceId);
        const receipt = found.value, checked = await storage.householdRecipient.check(receipt);
        if (!checked.ok || checked.value !== true || receipt.receiptBody?.recipientDevice !== deviceId ||
          receipt.scopeId !== scope.id) throw Error('INVALID_ADMISSION');
        const counters = openDatabase(`${name}-${operationId}`);
        try {
          const activate = mode === 'finalize' && enrollment.stage === 'pending';
          const sequences = openNativeSequences(counters, [scope.id], activate);
          if (activate) await run(true, tx => tx.put(key, {...enrollment, stage:'active'}));
          return {resolved, sequences:{reserve:sequences.reserve, close:() => counters.close()}};
        } catch (error) {
          counters.close();
          throw error;
        }
      });
    }
    const selectionKey = '["selection"]', markerKey = '["selection-required"]';
    const selection = selectedHousehold({
      master, pins, storage, provider, sodium, deviceId,
      openJoined: args => joined(args, 'open'),
      lock: (_mode, use) => lockWorkspace(name, 'selection', use),
      readStored: () => run(false, async tx => [await tx.get(selectionKey) ?? undefined, await tx.get(markerKey) ?? undefined]),
      writeStored: value => run(true, async tx => {
        await tx.put(selectionKey, value);
        await tx.put(markerKey, value === null ? null : 1);
      })
    });
    return {
      pins, store, selection,
      prepareJoinedSequences: args => joined(args, 'prepare'),
      finalizeJoinedSequences: args => joined(args, 'finalize'),
      close: () => db.close()
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
