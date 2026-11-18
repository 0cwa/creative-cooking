import {resolveRuntimeAuthority} from '../authority/chain.mjs';
import {validPairingScope} from '../contracts/pairing.ts';
import {selectedHousehold} from '../app/household-selection.mjs';
import {openSQLiteTransaction} from '../storage/sqlite.ts';
import {openNativeSequences} from './sequences.mjs';

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
const household = scope => validPairingScope(scope) && scope.kind === 'household';
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const selectionKey = '["native-household-selection"]';
const markerKey = '["native-household-selection-required"]';
const revisionKey = '["native-household-selection-revision"]';
const enrollmentKey = id => JSON.stringify(['native-household-enrollment', id]);
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

async function writeSelection(tx, value) {
  const revision=(await tx.get(revisionKey))??0;
  if(!Number.isSafeInteger(revision)||revision<0||revision===Number.MAX_SAFE_INTEGER)throw Error('SELECTION_CORRUPT');
  await tx.put(selectionKey, value);
  await tx.put(markerKey, value === null ? 0 : 1);
  await tx.put(revisionKey, revision+1);
}
function saveSelection(run, value) {
  return run(true, tx => writeSelection(tx, value));
}

export function returnToOriginalHousehold(name, run) {
  return lockWorkspace(name, 'selection', () => saveSelection(run, null));
}

export function openNativeHouseholdPersistence({name, openDatabase, workspaceRun, master, storage, provider, sodium, deviceId}) {
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

    // Only a durable pending record in the main workspace proves this
    // allocator has never been exposed. Legacy receipts can reuse a verified
    // counter but cannot authorize creating one.
    function joined({scope, pin, operationId}, mode) {
      scope = structuredClone(scope);
      if (!household(scope) || !hash(pin) || !/^receive-[0-9a-f]{64}$/.test(operationId)) throw Error('MALFORMED');
      return lockWorkspace(name, 'enrollment', async () => {
        const found = await storage.householdRecipient.find(scope.id, operationId);
        if (!found.ok) throw Error('INVALID_ADMISSION');
        const key = enrollmentKey(scope.id);
        const enrollment = await workspaceRun(false, tx => tx.get(key));
        const identity = {version:1, scopeId:scope.id, pin, deviceId, operationId};
        function checkEnrollment(record) {
          if (record !== undefined && (!record || !['pending', 'active'].includes(record.stage) ||
            Object.keys(record).length !== Object.keys(identity).length + 1 ||
            !Object.entries(identity).every(([field, value]) => record[field] === value))) throw Error('ENROLLMENT_CONFLICT');
        }
        checkEnrollment(enrollment);
        const legacy = enrollment?.stage === 'active' ? undefined :
          await run(false, tx => tx.get(JSON.stringify(['enrollment', scope.id])));
        checkEnrollment(legacy);
        const alreadyActive = enrollment?.stage === 'active' || legacy?.stage === 'active';
        if (mode === 'prepare') {
          if (found.value) return null;
          if (alreadyActive) throw Error('MISSING_ADMISSION');
          const established = await storage.householdRecipient.hasDevice(scope.id, deviceId);
          if (!established.ok || established.value) throw Error('MISSING_ENROLLMENT');
          if (!enrollment) await workspaceRun(true, tx => tx.put(key, {...identity, stage:'pending'}));
          return null;
        }
        if (!found.value) throw Error('MISSING_ADMISSION');
        if (mode === 'open' && enrollment?.stage === 'pending') throw Error('INCOMPLETE_ENROLLMENT');
        const resolved = await resolveRuntimeAuthority(storage, scope, pin, provider, deviceId);
        const receipt = found.value, checked = await storage.householdRecipient.check(receipt);
        if (!checked.ok || checked.value !== true || receipt.receiptBody?.recipientDevice !== deviceId ||
          receipt.scopeId !== scope.id) throw Error('INVALID_ADMISSION');
        const counters = openDatabase(`${name}-${operationId}`);
        try {
          const initialize = mode === 'finalize' && enrollment?.stage === 'pending' && !alreadyActive;
          const sequences = openNativeSequences(counters, [scope.id], initialize);
          if (enrollment?.stage !== 'active') {
            await workspaceRun(true, tx => tx.put(key, {...identity, stage:'active'}));
          }
          return {resolved, sequences:{reserve:sequences.reserve, close:() => counters.close()}};
        } catch (error) {
          counters.close();
          throw error;
        }
      });
    }
    async function readSelection() {
      const state = await workspaceRun(false, async tx => {
        const value = await tx.get(selectionKey), marker = await tx.get(markerKey);
        const revision=await tx.get(revisionKey);
        if (value !== undefined || marker !== undefined) return {value, marker, revision};
        // An unreleased build stored its selection beside the pins. Surviving
        // receipts can reveal that layout even when the companion database is lost.
        for (const key of await tx.keys()) {
          const [kind, scope] = JSON.parse(key);
          if (kind === 'recipient-admission' && await tx.get(enrollmentKey(scope)) === undefined) {
            throw Error('LEGACY_HOUSEHOLD_SELECTION');
          }
        }
        return {revision};
      });
      if (state.value === undefined && state.marker === undefined) {
        await run(false, async tx => {
          if (await tx.get('["selection"]') != null || await tx.get('["selection-required"]') != null) {
            throw Error('LEGACY_HOUSEHOLD_SELECTION');
          }
        });
        return [undefined, undefined, state.revision];
      }
      if (state.value === null && state.marker === 0) return [undefined, undefined, state.revision];
      return [state.value, state.marker, state.revision];
    }
    const lockSelection = (_mode, use) => lockWorkspace(name, 'selection', use);
    const controls = selectedHousehold({
      master, pins, storage, provider, sodium, deviceId,
      openJoined: args => joined(args, 'open'),
      lock: lockSelection,
      readStored: readSelection,
      writeStored: value => saveSelection(workspaceRun, value)
    });
    const selection = {
      ...controls,
      openSelected: () => lockSelection('shared', async () => {
        const selected = await controls.openSelected();
        if (!selected) {
          await workspaceRun(true, async tx => {
            if (await tx.get(markerKey) === undefined) await writeSelection(tx, null);
          });
        }
        return selected;
      }),
      available(scope) {
        const requested = structuredClone(scope);
        return lockSelection('shared', () => controls.available(requested));
      }
    };
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
