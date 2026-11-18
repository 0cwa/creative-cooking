import {test,expect} from './browser-fixture.mjs';
import {readFile} from 'node:fs/promises';
import {LoroDoc} from 'loro-crdt/nodejs';

const button=(page,name)=>page.getByRole('button',{name,exact:true});
const label=(page,name)=>page.getByLabel(name,{exact:true});
const click=(page,name)=>button(page,name).click();
const text=(page,name)=>label(page,name).textContent();
const privateMessage='Private soup question from the first device';
const recipientOriginal='The recipient’s original cooking notes';
const recipientEdit='Saved by the verified second device';
const credential='fixture-pairing-credential-it-stays-local';

async function start(page){
 await page.goto('./');
 await click(page,'Start fresh local preview');
 await click(page,'Review household policy');
 await click(page,'Accept this household policy');
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.goto('./settings');
 await expect(label(page,'This personal device')).toBeVisible();
}
async function saveMessage(page,message){
 await page.goto('./chef');
 await label(page,'Message Chef').fill(message);
 await label(page,'Save private message').click();
 await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
 await page.goto('./settings');
}
async function transferProof(from,to){
 await label(to,'Incoming personal pairing proof').fill(await label(from,'My personal pairing proof').inputValue());
 await click(to,'Accept personal pairing proof');
 await expect(label(to,'Incoming personal pairing proof')).toHaveValue('');
}
async function choose(page,bytes){
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),click(page,'Choose encrypted personal pairing file')]);
 await chooser.setFiles({name:'personal.ccpair',mimeType:'application/octet-stream',buffer:bytes});
 await expect(page.getByText(/^Encrypted pairing file selected/)).toBeVisible();
}

async function databaseState(page){
 return page.evaluate(async()=>{
  const name=localStorage.getItem('creative-cooking-local-workspace-v1')+'-records';
  const get=request=>new Promise((resolve,reject)=>{
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const db=await get(indexedDB.open(name));
  try{
   const store=db.transaction('records').objectStore('records');
   const [keys,values]=await Promise.all([get(store.getAllKeys()),get(store.getAll())]);
   const wire=JSON.stringify([keys,values],(_key,value)=>value instanceof Uint8Array?Array.from(value):value);
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(wire));
   return Array.from(new Uint8Array(digest));
  }finally{db.close()}
 });
}

async function advanceAuthority(page,scopeId,restoreRevision){
 return page.evaluate(async({scopeId,restoreRevision})=>{
  const name=localStorage.getItem('creative-cooking-local-workspace-v1')+'-records';
  const get=request=>new Promise((resolve,reject)=>{
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const db=await get(indexedDB.open(name));
  try{
   const tx=db.transaction('records','readwrite'),store=tx.objectStore('records');
   const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
   const keys=await get(store.getAllKeys());
   const slot=keys.find(key=>{const [tag,kind,id]=JSON.parse(key);return tag==='pairing-authority'&&kind==='personal'&&id===scopeId});
   const current=await get(store.get(slot));
   const revision=current.revision;
   await get(store.put({...current,revision:restoreRevision??revision+1},slot));
   await done;
   return revision;
  }finally{db.close()}
 },{scopeId,restoreRevision});
}

async function installedSnapshot(page,scopeId){
 return page.evaluate(async scopeId=>{
  const name=localStorage.getItem('creative-cooking-local-workspace-v1')+'-records';
  const get=request=>new Promise((resolve,reject)=>{
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const db=await get(indexedDB.open(name));
  try{
   const store=db.transaction('records').objectStore('records'),keys=await get(store.getAllKeys());
   const slot=keys.find(key=>{const [tag,scope]=JSON.parse(key);return tag==='document'&&scope===scopeId});
   return Array.from((await get(store.get(slot))).bytes);
  }finally{db.close()}
 },scopeId);
}

async function failWritesAt(page,index){
 await page.evaluate(target=>{
  const original=window.personalPairingOriginalPut??=IDBObjectStore.prototype.put;
  window.personalPairingWrites=0;
  IDBObjectStore.prototype.put=function(...args){
   if(this.name==='records'&&++window.personalPairingWrites===target)throw Error('Injected pairing transaction fault');
   return original.apply(this,args);
  };
 },index);
}

test('Settings pairs independently provisioned personal devices and reopens the verified copy',async({browser,baseURL})=>{
 test.setTimeout(180000);
 const sourceContext=await browser.newContext({baseURL});
 const receiverContext=await browser.newContext({baseURL});
 const otherContext=await browser.newContext({baseURL});
 try{
  const source=await sourceContext.newPage(),receiver=await receiverContext.newPage(),other=await otherContext.newPage();
  await test.step('create independent devices, private messages and a configured provider credential',async()=>{
   await start(source);await start(receiver);await start(other);
   await source.getByPlaceholder('API key',{exact:true}).fill(credential);
   await source.getByRole('button',{name:/^Save .+ API key$/}).click();
   await expect(source.getByText('Connected',{exact:true})).toBeVisible();
   await saveMessage(source,privateMessage);
   await saveMessage(receiver,recipientOriginal);
  });
  const [sourceId,receiverId,sourcePin,originalPin,sourceFingerprint,receiverFingerprint,originalHousehold]=await Promise.all([
   text(source,'This personal device'),text(receiver,'This personal device'),text(source,'This workspace personal root pin'),
   text(receiver,'This workspace personal root pin'),text(source,'This personal device fingerprint'),
   text(receiver,'This personal device fingerprint'),text(receiver,'Open household')
  ]);
  expect(sourceId).not.toBe(receiverId);
  expect(sourcePin).not.toBe(originalPin);
  expect(originalHousehold).not.toBe(await text(source,'Open household'));

  await click(receiver,'Show verified personal device history');
  const otherOwner=(await receiver.getByText(/^Personal owner /).textContent()).split(' ').at(-1);
  let scopeId;
  await test.step('confirm independent device fingerprints, pinned root and matching transcript on each device',async()=>{
   await click(receiver,'Receive my private copy');
   await click(source,'Pair from this device');
   const request=await label(receiver,'My personal pairing request').inputValue();
   await label(source,'Incoming personal pairing request').fill(request);
   await label(source,'Confirmed peer device fingerprint').fill('0'.repeat(64));
   await click(source,'Prepare personal pairing proposal');
   await expect(source.getByText(/^The independently confirmed fingerprint/)).toBeVisible();
   await label(source,'Confirmed peer device fingerprint').fill(receiverFingerprint);
   await click(source,'Prepare personal pairing proposal');
   const proposal=await label(source,'My personal pairing proposal').inputValue(),wrongOwner=JSON.parse(proposal);
   scopeId=wrongOwner.transcript.scope.id;
   wrongOwner.context.ownerId=otherOwner;
   await label(receiver,'Incoming personal pairing proposal').fill(JSON.stringify(wrongOwner));
   const before=await databaseState(receiver);
   await click(receiver,'Review personal pairing proposal');
   await expect(receiver.getByText(/^Pairing could not continue/)).toBeVisible();
   expect(await databaseState(receiver)).toEqual(before);
   await click(other,'Receive my private copy');
   await label(other,'Incoming personal pairing proposal').fill(proposal);
   await click(other,'Review personal pairing proposal');
   await expect(other.getByText(/^Pairing could not continue/)).toBeVisible();
   await label(receiver,'Incoming personal pairing proposal').fill(proposal);
   await click(receiver,'Review personal pairing proposal');
   const code=await text(source,'Pairing transcript code');
   await expect(label(receiver,'Pairing transcript code')).toHaveText(code);
   await label(receiver,'Confirmed peer device fingerprint').fill(sourceFingerprint);
   await label(receiver,'Confirmed pairing root pin').fill(originalPin);
   await label(receiver,'Confirmed pairing transcript code').fill(code);
   await click(receiver,'Confirm personal pairing on this device');
   await expect(receiver.getByText(/^The independently confirmed fingerprint/)).toBeVisible();
   await label(receiver,'Confirmed pairing root pin').fill(sourcePin);
   await click(receiver,'Confirm personal pairing on this device');

   await label(source,'Confirmed pairing root pin').fill(sourcePin);
   await label(source,'Confirmed pairing transcript code').fill(code);
   await click(source,'Confirm personal pairing on this device');
   await transferProof(receiver,source);

   await source.reload();
   await click(source,'Pair from this device');
   await expect(source.getByText(/^Response ready/)).toBeVisible();
   await transferProof(source,receiver);
   await transferProof(receiver,source);
   await transferProof(source,receiver);
   await transferProof(receiver,source);
   for(const page of [source,receiver])await expect(page.getByText(/^Both devices proved/)).toBeVisible();
  });

  let path,encrypted;
  await test.step('roll back every IndexedDB publication write, then download a recipient-bound file',async()=>{
   const buttonLabel='Save encrypted personal pairing file',before=await databaseState(source);
   const revision=await advanceAuthority(source,scopeId),stale=await databaseState(source);
   await click(source,buttonLabel);
   await expect(source.getByText(/^The saved pairing state changed/)).toBeVisible();
   expect(await databaseState(source)).toEqual(stale);
   await advanceAuthority(source,scopeId,revision);
   expect(await databaseState(source)).toEqual(before);
   for(let write=1;write<=7;write++){
    await failWritesAt(source,write);
    await click(source,buttonLabel);
    await expect(source.getByText(/^Pairing could not continue/)).toBeVisible();
    expect(await source.evaluate(()=>window.personalPairingWrites)).toBe(write);
    expect(await databaseState(source)).toEqual(before);
   }
   await failWritesAt(source,0);
   const [download]=await Promise.all([source.waitForEvent('download'),click(source,buttonLabel)]);
   expect(download.suggestedFilename()).toBe('creative-cooking-personal-pairing.ccpair');
   path=await download.path();
   encrypted=await readFile(path);
   expect(await source.evaluate(()=>window.personalPairingWrites)).toBe(7);
   expect(encrypted.includes(privateMessage)).toBe(false);
   expect(encrypted.includes(credential)).toBe(false);
   await click(source,'Reopen paired personal workspace');
   await source.goto('./settings');
   await click(source,'Show verified personal device history');
   await expect(source.getByText(`Paired ${receiverId} by ${sourceId}`)).toBeVisible();
   await click(source,'Pair from this device');
   const [retry]=await Promise.all([source.waitForEvent('download'),click(source,buttonLabel)]);
   expect(await readFile(await retry.path())).toEqual(encrypted);
  });

  await test.step('deny altered ciphertext, prove IndexedDB rollback, then select and reopen personal data only',async()=>{
   const select='Install and select verified personal copy';
   const altered=Buffer.from(encrypted);altered[altered.length-1]^=1;
   await choose(receiver,altered);
   const before=await databaseState(receiver);
   await click(receiver,select);
   await expect(receiver.getByText(/^Pairing could not continue/)).toBeVisible();
   expect(await databaseState(receiver)).toEqual(before);
   await choose(receiver,encrypted);
   // Two local-key indexes, document and owner, four semantic indexes for the
   // first conversation and message, copy binding, guard, selection, receipts and successor.
   for(let write=1;write<=17;write++){
    await failWritesAt(receiver,write);
    await click(receiver,select);
    await expect(receiver.getByText(/^Pairing could not continue/)).toBeVisible();
    expect(await receiver.evaluate(()=>window.personalPairingWrites)).toBe(write);
    expect(await databaseState(receiver)).toEqual(before);
   }
   await failWritesAt(receiver,0);
   await click(receiver,select);
   await expect(receiver.getByText(/^Verified private copy saved and selected/)).toBeVisible();
   await expect(label(receiver,'This workspace personal root pin')).toHaveText(originalPin);
   await click(receiver,'Reopen paired personal workspace');
   await receiver.goto('./settings');
   await expect(label(receiver,'This workspace personal root pin')).toHaveText(sourcePin);
   await expect(label(receiver,'Open household')).toHaveText(originalHousehold);
   await expect(receiver.getByText('Not connected',{exact:true})).toBeVisible();
   const installed=new LoroDoc();
   installed.import(Uint8Array.from(await installedSnapshot(receiver,scopeId)));
   const operations=JSON.stringify(installed.exportJsonUpdates(undefined,undefined,false));
   expect(operations).toContain(privateMessage);
   expect(operations).not.toContain(credential);
   installed.free();
   await click(receiver,'Show verified personal device history');
   await expect(receiver.getByText(`${receiverId} · Authorized · This device`)).toBeVisible();
   await expect(receiver.getByText(`Paired ${receiverId} by ${sourceId}`)).toBeVisible();
   await receiver.goto('./chef');
   await expect(receiver.getByText(privateMessage,{exact:true})).toBeVisible();
   await saveMessage(receiver,recipientEdit);
   await click(receiver,'Receive my private copy');
   await choose(receiver,encrypted);
   const revision=await advanceAuthority(receiver,scopeId),stale=await databaseState(receiver);
   await click(receiver,select);
   await expect(receiver.getByText(/^The saved pairing state changed/)).toBeVisible();
   expect(await databaseState(receiver)).toEqual(stale);
   await advanceAuthority(receiver,scopeId,revision);
   const beforeRetry=await databaseState(receiver);
   await click(receiver,select);
   await expect(receiver.getByText(/^The same verified personal copy is selected/)).toBeVisible();
   expect(await databaseState(receiver)).toEqual(beforeRetry);
   await click(receiver,'Reopen paired personal workspace');
   await receiver.goto('./chef');
   await expect(receiver.getByText(recipientEdit,{exact:true})).toBeVisible();
   await receiver.goto('./settings');
   await click(receiver,'Return to original personal workspace');
   await receiver.goto('./settings');
   await expect(label(receiver,'This workspace personal root pin')).toHaveText(originalPin);
   await expect(label(receiver,'Open household')).toHaveText(originalHousehold);
   await receiver.goto('./chef');
   await expect(receiver.getByText(recipientOriginal,{exact:true})).toBeVisible();
  });
 }finally{await sourceContext.close();await receiverContext.close();await otherContext.close()}
});
