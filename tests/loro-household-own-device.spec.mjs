import {openHouseholdTools} from './settings-navigation.mjs';
import {test,expect} from './browser-fixture.mjs';
import {readFile} from 'node:fs/promises';

const button=(page,name)=>page.getByRole('button',{name,exact:true});
const label=(page,name)=>page.getByLabel(name,{exact:true});
const click=(page,name)=>button(page,name).click();
const notice=(page,text)=>expect(page.getByText(text,{exact:true})).toBeVisible();

async function start(page){
 await page.goto('./');
 await click(page,'Set up my kitchen');

 await click(page,'Accept settings and open my kitchen');
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
}
async function addIngredient(page,name){
 await label(page,'Ingredient and details').fill(name);
 await label(page,'Add ingredient').click();
 await expect(page.getByText(name,{exact:true})).toBeVisible();
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
}
async function choose(page,bytes){
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),click(page,'Choose encrypted household pairing file')]);
 await chooser.setFiles({name:'own-device.cchouse',mimeType:'application/octet-stream',buffer:bytes});
 await notice(page,'Encrypted household pairing file selected.');
}
async function download(page,action){
 const [file]=await Promise.all([page.waitForEvent('download'),click(page,action)]);
 return readFile(await file.path());
}
async function proof(from,to){
 await label(to,'Incoming household pairing proof').fill(await label(from,'My household pairing proof').inputValue());
 await click(to,'Accept household pairing proof');
 await expect(label(to,'Incoming household pairing proof')).toHaveValue('');
}
async function settings(page){
 await page.goto('./settings');await openHouseholdTools(page);
 await click(page,'Pair my household devices');
}
async function history(page){
 await click(page,'Show verified household device history');
 await expect(label(page,'Verified household device history')).toBeVisible();
 return label(page,'Verified household device history').textContent();
}
async function authority(page,scopeId){
 return page.evaluate(async scope=>{
  const get=request=>new Promise((resolve,reject)=>{
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const name=localStorage.getItem('creative-cooking-local-workspace-v1');
  const db=await get(indexedDB.open(name+'-records'));
  try{
   const store=db.transaction('records').objectStore('records');
   const record=await get(store.get(JSON.stringify(['pairing-authority','household',scope])));
   if(!record)return null;
   const events=JSON.parse(new TextDecoder().decode(record.authorityState)).events;
   const objects=await get(store.getAll());
   const headers=objects.flatMap(row=>{
    if(row?.branchHead!==record.acceptedParent||!(row.bytes instanceof Uint8Array))return [];
    try{return [JSON.parse(new TextDecoder().decode(row.bytes)).header]}catch{return []}
   }).filter(Boolean);
   return {head:record.acceptedParent,revision:record.revision,events,headers};
  }finally{db.close();}
 },scopeId);
}
async function joinedCounter(page,scopeId,{remove=false,rollback=false}={}){
 return page.evaluate(async({scope,remove,rollback})=>{
  const req=request=>new Promise((resolve,reject)=>{
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
   request.onblocked=()=>reject(Error('Blocked sequence fixture'));
  });
  const name=localStorage.getItem('creative-cooking-local-workspace-v1');
  const enrollmentDb=await req(indexedDB.open(name+'-joined'));
  const tx=enrollmentDb.transaction('enrollments',rollback?'readwrite':'readonly');
  const completed=new Promise((resolve,reject)=>{
   tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });
  const store=tx.objectStore('enrollments');
  const enrollment=await req(store.get(scope));
  if(rollback){
   if(enrollment.stage!=='active')throw Error('Expected an active enrollment fixture');
   store.put({...enrollment,stage:'pending'},scope);
  }
  await completed;
  enrollmentDb.close();
  const databaseName=enrollment.sequenceName+'-sequences';
  if(remove){
   await req(indexedDB.deleteDatabase(databaseName));
   return databaseName;
  }
  const db=await req(indexedDB.open(databaseName));
  try{return await req(db.transaction('sequences').objectStore('sequences').get(JSON.stringify(['counter',scope])))}
  finally{db.close()}
 },{scope:scopeId,remove,rollback});
}

for(const copiesRecipes of [false,true])test(`same-adult household Settings verifies, resumes, installs and opens a separate device${copiesRecipes?' with separate recipes':''}`,async({browser,baseURL})=>{
 test.setTimeout(180000);
 const sponsorContext=await browser.newContext({baseURL}),receiverContext=await browser.newContext({baseURL});
 try{
  const sponsor=await sponsorContext.newPage(),receiver=await receiverContext.newPage();
  for(const page of [sponsor,receiver])page.on('pageerror',error=>console.error(error.message));
  await start(sponsor);
  await start(receiver);
  await addIngredient(sponsor,'Sponsor basil');
  const recipe='Paired market stew';
  if(copiesRecipes){
   await sponsor.goto('./recipes');
   await label(sponsor,'Add recipe').click();
   await label(sponsor,'New recipe title').fill(recipe);
   await label(sponsor,'New recipe ingredients').fill('2 cups carrots');
   await label(sponsor,'New recipe steps').fill('Stir, then simmer.');
   await label(sponsor,'Save new recipe').click();
   await expect(label(sponsor,'Open recipe '+recipe)).toBeVisible();
  }
  await addIngredient(receiver,'Original receiver thyme');
  await receiver.goto('./chef');
  await label(receiver,'Private cooking note').fill('Receiver private cooking notes');
  await label(receiver,'Save note').click();
  await notice(receiver,'Saved on this device');
  await settings(sponsor);
  await settings(receiver);
  const original=await label(receiver,'Open household').textContent();
  const pin=await label(sponsor,'Household pairing root to compare').textContent();
  const head=await label(sponsor,'Household pairing head to compare').textContent();
  await history(sponsor);
  const beforeAdults=await sponsor.getByText(/^Adults /).textContent();
  const beforeRule=await sponsor.getByText(/^Adult approval threshold /).textContent();
  const sponsorFingerprint=await label(sponsor,'This household pairing device fingerprint').textContent();
  const recipientFingerprint=await label(receiver,'This household pairing device fingerprint').textContent();
  expect(sponsorFingerprint).not.toBe(recipientFingerprint);
  await click(receiver,'Receive my household access');
  await click(sponsor,'Sponsor my other household device');
  const request=await label(receiver,'My household pairing request').inputValue();
  await label(sponsor,'Incoming household pairing request').fill(request);
  await label(sponsor,'Confirmed household peer fingerprint').fill('0'.repeat(64));
  await click(sponsor,'Prepare household pairing proposal');
  await notice(sponsor,'The confirmed household root, head, device fingerprint or transcript did not match.');
  await label(sponsor,'Confirmed household peer fingerprint').fill(recipientFingerprint);
  await click(sponsor,'Prepare household pairing proposal');
  const proposal=await label(sponsor,'My household pairing proposal').inputValue();
  const {bundle,adultId,transcript}=JSON.parse(proposal),scope=bundle.scope.id;
  await label(receiver,'Incoming household pairing proposal').fill(proposal);
  await click(receiver,'Review household pairing proposal');
  const code=await label(sponsor,'Household pairing transcript to compare').textContent();
  await expect(label(receiver,'Household pairing transcript to compare')).toHaveText(code);
  for(const [page,fingerprint] of [[sponsor,recipientFingerprint],[receiver,sponsorFingerprint]]){
   await label(page,'Confirmed household peer fingerprint').fill(fingerprint);
   await label(page,'Confirmed pairing household root').fill(pin);
   await label(page,'Confirmed pairing household head').fill(head);
   await label(page,'Confirmed household pairing transcript').fill(code);
   await click(page,'Confirm household pairing on this device');
   await expect(label(page,'My household pairing proof')).toBeVisible();
  }
  await proof(sponsor,receiver);
  await receiver.reload();
  await openHouseholdTools(receiver);
  await click(receiver,'Pair my household devices');
  await click(receiver,'Receive my household access');
  await proof(receiver,sponsor);
  await proof(sponsor,receiver);
  await proof(receiver,sponsor);
  const verified='Both devices proved possession of their household pairing keys.';
  await notice(receiver,verified);
  await notice(sponsor,verified);
  const file=await download(sponsor,'Save encrypted household pairing file');
  const same=await download(sponsor,'Save encrypted household pairing file');
  expect(same.equals(file)).toBe(true);
  const bad=Buffer.from(file);bad[bad.length-1]^=1;
  await choose(receiver,bad);
  await click(receiver,'Install verified household device');
  await notice(receiver,'Household pairing could not continue. Check the verified message or file and try again.');
  expect(await authority(receiver,scope)).toBeNull();
  await choose(receiver,file);
  await click(receiver,'Install verified household device');
  await notice(receiver,'Household installed. Open it when you are ready to switch.');
  await expect(label(receiver,'Open household')).toHaveText(original);
  const installed=await authority(receiver,scope);
  await click(receiver,'Install verified household device');
  await notice(receiver,'The same household pairing is already installed.');
  expect(await authority(receiver,scope)).toEqual(installed);
  await receiver.reload();
  await openHouseholdTools(receiver);
  await click(receiver,'Pair my household devices');
  await click(receiver,'Receive my household access');
  await click(receiver,'Open paired household');
  await notice(receiver,'Sponsor basil');
  await expect(receiver.getByText('Original receiver thyme',{exact:true})).toHaveCount(0);
  await addIngredient(receiver,'Paired device coriander');
  await receiver.reload();
  await notice(receiver,'Paired device coriander');

  const after=await authority(receiver,scope);
  expect(after.events.at(-1).event.version).toBe(copiesRecipes?5:4);
  expect(after.headers).toEqual([expect.objectContaining({authorDevice:transcript.responder.deviceId,deviceSequence:1,
   documentId:after.events.at(-1).event.subject.documentId,branchHead:after.head})]);
  await click(sponsor,'Reopen household after device pairing');
  await notice(sponsor,'Sponsor basil');
  if(copiesRecipes){
   await receiver.goto('./recipes');
   await label(receiver,'Open recipe '+recipe).click();
   await label(receiver,'Edit recipe '+recipe).click();
   const edited='Paired market stew with basil';
   await label(receiver,'Recipe title').fill(edited);
   await label(receiver,'Save recipe changes').click();
   await expect(receiver.getByRole('dialog').getByText(edited,{exact:true})).toBeVisible();
   await expect.poll(async()=>(await authority(receiver,scope)).headers,
    {timeout:15_000}).toContainEqual(expect.objectContaining({documentId:expect.stringMatching(/^recipe-v1-/),
    authorDevice:transcript.responder.deviceId,branchHead:after.head,disclosureIncomplete:true}));
   await receiver.reload();
   await expect(label(receiver,'Open recipe '+edited)).toBeVisible();
  }
  const [source,joined]=[sponsor,receiver];
  for(const page of [source,joined]){
   await settings(page);
   const text=await history(page);
   await expect(page.getByText(/^Adults /)).toHaveText(beforeAdults);
   await expect(page.getByText(/^Adult approval threshold /)).toHaveText(beforeRule);
   expect(text).toContain(`Paired ${transcript.responder.deviceId} by ${transcript.initiator.deviceId} for ${adultId}`);
  }
  expect(await label(sponsor,'Verified household device history').textContent()).toBe(await label(receiver,'Verified household device history').textContent());
  if(copiesRecipes){
   await click(sponsor,'Sponsor my other household device');
   expect((await download(sponsor,'Save encrypted household pairing file')).equals(file)).toBe(true);
  }
  await receiver.goto('./chef');
  await notice(receiver,'Receiver private cooking notes');
  await receiver.goto('./settings');await openHouseholdTools(receiver);
  await click(receiver,'Show device identity');
  await click(receiver,'Return to original local household');
  try{await notice(receiver,'Original receiver thyme')}
  catch(error){console.error('Return to original household',receiver.url(),await receiver.getByRole('alert').allTextContents());throw error}
  await settings(receiver);
  await click(receiver,'Receive my household access');
  await expect(button(receiver,'Open paired household')).toBeVisible();
  if(copiesRecipes){
   const beforeRetry=await authority(receiver,scope);
   const sequence=await joinedCounter(receiver,scope);
   expect(sequence).toBeGreaterThan(1);
   await choose(receiver,file);
   await click(receiver,'Install verified household device');
   await notice(receiver,'The same household pairing is already installed.');
   expect(await authority(receiver,scope)).toEqual(beforeRetry);
   expect(await joinedCounter(receiver,scope)).toBe(sequence);
   const counter=await joinedCounter(receiver,scope,{remove:true});
   await click(receiver,'Install verified household device');
   await notice(receiver,'Household pairing could not continue. Check the verified message or file and try again.');
   expect(await receiver.evaluate(async name=>(await indexedDB.databases()).some(db=>db.name===name),counter)).toBe(false);
   await joinedCounter(receiver,scope,{remove:true,rollback:true});
   await click(receiver,'Install verified household device');
   await notice(receiver,'Household pairing could not continue. Check the verified message or file and try again.');
   expect(await receiver.evaluate(async name=>(await indexedDB.databases()).some(db=>db.name===name),counter)).toBe(false);
  }
  await click(receiver,'Create a fresh household pairing request');
  await expect(button(receiver,'Open paired household')).toHaveCount(0);
  const renewed=JSON.parse(await label(receiver,'My household pairing request').inputValue());
  expect(renewed.request.nonce).not.toBe(JSON.parse(request).request.nonce);
 }finally{
  await sponsorContext.close();
  await receiverContext.close();
 }
});
