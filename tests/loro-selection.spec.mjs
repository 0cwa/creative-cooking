import {openHouseholdTools} from './settings-navigation.mjs';
import {test,expect} from './browser-fixture.mjs';
test('explicit household selection opens shared cooking and returns to original',async({page})=>{test.setTimeout(60000);page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));let created;try{await page.goto('/');created=await page.evaluate(async()=> (await import('/src/loro/app/admission-bootstrap-browser.mjs')).run({ui:true}));await page.goto('/creative-cooking/');await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await expect(page.getByText('Proof onion',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(page);await page.getByRole('button',{name:'Show device identity'}).click();await expect(page.getByRole('button',{name:'Open this shared household'})).toBeVisible({timeout:5000}).catch(async error=>{console.error('Selection status:',await page.locator('[role=alert]').allTextContents());throw error});await page.getByRole('button',{name:'Open this shared household'}).click();await expect(page.getByText('Proof onion',{exact:true})).toBeVisible();await page.getByLabel('Ingredient and details').fill('Shared mint');await page.getByLabel('Add ingredient').click();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await page.reload();await expect(page.getByText('Shared mint',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(page);await expect(page.getByText('A household change requires a new disclosure policy before external sharing can be approved.')).toBeVisible();await page.getByRole('button',{name:'Show device identity'}).click();await page.getByRole('button',{name:'Return to original local household'}).click();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await expect(page.getByText('Proof onion',{exact:true})).toHaveCount(0);await expect(page.getByText('Shared mint',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(page);await page.getByRole('button',{name:'Show device identity'}).click();await page.getByRole('button',{name:'Open this shared household'}).click();await expect(page.getByText('Shared mint',{exact:true})).toBeVisible();expect(errors).toEqual([])}finally{if(created){await page.goto('/');await page.evaluate(async(name)=>{localStorage.clear();const names=(await indexedDB.databases()).map(x=>x.name).filter(x=>x&&(x.startsWith(name)||x.startsWith('joined-')&&x.endsWith('-sequences')));await Promise.all(names.map(n=>new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase(n);q.onsuccess=resolve;q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('blocked'))})))},created.name)}}});
test('household switch freezes edits and releases them if selection fails',async({page})=>{
 test.setTimeout(90000);page.setDefaultTimeout(10000);let created;try{await page.goto('/');created=await page.evaluate(async()=> (await import('/src/loro/app/admission-bootstrap-browser.mjs')).run({ui:true}));await page.goto('/creative-cooking/');await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await page.getByLabel('Ingredient and details').fill('Before switch');await page.getByLabel('Add ingredient').click();await page.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(page);await page.getByRole('button',{name:'Show device identity'}).click();await expect(page.getByRole('button',{name:'Open this shared household'})).toBeVisible();await page.evaluate(()=>{const old=navigator.locks.request.bind(navigator.locks);navigator.locks.request=(name,...args)=>String(name).startsWith('creative-cooking/bootstrap/v1/')&&args[0]?.mode==='exclusive'?new Promise((resolve,reject)=>{window.__rejectSelection=()=>reject(Error('injected selection failure'))}):old(name,...args)});await page.getByRole('button',{name:'Open this shared household'}).click();await expect.poll(()=>page.evaluate(()=>typeof window.__rejectSelection)).toBe('function');const city=page.getByLabel('City'),before=await city.inputValue();await city.fill('Denied city');await expect(city).toHaveValue(before);await page.getByRole('button',{name:'Back',exact:true}).click();await expect(page.getByLabel('Ingredient and details')).not.toBeEditable();await expect(page.getByLabel('Add ingredient')).toBeDisabled();await expect(page.getByText('Denied ingredient',{exact:true})).toHaveCount(0);await page.evaluate(()=>window.__rejectSelection());await page.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(page);await page.getByLabel('City').fill('Allowed city');await expect(page.getByLabel('City')).toHaveValue('Allowed city');await page.getByRole('button',{name:'Back',exact:true}).click();await expect(page.getByText('Before switch',{exact:true})).toBeVisible();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await page.reload();await expect(page.getByText('Before switch',{exact:true})).toBeVisible();await expect(page.getByText('Denied ingredient',{exact:true})).toHaveCount(0)}finally{if(created){await page.goto('/');await page.evaluate(async(name)=>{localStorage.clear();const names=(await indexedDB.databases()).map(x=>x.name).filter(x=>x&&(x.startsWith(name)||x.startsWith('joined-')&&x.endsWith('-sequences')));await Promise.all(names.map(n=>new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase(n);q.onsuccess=resolve;q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('blocked'))})))},created.name)}}
});
test('other open tabs retain their visible household and reject saves after a switch',async({page,context})=>{
 test.setTimeout(90000);page.setDefaultTimeout(10000);let created,other;try{await page.goto('/');created=await page.evaluate(async()=> (await import('/src/loro/app/admission-bootstrap-browser.mjs')).run({ui:true}));await page.goto('/creative-cooking/');other=await context.newPage();other.setDefaultTimeout(10000);await other.goto('/creative-cooking/');await expect(other.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await page.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(page);await expect(page.getByLabel('Open household')).toContainText('Original local household');await page.getByRole('button',{name:'Show device identity'}).click();await page.getByRole('button',{name:'Open this shared household'}).click();await expect(page.getByText('Proof onion',{exact:true})).toBeVisible();await other.getByLabel('Ingredient and details').fill('Other tab original basil');await other.getByLabel('Add ingredient').click();await expect(other.getByTestId('pantry-local-persistence-status')).toHaveText('Local save failed');await expect(page.getByText('Other tab original basil',{exact:true})).toHaveCount(0);await other.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(other);await expect(other.getByLabel('Open household')).toContainText('Original local household');await page.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(page);await expect(page.getByLabel('Open household')).toContainText('Shared household');await page.getByRole('button',{name:'Show device identity'}).click();await page.getByRole('button',{name:'Return to original local household'}).click();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await expect(page.getByText('Other tab original basil',{exact:true})).toHaveCount(0)}finally{await other?.close();if(created){await page.goto('/');await page.evaluate(async(name)=>{localStorage.clear();const names=(await indexedDB.databases()).map(x=>x.name).filter(x=>x&&(x.startsWith(name)||x.startsWith('joined-')&&x.endsWith('-sequences')));await Promise.all(names.map(n=>new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase(n);q.onsuccess=resolve;q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('blocked'))})))},created.name)}}
});

test('joined counter compatibility preserves active sequences and rejects enrollment downgrade', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const {run} = await import('/src/loro/app/admission-bootstrap-browser.mjs');
    const {openIndexedDBStorage} = await import('/src/loro/storage/indexeddb.ts');
    const {openJoinedSequences,finalizeJoinedSequences} = await import('/src/loro/app/joined-sequences.web.ts');
    const {openSequences} = await import('/src/loro/app/sequences.web.ts');
    const sodium = (await import('libsodium-wrappers')).default;
    const {name,receiverName,scope} = await run({ui:true});
    const legacyName = `joined-${crypto.randomUUID()}`;
    const request = q => new Promise((resolve,reject) => {
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    const useEnrollment = async (mode,fn) => {
      const db = await request(indexedDB.open(`${receiverName}-joined`));
      try {
        const tx = db.transaction('enrollments',mode);
        const done = new Promise((resolve,reject) => {
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
        });
        const result = await fn(tx.objectStore('enrollments'));
        await done;
        return result;
      } finally { db.close(); }
    };
    const records = await openIndexedDBStorage(`${receiverName}-records`);
    try {
      const current = await useEnrollment('readonly',store => request(store.get(scope.id)));
      const bindingKey = [scope.id,'counter-binding'];
      const binding = await useEnrollment('readonly',store => request(store.get(bindingKey)));
      const provider = {
        hash: async bytes => sodium.crypto_generichash(32,bytes),
        verify: async (key,bytes,sig) => sodium.crypto_sign_verify_detached(sig,bytes,sodium.from_hex(key)),
      };
      const args = {name:receiverName,scope,storage:records.storage,provider,
        pin:current.pin,deviceId:current.deviceId,operationId:current.operationId};
      const useCounter = async (open,operation) => {
        const {sequences} = await open(args);
        try { return await sequences.reserve(scope.id,operation); }
        finally { sequences.close(); }
      };
      const legacy = {...current,version:1,sequenceName:legacyName};
      const old = await openSequences(legacyName,[scope.id],true);
      try { await old.reserve(scope.id,'historical action'); }
      finally { old.close(); }
      await useEnrollment('readwrite',store => { store.put(legacy,scope.id); });
      const downgrade = await useCounter(openJoinedSequences,'foreign action').then(() => null,error => error.message);

      // Simulate an enrollment that predates the separate binding record.
      await useEnrollment('readwrite',store => {
        store.delete(bindingKey);
        store.put(legacy,scope.id);
      });
      const preserved = await useCounter(openJoinedSequences,'historical action');
      const retried = await useCounter(finalizeJoinedSequences,'next legacy action');
      await useEnrollment('readwrite',store => { store.put({...legacy,stage:'pending'},scope.id); });
      const pending = await useCounter(openJoinedSequences,'early action').then(() => null,error => error.message);
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value,key) {
        if(this.name==='enrollments'&&Array.isArray(key)&&key[1]==='counter-binding') throw Error('binding write failed');
        return put.call(this,value,key);
      };
      const failedMigration = await useCounter(finalizeJoinedSequences,'early action').then(() => null,error => error.message)
        .finally(() => { IDBObjectStore.prototype.put = put; });
      const rolledBack = await useEnrollment('readonly',async store => {
        const [enrollment,marker] = await Promise.all([request(store.get(scope.id)),request(store.get(bindingKey))]);
        return enrollment.version===1&&enrollment.stage==='pending'&&marker===undefined;
      });
      const migrated = await useCounter(finalizeJoinedSequences,'first bound action');
      const migratedRetry = await useCounter(openJoinedSequences,'first bound action');
      const rebound = await useEnrollment('readonly',store => request(store.get(bindingKey)));
      return {bound:binding?.stage==='active'&&current.sequenceName===`joined-v2-${binding.binding}`,downgrade,preserved,retried,pending,failedMigration,rolledBack,
        migrated,migratedRetry,rebound:rebound?.stage==='active'&&rebound.binding===binding?.binding};
    } finally {
      records.close();
      localStorage.clear();
      const databases = (await indexedDB.databases()).filter(({name:db}) => db.startsWith(name)||db.startsWith('joined-'));
      await Promise.all(databases.map(({name:db}) => request(indexedDB.deleteDatabase(db))));
    }
  });
  expect(result).toEqual({bound:true,downgrade:'ENROLLMENT_CONFLICT',preserved:1,retried:2,
    pending:'INCOMPLETE_ENROLLMENT',failedMigration:'binding write failed',rolledBack:true,migrated:1,migratedRetry:1,rebound:true});
});
