import {validPairingScope} from '../contracts/pairing.ts';
import {householdReceiverIds} from './household-transfer.mjs';

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
const aad = enc.encode('creative-cooking/selected-household/v1');
const household = scope => validPairingScope(scope) && scope.kind === 'household';

/** Recheck the independent pin, recipient receipt and joined counter before
 * opening or selecting an installed household. */
export function selectedHousehold({readStored, writeStored, lock, openJoined, master, pins, storage, provider, sodium, deviceId}) {
  async function read() {
    const [raw, marker, revision = 0] = await readStored();
    if (!Number.isSafeInteger(revision) || revision < 0) throw Error('SELECTION_CORRUPT');
    if (raw === undefined && marker === undefined) return {scope:null,revision};
    if (raw === undefined || marker !== 1) throw Error('SELECTION_CORRUPT');
    let value;
    try { value = JSON.parse(dec.decode(await master.unwrap('workspace-master', raw, aad))); }
    catch { throw Error('SELECTION_CORRUPT'); }
    if (!value || Object.keys(value).sort().join(',') !== 'scope,version' ||
      value.version !== 1 || !household(value.scope)) throw Error('SELECTION_CORRUPT');
    return {scope:value.scope,revision};
  }
  async function open(scope) {
    const pin = (await pins.list()).find(value => value?.scope?.id === scope.id);
    if (!pin) throw Error('CONFIRMATION_REQUIRED');
    const {operationId} = householdReceiverIds(sodium, scope, deviceId);
    const receipt = await storage.householdRecipient.find(scope.id, operationId);
    if (!receipt.ok || receipt.value && receipt.value.expectedAuthority.acceptedParent !== pin.head) throw Error('INVALID_ADMISSION');
    const joined = await openJoined({storage, scope, pin:pin.pin, provider, deviceId, operationId,confirmedParent:pin.head});
    if (!joined) throw Error('INVALID_ADMISSION');
    return {...joined, scope, pin:pin.pin};
  }
  async function assertCurrent(id) {
    const {scope,revision} = await read();
    if ((scope?.id ?? null) !== id) throw Error('HOUSEHOLD_SELECTION_CHANGED');
    return revision;
  }
  return {
    assertCurrent,
    withCurrent: (id, use) => lock('shared', async () => use(await assertCurrent(id))),
    async openSelected() {
      const {scope} = await read();
      return scope ? open(scope) : null;
    },
    async available(scope) {
      scope = structuredClone(scope);
      if (!household(scope)) throw Error('MALFORMED');
      const {operationId} = householdReceiverIds(sodium, scope, deviceId);
      const receipt = await storage.householdRecipient.find(scope.id, operationId);
      if (!receipt.ok) throw Error(receipt.error);
      if(!receipt.value&&!(await pins.list()).some(value=>value?.scope?.id===scope.id))return false;
      try{(await open(scope)).sequences.close();}
      catch(error){if(!receipt.value&&error?.message==='MISSING_ADMISSION')return false;throw error;}
      return true;
    },
    select(scope, expectedHead=undefined) {
      scope = structuredClone(scope);
      if (!household(scope)) throw Error('MALFORMED');
      return lock('exclusive', async () => {
        const verified = await open(scope);
        try {
          if(expectedHead!==undefined&&verified.resolved.scope.branchHead!==expectedHead)throw Error('STALE_AUTHORITY');
          await writeStored(await master.wrap('workspace-master', enc.encode(JSON.stringify({version:1, scope})), aad));
        } finally { verified.sequences.close(); }
      });
    },
    clear: () => lock('exclusive', () => writeStored(null))
  };
}
