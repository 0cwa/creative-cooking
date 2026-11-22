import {openHouseholdTools} from './settings-navigation.mjs';
import {readFile} from 'node:fs/promises';
import {test,expect} from './browser-fixture.mjs';

const app='/creative-cooking/';
const recipeTitle='Current market soup';
const originalTitle='Superseded market soup';
const editedTitle='Newcomer market soup';
const originalPantry='Original workspace basil';
const changedPantry='Fresh invitation thyme';
const shoppingList='Invitation market';
const shoppingName='Invitation market carrots';
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const label=(page,name)=>page.getByLabel(name,{exact:true});
const text=(page,name)=>label(page,name).textContent();
const addRecipe=async (page,title,ingredients='2 cups carrots')=>{
 await label(page,'Add recipe').click();
 await label(page,'New recipe title').fill(title);
 await label(page,'New recipe ingredients').fill(ingredients);
 await label(page,'New recipe steps').fill('Simmer gently.');
 await label(page,'Save new recipe').click();
};
const settings=async page=>{
 await page.goto(app+'settings');await openHouseholdTools(page);
 await button(page,'Show device identity').click();
 await button(page,'Invite or join a household').click();
};

test('Settings transfers and reopens a verified recipe document set and new recipes',async({browser,baseURL})=>{
 test.setTimeout(600_000);
 const thirdContext=await browser.newContext({baseURL,acceptDownloads:true});
 const sponsorContext=await browser.newContext({baseURL,acceptDownloads:true});
 const newcomerContext=await browser.newContext({baseURL});
 try{
  const sponsor=await sponsorContext.newPage(),newcomer=await newcomerContext.newPage();
  for(const page of [sponsor,newcomer]){
   page.setDefaultTimeout(12_000);
   await page.goto(app);
   await button(page,'Set up my kitchen').click();

   await button(page,'Accept settings and open my kitchen').click();
   await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  }
  await label(newcomer,'Ingredient and details').fill(originalPantry);
  await label(newcomer,'Add ingredient').click();
  await expect(newcomer.getByText(originalPantry,{exact:true})).toBeVisible();
  await expect(newcomer.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await newcomer.reload();
  await expect(newcomer.getByText(originalPantry,{exact:true})).toBeVisible();

  await sponsor.goto(app+'shopping');
  await label(sponsor,'New shopping list name').fill(shoppingList);
  await button(sponsor,'Create shopping list').click();
  await expect(sponsor.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
  await label(sponsor,'Shopping item name').fill(shoppingName);
  await label(sponsor,'Shopping quantity').fill('2.5');
  await label(sponsor,'Shopping unit').fill('kg');
  await button(sponsor,'Add').click();
  await expect(sponsor.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');

  await sponsor.goto(app+'recipes');
  await addRecipe(sponsor,originalTitle);
  await label(sponsor,'Open recipe '+originalTitle).click();
  await label(sponsor,'Edit recipe '+originalTitle).click();
  await label(sponsor,'Recipe title').fill(recipeTitle);
  await label(sponsor,'Save recipe changes').click();
  await expect(sponsor.getByRole('dialog').getByText(recipeTitle,{exact:true})).toBeVisible();
  await label(sponsor,'Close recipe').click();
  await sponsor.getByRole('tab',{name:/Pantry/}).click();
  await expect(sponsor.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await sponsor.goto(app+'recipes');
  await expect(label(sponsor,'Open recipe '+recipeTitle)).toBeVisible();
  await expect(label(sponsor,'Open recipe '+originalTitle)).toHaveCount(0);

  // Inspect the stored documents from the fixture origin without writing any recipe data.
  await sponsor.goto('/');
  const catalog=await sponsor.evaluate(async ()=>{
   const {default:initLoro,LoroDoc}=await import('loro-crdt/web/loro_wasm.js');
   const {projectCooking,projectRecipes}=await import('/src/loro/domain/app-projection.mjs');
   await initLoro('/src/loro/app/loro_wasm_bg.wasm');
   const request=q=>new Promise((resolve,reject)=>{
    q.onsuccess=()=>resolve(q.result);
    q.onerror=()=>reject(q.error);
   });
   const name=localStorage.getItem('creative-cooking-local-workspace-v1');
   const db=await request(indexedDB.open(`${name}-records`));
   try{
    const store=db.transaction('records','readonly').objectStore('records');
    const keys=await request(store.getAllKeys());
    const entries=await Promise.all(keys.filter(key=>JSON.parse(key)[0]==='recipe-catalog')
     .map(key=>request(store.get(key))));
    const {binding}=entries[0];
    const load=async documentId=>{
     const {bytes}=await request(store.get(JSON.stringify(['document',binding.scopeId,documentId])));
     const doc=new LoroDoc();
     doc.import(bytes);
     return doc;
    };
    const root=binding.sourceDocumentId;
    const [parent,children]=await Promise.all([load(root),Promise.all(entries.map(async ({documentId,objectId})=>{
     const [doc,object]=await Promise.all([load(documentId),
      request(store.get(JSON.stringify(['object',binding.scopeId,objectId])))]);
     const recipes=projectRecipes(doc),envelope=new TextDecoder().decode(object.bytes);
     return {id:documentId,recipes,exposesRecipeId:recipes.some(recipe=>envelope.includes(recipe.id))};
    }))]);
    return {root,rootRecipeIds:Object.keys(parent.getMap('recipe-index').toJSON()),
     children,shopping:projectCooking(parent).shopping};
   }finally{db.close()}
  });
  expect(catalog.children).toHaveLength(1);
  const [child]=catalog.children;
  expect(child.id).not.toBe(catalog.root);
  expect(child.exposesRecipeId).toBe(false);
  expect(catalog.rootRecipeIds).toEqual([]);
  expect(child.recipes.map(recipe=>recipe.title)).toEqual([recipeTitle]);
  expect(catalog.shopping.items).toContainEqual(expect.objectContaining({
   name:shoppingName,displayQuantity:'2.5',displayUnit:'kg',
  }));

  await settings(sponsor);
  await settings(newcomer);
  const identity=await text(newcomer,'Public device identity');
  await label(sponsor,'Recipient public identity').fill(identity);
  await button(sponsor,'Prepare current-cooking invitation').click();
  await expect(label(sponsor,'Public invitation message')).toBeVisible().catch(async error=>{
   console.error('Preparation status',await sponsor.getByRole('alert').allTextContents());
   throw error;
  });
  let offer=await text(sponsor,'Public invitation message');
  expect(JSON.parse(offer).manifestVersion).toBe(5);
  for(const value of [recipeTitle,originalTitle,shoppingName])expect(offer).not.toContain(value);
  let code=await text(sponsor,'Invitation verification code');
  await button(sponsor,'Show public household authority').click();
  await label(newcomer,'Household authority bundle').fill(await text(sponsor,'Public household authority'));
  await label(newcomer,'Confirmed household root').fill(await text(sponsor,'Household root to compare'));
  await label(newcomer,'Confirmed household head').fill(await text(sponsor,'Household head to compare'));
  await button(newcomer,'Verify and accept public authority').click();
  await expect(newcomer.getByText('Public authority accepted. No access or keys have been granted.')).toBeVisible();

  const resume=async (page,confirmation)=>{
   await label(page,'Confirmed invitation code').fill(confirmation);
   await button(page,'Start or resume device verification').click();
  };
  const offerToNewcomer=async()=>{
   await button(newcomer,'Join invitation').click();
   await label(newcomer,'Public invitation message input').fill(offer);
  };
  await offerToNewcomer();
  await resume(newcomer,'0'.repeat(64));
  await expect(newcomer.getByText('CONFIRMATION_REQUIRED',{exact:true})).toBeVisible();
  const downgraded=JSON.parse(offer);
  delete downgraded.manifestVersion;
  await label(newcomer,'Public invitation message input').fill(JSON.stringify(downgraded));
  await resume(newcomer,code);
  await expect(newcomer.getByText('INVALID_PROOF',{exact:true})).toBeVisible();
  const finishVerification=async(reopenOrganizer=false)=>{
   await label(newcomer,'Public invitation message input').fill(offer);
   await resume(newcomer,code);
   await resume(sponsor,code);
   for(const state of ['Exchange your response with the other device.',
    'Exchange your acknowledgement with the other device.','Both devices have completed verification.']){
    const [left,right]=await Promise.all([text(sponsor,'Your verification message'),text(newcomer,'Your verification message')]);
    await label(sponsor,'Other device verification message').fill(right);
    await label(newcomer,'Other device verification message').fill(left);
    for(const page of [sponsor,newcomer]){
     await button(page,'Continue device verification').click();
     await expect(page.getByText(state,{exact:true})).toBeVisible();
    }
    if(reopenOrganizer&&state.startsWith('Exchange your response')){
     await settings(sponsor);
     await label(sponsor,'Recipient public identity').fill(identity);
     await button(sponsor,'Prepare current-cooking invitation').click();
     await expect(label(sponsor,'Public invitation message')).toHaveText(offer);
     await resume(sponsor,code);
     await expect(sponsor.getByText(state,{exact:true})).toBeVisible();
    }
   }
  };
  await finishVerification(true);
  const editor=await sponsorContext.newPage();
  try{
   await editor.goto(app);
   await expect(editor.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
   await label(editor,'Ingredient and details').fill(changedPantry);
   await label(editor,'Add ingredient').click();
   await expect(editor.getByText(changedPantry,{exact:true})).toBeVisible();
   await expect(editor.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  }finally{await editor.close();}
  await button(sponsor,'Admit and download encrypted household file').click();
  await expect(sponsor.getByText('Cooking changed after this invitation was prepared. Restart it and compare a new verification code.')).toBeVisible();
  await expect(button(sponsor,'Admit and download encrypted household file')).toHaveCount(0);
  await expect(sponsor.getByText(/^Encrypted files for household generation/)).toHaveCount(0);
  const previous=JSON.parse(offer),oldCode=code;
  await button(sponsor,'Restart invitation with current cooking').click();
  await expect(label(sponsor,'Public invitation message')).toBeVisible();
  offer=await text(sponsor,'Public invitation message');
  code=await text(sponsor,'Invitation verification code');
  expect(code).not.toBe(oldCode);
  expect(JSON.parse(offer).grant.keyEnvelopeRefs).not.toEqual(previous.grant.keyEnvelopeRefs);
  expect(JSON.parse(offer).item.event.proposalId).toBe(previous.item.event.proposalId);
  await label(newcomer,'Public invitation message input').fill(offer);
  await resume(newcomer,oldCode);
  await expect(newcomer.getByText('CONFIRMATION_REQUIRED',{exact:true})).toBeVisible();
  await finishVerification();
  const download=async (name)=>{
   const pending=sponsor.waitForEvent('download',{timeout:12_000});
   await button(sponsor,name).click();
   return readFile(await (await pending).path());
  };
  const file=await download('Admit and download encrypted household file');
  const recipient=JSON.parse(identity).deviceId;
  await expect(button(sponsor,`Download encrypted file for new device ${recipient}`)).toHaveCount(1);
  await settings(sponsor);
  await label(sponsor,'Previously prepared invitation message').fill(offer);
  expect(await download('Download an already admitted household file')).toEqual(file);

  const install=async (buffer=file)=>{
   const pending=newcomer.waitForEvent('filechooser');
   await button(newcomer,'Choose encrypted household file').click();
   await (await pending).setFiles({name:'household.bin',mimeType:'application/octet-stream',buffer});
  };
  const corrupted=Buffer.from(file);
  corrupted[corrupted.length-1]^=1;
  await install(corrupted);
  await expect(newcomer.getByText('INVALID_FILE',{exact:true})).toBeVisible();
  await expect(button(newcomer,'Open this shared household')).toHaveCount(0);
  await label(newcomer,'Public invitation message input').fill(JSON.stringify(previous));
  await resume(newcomer,oldCode);
  await expect(newcomer.getByText('Both devices have completed verification.')).toBeVisible();
  await install();
  await expect(newcomer.getByText('INVALID_PROOF',{exact:true})).toBeVisible();
  await expect(button(newcomer,'Open this shared household')).toHaveCount(0);
  await label(newcomer,'Public invitation message input').fill(offer);
  await resume(newcomer,code);
  await expect(newcomer.getByText('Both devices have completed verification.')).toBeVisible();
  await install();
  await expect(newcomer.getByText(/^Household installed\./)).toBeVisible();
  await expect(label(newcomer,'Open household')).toContainText('Original local household');
  await settings(newcomer);
  await offerToNewcomer();
  await resume(newcomer,code);
  await expect(newcomer.getByText('Both devices have completed verification.')).toBeVisible();
  await install();
  await expect(newcomer.getByText(/^This household was already installed\./)).toBeVisible();
  await button(newcomer,'Open this shared household').click();
  await expect(newcomer.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(newcomer.getByText(changedPantry,{exact:true})).toBeVisible();

  const checkCooking=async (page,title,ingredient='2 cups carrots')=>{
   await page.goto(app+'recipes');
   await label(page,'Open recipe '+title).click();
   await expect(page.getByText('• '+ingredient,{exact:true})).toBeVisible();
   await expect(page.getByText('1. Simmer gently.',{exact:true})).toBeVisible();
   await page.goto(app+'shopping');
   await expect(page.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
   const list=button(page,shoppingList);
   if(await list.count())await list.click();
   await expect(page.getByText(shoppingName,{exact:true})).toBeVisible();
   await expect(page.getByText('2.5 kg',{exact:true})).toBeVisible();
  };
  await checkCooking(sponsor,recipeTitle);
  await checkCooking(newcomer,recipeTitle);
  await newcomer.goto(app+'recipes');
  await label(newcomer,'Open recipe '+recipeTitle).click();
  await label(newcomer,'Edit recipe '+recipeTitle).click();
  await label(newcomer,'Recipe title').fill(editedTitle);
  await label(newcomer,'Save recipe changes').click();
  await expect(newcomer.getByRole('dialog').getByText(editedTitle,{exact:true})).toBeVisible();
  await label(newcomer,'Close recipe').click();
  await newcomer.getByRole('tab',{name:/Pantry/}).click();
  await expect(newcomer.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally').catch(async error=>{
   await button(newcomer,'Open settings').click();await openHouseholdTools(newcomer);
   const failure=newcomer.getByText('Local data is not being saved',{exact:true});
   console.error('Recipe save status',await failure.locator('..').innerText({timeout:3000}).catch(()=>'(missing error detail)'));
   throw error;
  });
  await newcomer.close();
  const reopened=await newcomerContext.newPage();
  await checkCooking(reopened,editedTitle);

  await reopened.goto(app+'settings');await openHouseholdTools(reopened);
  await button(reopened,'Exchange encrypted cooking files').click();
  const updates=reopened.getByRole('button',{name:/^Download encrypted update /});
  await expect(updates).toHaveCount(2);
  const files=[];
  for(const control of await updates.all()){
   const pending=reopened.waitForEvent('download',{timeout:12_000});
   await control.click();
   const downloaded=await pending;
   files.push(await readFile(await downloaded.path()));
   await downloaded.delete();
  }
  files.sort((a,b)=>JSON.parse(a).header.deviceSequence-JSON.parse(b).header.deviceSequence);
  await sponsor.goto(app+'settings');await openHouseholdTools(sponsor);
  for(const buffer of files){
   await button(sponsor,'Exchange encrypted cooking files').click();
   const pending=sponsor.waitForEvent('filechooser',{timeout:12_000});
   const loaded=sponsor.waitForEvent('load',{timeout:12_000});
   await button(sponsor,'Choose encrypted cooking update').click();
   await (await pending).setFiles({name:'recipe-update.bin',mimeType:'application/octet-stream',buffer});
   await loaded;
  }
  await checkCooking(sponsor,editedTitle);

  const added='Created after admission',edited='Edited after admission';
  const interruptNextCatalogWrite=(page,loseAcknowledgement=false)=>page.evaluate(loseAcknowledgement=>{
   const put=IDBObjectStore.prototype.put;
   IDBObjectStore.prototype.put=function(value,key){
    if(typeof key==='string'&&key.startsWith('["recipe-catalog",')){
     IDBObjectStore.prototype.put=put;
     if(loseAcknowledgement)this.transaction.oncomplete=this.transaction.onabort;
     else throw Error('Interrupted recipe publication');
    }
    return put.call(this,value,key);
   };
  },loseAcknowledgement);
  await reopened.goto(app+'recipes');
  await interruptNextCatalogWrite(reopened);
  await addRecipe(reopened,added,'Fresh turnips');
  await expect(label(reopened,'Retry new recipe save')).toBeEnabled();
  await expect(label(reopened,'Open recipe '+added)).toHaveCount(0);
  await interruptNextCatalogWrite(reopened,true);
  await label(reopened,'Retry new recipe save').click();
  await expect(reopened.getByRole('alert')).toHaveText('IO');
  await expect(label(reopened,'Retry new recipe save')).toBeEnabled();
  await label(reopened,'Retry new recipe save').click();
  await expect(label(reopened,'Open recipe '+added)).toBeVisible();
  await label(reopened,'Open recipe '+added).click();
  await label(reopened,'Edit recipe '+added).click();
  await label(reopened,'Recipe title').fill(edited);
  await label(reopened,'Save recipe changes').click();
  await expect(reopened.getByRole('dialog').getByText(edited,{exact:true})).toBeVisible();
  await label(reopened,'Close recipe').click();
  await reopened.getByRole('tab',{name:/Pantry/}).click();
  await expect(reopened.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally',{timeout:12_000});
  const copyFrom=async(title,ingredient)=>{
   await reopened.goto(app+'recipes');
   await label(reopened,'Open recipe '+title).click();
   await button(reopened,'Add ingredients to shopping list (1)').click();
   await button(reopened,'Add 1 ingredients to list').click();
   await expect(reopened.getByText(`1 ingredient added to ${shoppingList}.`)).toBeVisible();
   await expect(label(reopened,'Check '+ingredient)).toBeVisible();
   if(ingredient==='carrots')await expect(reopened.getByText('2 cups',{exact:true})).toBeVisible();
  };
  await copyFrom(editedTitle,'carrots');
  await copyFrom(edited,'Fresh turnips');
  await reopened.goto(app+'settings');await openHouseholdTools(reopened);
  await button(reopened,'Exchange encrypted cooking files').click();
  const downloads=reopened.getByRole('button',{name:/^Download encrypted update /});
  await expect(downloads).toHaveCount(7);
  const exported=[];
  for(const control of await downloads.all()){
   const pending=reopened.waitForEvent('download');
   const objectId=(await control.textContent()).split(' ').at(-1);
   await control.click();
   const download=await pending;
   const buffer=await readFile(await download.path());
   await download.delete();
   exported.push({objectId,buffer,envelope:JSON.parse(buffer)});
  }
  const creation=exported.find(x=>x.envelope.recipeDelivery?.version===1);
  expect(creation.envelope.recipeDelivery.packets).toHaveLength(1);
  const documentId=creation.envelope.header.documentId;
  const edits=exported.filter(x=>x!==creation&&x.envelope.header.documentId===documentId)
   .sort((a,b)=>a.envelope.header.deviceSequence-b.envelope.header.deviceSequence);
  expect(edits).toHaveLength(2);
  expect(edits[0].envelope.header.deviceSequence).toBeGreaterThan(creation.envelope.header.deviceSequence);
  const openExchange=async()=>{
   await sponsor.goto(app+'settings');await openHouseholdTools(sponsor);
   await button(sponsor,'Exchange encrypted cooking files').click();
   await expect(button(sponsor,'Choose encrypted cooking update')).toBeEnabled();
  };
  const chooseUpdate=async buffer=>{
   const pending=sponsor.waitForEvent('filechooser');
   await button(sponsor,'Choose encrypted cooking update').click();
   await (await pending).setFiles({name:'recipe-update.bin',mimeType:'application/octet-stream',buffer});
  };
  const [seedCopy,newCopy]=exported.filter(x=>x.envelope.header.version===4)
   .sort((a,b)=>a.envelope.header.deviceSequence-b.envelope.header.deviceSequence);
  await openExchange();
  const importedSeedCopy=sponsor.waitForEvent('load');
  await chooseUpdate(seedCopy.buffer);
  await importedSeedCopy;
  await openExchange();
  await chooseUpdate(newCopy.buffer);
  await expect(sponsor.getByText(/MISSING_DEPENDENCY/)).toBeVisible();
  await openExchange();
  await chooseUpdate(edits[0].buffer);
  await expect(sponsor.getByText('Choose the encrypted file that created this recipe first, then choose this edit again.',{exact:true})).toBeVisible();
  await interruptNextCatalogWrite(sponsor);
  await chooseUpdate(creation.buffer);
  await expect(sponsor.getByText('Update not applied: IO.',{exact:true})).toBeVisible();
  await button(sponsor,'Refresh retained cooking updates').click();
  const retry=button(sponsor,`Retry retained update ${creation.objectId}`);
  await expect(retry).toBeEnabled();
  const installedCreation=sponsor.waitForEvent('load');
  await retry.click();
  await installedCreation;
  await openExchange();
  await button(sponsor,'Refresh retained cooking updates').click();
  await button(sponsor,`Retry retained update ${newCopy.objectId}`).click();
  await expect(sponsor.getByText(/MISSING_DEPENDENCY/)).toBeVisible();
  for(const {buffer} of edits){
   await openExchange();
   const loaded=sponsor.waitForEvent('load');
   await chooseUpdate(buffer);
   await loaded;
  }
  await openExchange();
  await button(sponsor,'Refresh retained cooking updates').click();
  const importedNewCopy=sponsor.waitForEvent('load');
  await button(sponsor,`Retry retained update ${newCopy.objectId}`).click();
  await importedNewCopy;
  await openExchange();
  await chooseUpdate(creation.buffer);
  await expect(sponsor.getByText('This exact update was already applied. No new changes were made.',{exact:true})).toBeVisible();

  const evidence=async(page,local)=>{
   await page.goto('/');
   return page.evaluate(async({documentId,objectId,local,head,scopeId,editIds})=>{
    const request=q=>new Promise((resolve,reject)=>{
     q.onsuccess=()=>resolve(q.result);
     q.onerror=()=>reject(q.error);
    });
    const {default:initLoro,LoroDoc}=await import('loro-crdt/web/loro_wasm.js');
    const {projectCooking}=await import('/src/loro/domain/app-projection.mjs');
    await initLoro('/src/loro/app/loro_wasm_bg.wasm');
    const name=localStorage.getItem('creative-cooking-local-workspace-v1');
    const db=await request(indexedDB.open(`${name}-records`));
    try{
     const store=db.transaction('records','readonly').objectStore('records');
     const get=(...key)=>request(store.get(JSON.stringify(key)));
     const keys=(await request(store.getAllKeys())).map(key=>JSON.parse(key));
     const catalogKey=keys.find(key=>key[0]==='recipe-catalog'&&key[1]===scopeId&&key[2]===head);
     const installedKeys=keys.filter(key=>key[0]==='local-key'&&key[2]===scopeId&&key[4]==='data');
     const [catalog,child,object,receipt,editReceipts]=await Promise.all([
      get(...catalogKey),get('document',scopeId,documentId),get(local?'object':'inbox',scopeId,objectId),
      get('applied',scopeId,objectId),Promise.all(editIds.map(id=>get(local?'object':'applied',scopeId,id)))
     ]);
     const root=await get('document',scopeId,catalog.binding.sourceDocumentId);
     const parent=new LoroDoc(),doc=new LoroDoc();
     parent.import(root.bytes);
     doc.import(child.bytes);
     return {objectId:catalog.objectId,documentId:catalog.documentId,separate:catalog.documentId!==catalog.binding.sourceDocumentId,
      rootHasRecipe:!!parent.getMap('recipe-index').get(catalog.recipeId),
      title:doc.getMap('recipe:'+encodeURIComponent(catalog.recipeId)).get('title'),revision:child.revision,
      keySlots:installedKeys.map(key=>key[5]),opaque:!new TextDecoder().decode(object.bytes).includes(catalog.recipeId),
      applied:!!receipt,edits:editReceipts.every(Boolean),
      links:projectCooking(parent).shopping.items.filter(item=>item.recipeId)};
    }finally{db.close();}
   },{documentId,objectId:creation.objectId,local,head:creation.envelope.header.branchHead,
    scopeId:creation.envelope.header.scopeId,editIds:edits.map(x=>x.objectId)});
  };
  const [storedAuthor,storedRecipient]=await Promise.all([evidence(reopened,true),evidence(sponsor,false)]);
  for(const [stored,applied] of [[storedAuthor,false],[storedRecipient,true]]){
   // The editor commits both commands together. File imports apply one at a time.
   expect(stored).toMatchObject({documentId,objectId:creation.objectId,separate:true,rootHasRecipe:false,
    title:edited,revision:applied?edits.length:1,opaque:true,applied,edits:true});
   expect(new Set(stored.keySlots).size).toBeGreaterThanOrEqual(3);
  }
  expect(storedAuthor.links).toEqual(storedRecipient.links);
  expect(storedRecipient.links).toHaveLength(2);
  expect(storedRecipient.links).toEqual(expect.arrayContaining([
   expect.objectContaining({name:'carrots',displayQuantity:'2 cups',recipeId:expect.any(String),ingredientId:expect.any(String)}),
   expect.objectContaining({name:'Fresh turnips',recipeId:expect.any(String),ingredientId:expect.any(String)}),
  ]));
  const recheckSponsor=await sponsorContext.newPage();
  const recheckNewcomer=await newcomerContext.newPage();
  try{
   await Promise.all([recheckSponsor,recheckNewcomer].map(async page=>{
    await checkCooking(page,edited,'Fresh turnips');
    await expect(label(page,'Check carrots')).toBeVisible();
    await expect(label(page,'Check Fresh turnips')).toBeVisible();
   }));
  }finally{
   await recheckSponsor.close();
   await recheckNewcomer.close();
  }

  // Admit a third independently initialized adult from the already installed
  // two-adult document set, using the normal Settings controls on every peer.
  const third=await thirdContext.newPage();third.setDefaultTimeout(20_000);
  await third.goto(app);
  await button(third,'Set up my kitchen').click();

  await button(third,'Accept settings and open my kitchen').click();
  await expect(third.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await settings(third);
  const thirdIdentity=await text(third,'Public device identity');
  await settings(sponsor);
  await settings(reopened);
  const oldIdentity=await text(reopened,'Public device identity');
  for(const page of [sponsor,reopened]){
   await button(page,'Agree to share current cooking').click();
   await button(page,'Sign current-cooking agreement').click();
   await expect(label(page,'Signed current-cooking agreement')).toBeVisible();
  }
  const agreements=await Promise.all([text(sponsor,'Signed current-cooking agreement'),text(reopened,'Signed current-cooking agreement')]);
  for(const page of [sponsor,reopened]){
   for(const agreement of agreements){
    await label(page,'Signed current-cooking agreement input').fill(agreement);
    await button(page,'Add signed agreement').click();
   }
   await button(page,'Verify and retain all agreements').click();
   await expect(page.getByText(/^All required signatures were verified/)).toBeVisible();
  }
  await button(sponsor,'Review an adult invitation').click();
  await label(sponsor,'New invitee public identity').fill(thirdIdentity);
  await button(sponsor,'Create public invitation proposal').click();
  await expect(label(sponsor,'Invitation proposal')).toBeVisible();
  const thirdProposal=await text(sponsor,'Invitation proposal');
  await button(sponsor,'Review current-cooking grant').click();
  await label(sponsor,'Approved invitation for grant').fill(thirdProposal);
  await button(sponsor,'Prepare current-cooking grant').click();
  await expect(label(sponsor,'Prepared cooking grant')).toBeVisible({timeout:90_000}).catch(async error=>{
   console.error('Grant preparation status:',await sponsor.getByRole('alert').allTextContents());throw error;
  });
  const unsignedGrant=await text(sponsor,'Prepared cooking grant');
  await button(reopened,'Review current-cooking grant').click();
  await label(reopened,'Cooking grant to review').fill(unsignedGrant);
  await button(reopened,'Inspect proposed cooking grant').click();
  await expect(label(reopened,'Proposed current cooking')).toContainText(edited,{timeout:60_000});
  await button(reopened,'Sign reviewed cooking grant').click();
  await expect(label(reopened,'Signed cooking grant approval')).toBeVisible();
  await label(sponsor,'Cooking grant to review').fill(unsignedGrant);
  await label(sponsor,'Cooking grant approval input').fill(await text(reopened,'Signed cooking grant approval'));
  await button(sponsor,'Verify and collect grant approval').click();
  await expect(label(sponsor,'Cooking grant with collected approvals')).toBeVisible({timeout:60_000});
  const collected=await text(sponsor,'Cooking grant with collected approvals');
  await button(sponsor,'Verify an existing device').click();
  await label(sponsor,'Collected grant for existing device').fill(collected);
  await label(sponsor,'Existing device public identity').fill(oldIdentity);
  await button(sponsor,'Prepare existing-device verification').click();
  await expect(label(sponsor,'Existing-device verification message')).toBeVisible({timeout:60_000});
  const existingOffer=await text(sponsor,'Existing-device verification message');
  const existingCode=await text(sponsor,'Existing-device verification code');
  expect(Object.keys(JSON.parse(existingOffer).args).sort()).toEqual(['grant','item','manifest','publisherParent']);
  await button(reopened,'Verify an existing device').click();
  await button(reopened,'Verify this existing device').click();
  const wrongParent=JSON.parse(existingOffer);wrongParent.args.publisherParent.authorizationSnapshot='0'.repeat(64);
  await label(reopened,'Existing-device verification message input').fill(JSON.stringify(wrongParent));
  await label(reopened,'Confirmed existing-device code').fill(existingCode);
  await button(reopened,'Start existing-device verification').click();
  await expect(reopened.getByText('INVALID_AUTHORITY',{exact:true})).toBeVisible({timeout:60_000});
  const wrongSignal=JSON.parse(existingOffer);wrongSignal.ceremony.transcript.signaling[1].__bytes[0]^=1;
  await label(reopened,'Existing-device verification message input').fill(JSON.stringify(wrongSignal));
  await label(reopened,'Confirmed existing-device code').fill(existingCode);
  await button(reopened,'Start existing-device verification').click();
  await expect(reopened.getByText('INVALID_PROOF',{exact:true})).toBeVisible({timeout:60_000});
  await label(reopened,'Existing-device verification message input').fill(existingOffer);
  for(const page of [sponsor,reopened]){
   await label(page,'Confirmed existing-device code').fill(existingCode);
   await button(page,'Start existing-device verification').click();
  }
  for(const state of ['Exchange the response with the other device.','Exchange the ack with the other device.','Existing-device verification complete.']){
   const [left,right]=await Promise.all([text(sponsor,'Existing-device outgoing message'),text(reopened,'Existing-device outgoing message')]);
   await label(sponsor,'Other existing-device message').fill(right);
   await label(reopened,'Other existing-device message').fill(left);
   for(const page of [sponsor,reopened]){
    await button(page,'Continue existing-device verification').click();
    await expect(page.getByText(state,{exact:true})).toBeVisible({timeout:60_000}).catch(async error=>{
     console.error('Existing-device verification:',await page.getByRole('alert').allTextContents());throw error;
    });
   }
  }
  await button(sponsor,'Show existing-device evidence').click();
  const existingProof=await text(sponsor,'Existing-device evidence');
  await label(sponsor,'Collected grant for invitation').fill(collected);
  await button(sponsor,'Prepare invitation from collected grant').click();
  await expect(label(sponsor,'Public invitation message')).toBeVisible();
  const nextOffer=await text(sponsor,'Public invitation message'),nextCode=await text(sponsor,'Invitation verification code');
  await label(sponsor,'Completed existing-device evidence').fill(existingProof);
  await button(sponsor,'Collect existing-device evidence').click();
  await button(sponsor,'Show public household authority').click();
  await label(third,'Household authority bundle').fill(await text(sponsor,'Public household authority'));
  await label(third,'Confirmed household root').fill(await text(sponsor,'Household root to compare'));
  await label(third,'Confirmed household head').fill(await text(sponsor,'Household head to compare'));
  await button(third,'Verify and accept public authority').click();
  await button(third,'Join invitation').click();
  await label(third,'Public invitation message input').fill(nextOffer);
  for(const page of [sponsor,third]){
   await label(page,'Confirmed invitation code').fill(nextCode);
   await button(page,'Start or resume device verification').click();
  }
  for(const state of ['Exchange your response with the other device.','Exchange your acknowledgement with the other device.','Both devices have completed verification.']){
   const [left,right]=await Promise.all([text(sponsor,'Your verification message'),text(third,'Your verification message')]);
   await label(sponsor,'Other device verification message').fill(right);
   await label(third,'Other device verification message').fill(left);
   for(const page of [sponsor,third]){
    await button(page,'Continue device verification').click();
    await expect(page.getByText(state,{exact:true})).toBeVisible({timeout:60_000});
   }
  }
  await button(sponsor,'Publish verified household generation').click();
  await expect(sponsor.getByText(/Household generation 3 was published/)).toBeVisible({timeout:120_000}).catch(async error=>{console.error('Publication status:',await sponsor.getByRole('alert').allTextContents());throw error;});
  const oldDevice=JSON.parse(oldIdentity).deviceId,thirdDevice=JSON.parse(thirdIdentity).deviceId;
  const oldFile=await download(`Download encrypted file for existing device ${oldDevice}`);
  const thirdFile=await download(`Download encrypted file for new device ${thirdDevice}`);
  const oldChooser=reopened.waitForEvent('filechooser');
  await button(reopened,'Install and open household generation').click();
  await (await oldChooser).setFiles({name:'existing.bin',mimeType:'application/octet-stream',buffer:oldFile});
  await expect(reopened.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally',{timeout:60_000});
  await reopened.goto(app+'settings');await openHouseholdTools(reopened);
  await expect(label(reopened,'Household document generation')).toHaveText('Household generation 3',{timeout:60_000});
  const thirdChooser=third.waitForEvent('filechooser');
  await button(third,'Choose encrypted household file').click();
  await (await thirdChooser).setFiles({name:'third.bin',mimeType:'application/octet-stream',buffer:thirdFile});
  await expect(third.getByText(/^Household installed\./)).toBeVisible({timeout:90_000}).catch(async error=>{console.error('Third install:',await third.getByRole('alert').allTextContents());throw error;});
  await button(third,'Open this shared household').click();
  await expect(third.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally',{timeout:60_000});
  await third.goto(app+'settings');await openHouseholdTools(third);
  await expect(label(third,'Household document generation')).toHaveText('Household generation 3',{timeout:60_000});
  await button(sponsor,'Reopen household after admission').click();
  await expect(sponsor.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally',{timeout:60_000});
  await sponsor.goto(app+'settings');await openHouseholdTools(sponsor);
  await expect(label(sponsor,'Household document generation')).toHaveText('Household generation 3',{timeout:60_000});
  for(const page of [sponsor,reopened,third])await checkCooking(page,edited,'Fresh turnips');
  await third.goto(app+'recipes');
  await expect(label(third,'Open recipe '+originalTitle)).toHaveCount(0);
  const thirdEdit='Third adult saved recipe',thirdShopping='Third adult saved shopping';
  await third.goto(app+'recipes');
  await label(third,'Open recipe '+edited).click();
  await label(third,'Edit recipe '+edited).click();
  await label(third,'Recipe title').fill(thirdEdit);
  await label(third,'Save recipe changes').click();
  await expect(third.getByRole('dialog').getByText(thirdEdit,{exact:true})).toBeVisible();
  await label(third,'Close recipe').click();
  await third.getByRole('tab',{name:/Pantry/}).click();
  await expect(third.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally',{timeout:60_000});
  await third.goto(app+'shopping');
  await label(third,'Shopping item name').fill(thirdShopping);
  await button(third,'Add').click();
  await expect(third.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
  await third.goto(app+'recipes');
  await expect(label(third,'Open recipe '+thirdEdit)).toBeVisible({timeout:60_000});
  await third.goto(app+'settings');await openHouseholdTools(third);
  await button(third,'Exchange encrypted cooking files').click();
  const thirdUpdates=third.getByRole('button',{name:/^Download encrypted update /});
  await expect(thirdUpdates).not.toHaveCount(0);
  const thirdFiles=[];
  for(const control of await thirdUpdates.all()){
   const pending=third.waitForEvent('download');await control.click();
   const downloaded=await pending,buffer=await readFile(await downloaded.path());
   thirdFiles.push({buffer,envelope:JSON.parse(buffer)});await downloaded.delete();
  }
  thirdFiles.sort((a,b)=>a.envelope.header.deviceSequence-b.envelope.header.deviceSequence);
  expect(new Set(thirdFiles.map(file=>file.envelope.header.documentId)).size).toBeGreaterThan(1);
  for(const page of [sponsor,reopened])for(const {buffer} of thirdFiles){
   await page.goto(app+'settings');await openHouseholdTools(page);await button(page,'Exchange encrypted cooking files').click();
   const pending=page.waitForEvent('filechooser'),loaded=page.waitForEvent('load');
   await button(page,'Choose encrypted cooking update').click();
   await (await pending).setFiles({name:'third-update.bin',mimeType:'application/octet-stream',buffer});
   await loaded;
  }
  for(const page of [sponsor,reopened]){
   await checkCooking(page,thirdEdit,'Fresh turnips');
   await expect(page.getByText(thirdShopping,{exact:true})).toBeVisible();
  }

  await reopened.goto(app);
  await expect(reopened.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await button(reopened,'Open settings').click();await openHouseholdTools(reopened);
  await button(reopened,'Show device identity').click();
  await button(reopened,'Return to original local household').click();
  await expect(reopened.getByText(originalPantry,{exact:true})).toBeVisible().catch(async error=>{
   console.error('Return to original household',reopened.url(),await reopened.getByRole('alert').allTextContents());
   throw error;
  });
  await reopened.goto(app+'recipes');
  await expect(label(reopened,'Open recipe '+editedTitle)).toHaveCount(0);
 }finally{
  await newcomerContext.close();
  await sponsorContext.close();
  await thirdContext.close();
 }
});

test('Recipe creation preserves the original submission and retries a saved recipe refresh without writing again',async({page})=>{
 const title='Retry market soup';
 await page.goto(app);
 await button(page,'Set up my kitchen').click();

 await button(page,'Accept settings and open my kitchen').click();
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.goto(app+'recipes');
 await expect(label(page,'Add recipe')).toBeEnabled();

 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put,getAllKeys=IDBObjectStore.prototype.getAllKeys;
  const writes=[];
  let failRefresh=false,readFaults=0;
  IDBObjectStore.prototype.put=function(value,key){
   if(typeof key==='string'&&key.startsWith('["recipe-catalog",')){
    writes.push([key,value.effectId]);
    if(writes.length===1)throw Error('Injected recipe publication failure');
    if(writes.length===2)failRefresh=true;
   }
   return put.call(this,value,key);
  };
  IDBObjectStore.prototype.getAllKeys=function(...args){
   if(failRefresh&&this.name==='records'&&this.transaction.mode==='readonly'){
    failRefresh=false;
    readFaults++;
    throw Error('Injected recipe refresh failure');
   }
   return getAllKeys.apply(this,args);
  };
  globalThis.recipeSaveProof=()=>({writes,readFaults});
 });

 await addRecipe(page,title);
 await expect(label(page,'Retry new recipe save')).toBeEnabled();
 await expect(label(page,'New recipe title')).not.toBeEditable();
 await expect(page.getByText(`Resolve the save for ${title} before submitting another recipe.`)).toBeVisible();
 await label(page,'Cancel new recipe').click();
 await label(page,'Add recipe').click();
 await label(page,'Retry new recipe save').click();
 await expect(page.getByText('Recipe saved. Refresh cooking to see it.',{exact:true})).toBeVisible();
 await expect(label(page,'New recipe title')).toHaveCount(0);
 await expect(label(page,'Add recipe')).toBeDisabled();
 const beforeRefresh=await page.evaluate(()=>globalThis.recipeSaveProof());
 expect(beforeRefresh.readFaults).toBe(1);
 expect(beforeRefresh.writes).toHaveLength(2);
 expect(beforeRefresh.writes[1]).toEqual(beforeRefresh.writes[0]);

 await button(page,'Retry cooking refresh').click();
 await expect(label(page,'Open recipe '+title)).toHaveCount(1);
 await expect(page.getByText('Recipe saved.',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>globalThis.recipeSaveProof())).toEqual(beforeRefresh);

 await page.reload();
 await expect(label(page,'Open recipe '+title)).toHaveCount(1);
});

test('Recipe retry checks new allergies only when the recipe has not committed',async({page})=>{
 await page.goto(app);
 await button(page,'Set up my kitchen').click();

 await button(page,'Accept settings and open my kitchen').click();
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.goto(app+'recipes');

 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put;
  let fault='rollback',attempts=0;
  IDBObjectStore.prototype.put=function(value,key){
   if(typeof key==='string'&&key.startsWith('["recipe-catalog",')){
    attempts++;
    const next=fault;
    fault=null;
    if(next==='rollback')throw Error('Injected recipe write failure');
    // Deliver the failure callback after IndexedDB actually commits.
    if(next==='lose-ack')this.transaction.oncomplete=this.transaction.onabort;
   }
   return put.call(this,value,key);
  };
  globalThis.recipeAttempts=()=>attempts;
  globalThis.loseRecipeSaveAcknowledgement=()=>{fault='lose-ack';};
 });

 const addAllergyAndReturn=async allergy=>{
  await label(page,'Cancel new recipe').click();
  await expect(page.locator('[aria-label="New recipe title"]')).toHaveCount(0);
  await button(page,'Open settings').click();await openHouseholdTools(page);
  const input=page.getByRole('textbox',{name:'Add allergies',exact:true});
  await input.fill(allergy);
  await expect(input).toHaveValue(allergy);
  await input.press('Enter');
  await expect(button(page,`Remove allergy ${allergy}`)).toBeVisible();
  await button(page,'Back').click();
  await label(page,'Add recipe').click();
 };
 await addRecipe(page,'Corrected recipe');
 await expect(label(page,'Retry new recipe save')).toBeEnabled();
 await addAllergyAndReturn('carrots');
 await label(page,'Retry new recipe save').click();
 await expect(page.getByRole('alert')).toContainText('Recipe blocked by allergy validation');
 await expect(label(page,'New recipe ingredients')).toBeEditable();
 expect(await page.evaluate(()=>globalThis.recipeAttempts())).toBe(1);
 await label(page,'New recipe ingredients').fill('2 cups rice');
 await label(page,'Save new recipe').click();
 await expect(label(page,'Open recipe Corrected recipe')).toBeVisible();

 await page.evaluate(()=>globalThis.loseRecipeSaveAcknowledgement());
 await label(page,'Add recipe').click();
 await label(page,'New recipe title').fill('Already committed recipe');
 await label(page,'New recipe ingredients').fill('2 cups peanuts');
 await label(page,'New recipe steps').fill('Simmer gently.');
 await label(page,'Save new recipe').click();
 await expect(label(page,'Retry new recipe save')).toBeEnabled();
 await addAllergyAndReturn('peanuts');
 await label(page,'Retry new recipe save').click();
 await expect(label(page,'Open recipe Already committed recipe')).toHaveCount(1);
 expect(await page.evaluate(()=>globalThis.recipeAttempts())).toBe(3);
});
