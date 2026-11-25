import {test,expect} from './browser-fixture.mjs';
test('shopping edits, purchase and pantry survive a fresh local reopen',async({page})=>{test.setTimeout(90000);await page.goto('./');await page.getByRole('button',{name:'Start cooking'}).click();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await page.goto('./shopping');const saved=()=>expect(page.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');await page.getByLabel('New shopping list name').fill('Market');await page.getByRole('button',{name:'Create shopping list'}).click();await expect(page.getByText('Market',{exact:true})).toBeVisible();await saved();await page.getByLabel('Shopping item name').fill('Golden carrot');await page.getByLabel('Shopping quantity').fill('2');await page.getByLabel('Shopping unit').fill('kg');await page.getByRole('button',{name:'Add',exact:true}).click();await expect(page.getByText('2 kg',{exact:true})).toBeVisible();await saved();await page.reload();await expect(page.getByText('Golden carrot',{exact:true})).toBeVisible();await expect(page.getByText('2 kg',{exact:true})).toBeVisible();await page.getByLabel('Edit Golden carrot').click();await page.getByLabel('Edit item name').fill('Orange carrot');await page.getByLabel('Edit item quantity').fill('3');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByText('3 kg',{exact:true})).toBeVisible();await saved();await page.getByLabel('Check Orange carrot').click();await saved();await page.getByRole('button',{name:'Add checked to Pantry (1)'}).click();await expect(page.getByText('Purchased',{exact:true})).toBeVisible();await saved();await page.reload();await expect(page.getByText('Purchased',{exact:true})).toBeVisible();await page.goto('./');await expect(page.getByText('Orange carrot',{exact:true})).toBeVisible();await page.goto('./shopping');await page.getByLabel('Shopping item name').fill('Soap');await page.getByRole('button',{name:'Add',exact:true}).click();await saved();await page.getByLabel('Remove Soap').click();await saved();await page.reload();await expect(page.getByText('Soap',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Remove list',exact:true}).click();await page.getByRole('button',{name:'Confirm remove list'}).click();await saved();await page.reload();await expect(page.getByRole('button',{name:'Create shopping list'})).toBeVisible();});

test('failed shopping purchase does not persist a pantry addition or purchase',async({page})=>{test.setTimeout(90000);await page.goto('./');await page.getByRole('button',{name:'Start cooking'}).click();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await page.goto('./shopping');const saved=()=>expect(page.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');await page.getByLabel('New shopping list name').fill('Fault list');await page.getByRole('button',{name:'Create shopping list'}).click();await saved();await page.getByLabel('Shopping item name').fill('Fault carrot');await page.getByRole('button',{name:'Add',exact:true}).click();await saved();await page.getByLabel('Check Fault carrot').click();await saved();await page.evaluate(()=>{const old=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(typeof key==='string'&&key.startsWith('["document",')){IDBObjectStore.prototype.put=old;throw Error('injected IO')}return old.call(this,value,key)}});await page.getByRole('button',{name:'Add checked to Pantry (1)'}).click();await expect(page.getByTestId('shopping-local-persistence-status')).toContainText('Local save needs attention');await page.reload();await expect(page.getByText('Purchased',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Check Fault carrot')).toBeVisible();await page.goto('./');await expect(page.getByText('Fault carrot',{exact:true})).toHaveCount(0)});
test('shopping copies a separate recipe and purchases the linked item once',async({page})=>{
 test.setTimeout(90_000);
 await page.goto('./');
 await page.getByRole('button',{name:'Start cooking'}).click();

 
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.goto('./recipes');
 await page.getByLabel('Add recipe').click();
 await page.getByLabel('New recipe title').fill('Basil soup');
 await page.getByLabel('New recipe ingredients').fill('1 sprig rosemary\n2 bunches basil');
 await page.getByLabel('New recipe steps').fill('Cook');
 await page.getByLabel('Save new recipe').click();
 await page.getByLabel('Open recipe Basil soup').click();
 await page.getByRole('button',{name:'Add ingredients to shopping list (2)'}).click();
 await page.getByLabel('New shopping list name').fill('Herbs');
 await page.getByRole('button',{name:'Create shopping list'}).click();
 const saved=()=>expect(page.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
 await saved();
 const add=page.getByRole('button',{name:'Add 1 ingredients to list'});
 const rosemary=page.getByRole('checkbox',{name:'Select ingredient rosemary 1'});
 const basil=page.getByRole('checkbox',{name:'Select ingredient basil 2'});
 await basil.click();
 await expect(add).toBeEnabled();
 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,key){
   if(typeof key==='string'&&key.startsWith('["disclosure-source",')){
    IDBObjectStore.prototype.put=put;
    window.copyWriteInterrupted=true;
    throw Error('Interrupted copy');
   }
   return put.call(this,value,key);
  };
 });
 await add.click();
 await expect.poll(()=>page.evaluate(()=>window.copyWriteInterrupted)).toBe(true);
 await expect(page.getByText('IO',{exact:true})).toBeVisible();
 await expect(page.getByTestId(/^shopping-item-/)).toHaveCount(0);
 await rosemary.click();
 await basil.click();
 await expect(add).toBeEnabled();
 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,key){
   if(typeof key==='string'&&key.startsWith('["disclosure-source",')){
    IDBObjectStore.prototype.put=put;
    this.transaction.oncomplete=event=>{
     window.copyAcknowledgementLost=true;
     this.transaction.onabort?.call(this.transaction,event);
    };
   }
   return put.call(this,value,key);
  };
 });
 await add.click();
 await expect.poll(()=>page.evaluate(()=>window.copyAcknowledgementLost)).toBe(true);
 await expect(add).toBeEnabled();
 await expect(page.getByTestId(/^shopping-item-/)).toHaveCount(0);
 await add.click();
 await expect(page.getByText('1 ingredient added to Herbs.')).toBeVisible();
 await page.reload();
 await saved();
 await expect(page.getByTestId(/^shopping-item-/)).toHaveCount(1);
 await expect(page.getByLabel('Check rosemary',{exact:true})).toHaveCount(0);
 await expect(page.getByLabel('Check basil', {exact:true})).toBeVisible();
 await expect(page.getByText('2 bunches',{exact:true})).toBeVisible();
 await page.getByLabel('Check basil', {exact:true}).click();
 await saved();
 await page.getByRole('button',{name:'Add checked to Pantry (1)'}).click();
 await expect(page.getByText('Purchased',{exact:true})).toBeVisible();
 await saved();
 await page.reload();
 await expect(page.getByText('Purchased',{exact:true})).toHaveCount(1);
 await page.goto('./');
 await expect(page.getByText('basil',{exact:true})).toHaveCount(1);
});

for(const nextEdit of [false,true]) test(`a committed purchase with a lost acknowledgement ${nextEdit?'saves a later edit':'retries the same target'}`,async({page})=>{
 test.setTimeout(90000);await page.goto('./');await page.getByRole('button',{name:'Start cooking'}).click();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await page.getByText('Recipes',{exact:true}).last().click();await page.getByRole('button',{name:'Shopping',exact:true}).click();const status=page.getByTestId('shopping-local-persistence-status'),saved=()=>expect(status).toHaveText('Saved on this device only.');await page.getByLabel('New shopping list name').fill('Retry market');await page.getByRole('button',{name:'Create shopping list'}).click();await saved();await page.getByLabel('Shopping item name').fill('Retry carrot');await page.getByRole('button',{name:'Add',exact:true}).click();await saved();await page.getByLabel('Check Retry carrot').click();await saved();
 await page.evaluate(()=>{const put=IDBObjectStore.prototype.put,descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');window.__lostPurchaseAck=false;IDBObjectStore.prototype.put=function(value,key){if(!window.__lostPurchaseAck&&typeof key==='string'&&key.startsWith('["local",')&&JSON.stringify(value).includes('purchase'))this.transaction.__losePurchaseAck=true;return put.call(this,value,key)};Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(fn){descriptor.set.call(this,function(event){if(this.__losePurchaseAck&&!window.__lostPurchaseAck){window.__lostPurchaseAck=true;this.onabort?.call(this,event);return}return fn?.call(this,event)})}})});
 await page.getByRole('button',{name:'Add checked to Pantry (1)'}).click();await expect(status).toContainText('Local save needs attention');expect(await page.evaluate(()=>window.__lostPurchaseAck)).toBe(true);
 if(nextEdit){await page.getByLabel('Shopping item name').fill('Retry soap');await page.getByRole('button',{name:'Add',exact:true}).click()}else{await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByRole('button',{name:'Open settings'}).click();await page.getByRole('button',{name:'Retry local storage'}).click();await expect(page.getByRole('button',{name:'Retry local storage'})).toHaveCount(0);await page.goto('./shopping')}
 await saved();const purchases=await page.evaluate(async()=>{const name=localStorage.getItem('creative-cooking-local-workspace-v1'),db=await new Promise((resolve,reject)=>{const q=indexedDB.open(`${name}-records`);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});try{const rows=await new Promise((resolve,reject)=>{const q=db.transaction('records','readonly').objectStore('records').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});return rows.flatMap(row=>{try{const parsed=JSON.parse(row.inputKey);return parsed[0]==='local'?(parsed[1].commands??[]).filter(c=>c.kind==='purchase').map(c=>c.effectId):[]}catch{return []}})}finally{db.close()}});expect(purchases).toHaveLength(1);await page.reload();await expect(page.getByText('Purchased',{exact:true})).toHaveCount(1);if(nextEdit)await expect(page.getByText('Retry soap',{exact:true})).toBeVisible();await page.goto('./');await expect(page.getByText('Retry carrot',{exact:true})).toHaveCount(1);
});

test('buy again moves a rated pantry item to shopping and purchase restores its rating',async({page})=>{
 test.setTimeout(90_000);
 await page.goto('./');
 await page.getByRole('button',{name:'Start cooking'}).click();

 
 const pantrySaved=()=>expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await pantrySaved();
 await page.getByLabel('Ingredient and details').fill('Smoked paprika');
 await page.getByRole('button',{name:'Add ingredient'}).click();
 await pantrySaved();
 await page.getByTestId(/^pantry-item-/).getByRole('button',{name:'Set preference to 5 out of 5'}).click();
 await pantrySaved();
 await page.getByRole('button',{name:'Buy Smoked paprika again'}).click();
 await expect(page.getByTestId('pantry-notice')).toHaveText('Smoked paprika moved to Shopping list.');
 await pantrySaved();
 await expect(page.getByTestId(/^pantry-item-/)).toHaveCount(0);
 await page.reload();
 await pantrySaved();
 await expect(page.getByTestId(/^pantry-item-/)).toHaveCount(0);
 await page.getByRole('button',{name:'Open Shopping, 1 to buy'}).click();
 const saved=()=>expect(page.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
 await saved();
 await page.getByLabel('Check Smoked paprika').click();
 await saved();
 await page.getByRole('button',{name:'Add checked to Pantry (1)'}).click();
 await expect(page.getByText('Purchased',{exact:true})).toBeVisible();
 await saved();
 await page.goto('./');
 await expect(page.getByText('Smoked paprika',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Food preference 5 out of 5')).toBeVisible();
 await page.reload();
 await expect(page.getByLabel('Food preference 5 out of 5')).toBeVisible();
});
