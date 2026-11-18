import {test, expect} from './browser-fixture.mjs';
import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';

// Select real numeric host candidates for runners without local mDNS service.
test.use({launchOptions:{args:['--disable-features=WebRtcHideLocalIpsWithMdns']}});

const button = (page, name) => page.getByRole('button', {name, exact:true});
const label = (page, name) => page.getByLabel(name, {exact:true});
const visible = (page, text) => expect(page.getByText(text, {exact:true})).toBeVisible();
const saved = page => expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
const text = async (page, name) => {
  const item = label(page, name);
  await expect(item).toBeVisible();
  return item.textContent();
};

async function prepare(page, baseURL, seed, prepareRecipes) {
  await page.goto(baseURL);
  await button(page, 'Start fresh local preview').click();
  await button(page, 'Review household policy').click();
  await button(page, 'Accept this household policy').click();
  await saved(page);
  if (seed) {
    await add(page, 'Direct household seed leek');
    await saved(page);
  }
  if (prepareRecipes) await prepareRecipes();
  else await button(page, 'Open settings').click();
  await button(page, 'Show device identity').click();
  await button(page, 'Invite or join a household').click();
}

async function admit(a, b, baseURL) {
  const identity = await text(b, 'Public device identity');
  await label(a, 'Recipient public identity').fill(identity);
  await button(a, 'Prepare current-cooking invitation').click();
  const offer = await text(a, 'Public invitation message');
  const code = await text(a, 'Invitation verification code');
  await button(a, 'Show public household authority').click();
  await label(b, 'Household authority bundle').fill(await text(a, 'Public household authority'));
  await label(b, 'Confirmed household root').fill(await text(a, 'Household root to compare'));
  await label(b, 'Confirmed household head').fill(await text(a, 'Household head to compare'));
  await button(b, 'Verify and accept public authority').click();
  await visible(b, 'Public authority accepted. No access or keys have been granted.');
  await button(b, 'Join invitation').click();
  await label(b, 'Public invitation message input').fill(offer);
  for (const page of [a,b]) {
    await label(page, 'Confirmed invitation code').fill(code);
    await button(page, 'Start or resume device verification').click();
  }
  for (const phase of ['Exchange your response with the other device.', 'Exchange your acknowledgement with the other device.', 'Both devices have completed verification.']) {
    const [fromA,fromB] = await Promise.all([text(a, 'Your verification message'), text(b, 'Your verification message')]);
    await label(a, 'Other device verification message').fill(fromB);
    await label(b, 'Other device verification message').fill(fromA);
    await Promise.all([a,b].map(page => button(page, 'Continue device verification').click()));
    await Promise.all([a,b].map(page => visible(page, phase)));
  }
  const download = a.waitForEvent('download');
  await button(a, 'Admit and download encrypted household file').click();
  const downloaded=await download;
  const file = await readFile(await downloaded.path());
  await downloaded.delete();
  const chooser = b.waitForEvent('filechooser');
  await button(b, 'Choose encrypted household file').click();
  await (await chooser).setFiles({name:'household.bin', mimeType:'application/octet-stream', buffer:file});
  await button(b, 'Open this shared household').click();
  await a.goto(baseURL);
  await Promise.all([a,b].map(saved));
}

async function add(page, name) {
  await label(page, 'Ingredient and details').fill(name);
  await label(page, 'Add ingredient').click();
  await visible(page, name);
}

function observeRTC() {
  const BrowserPeerConnection = globalThis.RTCPeerConnection;
  const connections = [];
  globalThis.RTCPeerConnection = class extends BrowserPeerConnection {
    constructor(configuration) {
      super(configuration);
      connections.push({connection:this, channels:[]});
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      connections.find(entry => entry.connection === this).channels.push(channel);
      return channel;
    }
    setRemoteDescription(description) {
      connections.find(entry => entry.connection === this).remoteSdp = description.sdp;
      return super.setRemoteDescription(description);
    }
  };
  globalThis.directProof = async () => {
    const entry = connections.at(-1);
    if (!entry) return null;
    const {connection,channels,remoteSdp} = entry;
    const report = await connection.getStats();
    const selected = [...report.values()].find(row => row.type === 'transport' && row.selectedCandidatePairId);
    const pair = selected && report.get(selected.selectedCandidatePairId);
    return {
      iceServers:connection.getConfiguration().iceServers,
      connection:connection.connectionState,
      channel:channels[0]?.readyState,
      remoteSdpIntact:!!remoteSdp && remoteSdp === connection.currentRemoteDescription?.sdp,
      remoteCandidates:remoteSdp?.split('\n').filter(line => line.startsWith('a=candidate:')).length ?? 0,
      local:pair && report.get(pair.localCandidateId)?.candidateType,
      remote:pair && report.get(pair.remoteCandidateId)?.candidateType,
      protocol:pair && report.get(pair.localCandidateId)?.protocol
    };
  };
}

async function durable(page, household) {
  return page.evaluate(async scope => {
    const name = localStorage.getItem('creative-cooking-local-workspace-v1');
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(`${name}-records`);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const store = db.transaction('records').objectStore('records');
      const entries = await new Promise((resolve, reject) => {
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(req.result.map(key => JSON.parse(key)).filter(key => key[1] === scope));
        req.onerror = () => reject(req.error);
      });
      return Object.fromEntries(['inbox','applied','receipt-state','receipt'].map(kind => [kind, entries.filter(key => key[0] === kind).length]));
    } finally { db.close(); }
  }, household);
}

async function verifyCooking(page) {
  await saved(page);
  for (const ingredient of ['Direct proof tarragon', 'Direct proof fennel', 'Direct pending rosemary']) await visible(page, ingredient);
}

async function openRecipe(page,title) {
  await label(page,`Open recipe ${title}`).click();
  await expect(page.getByText(title,{exact:true}).last()).toBeVisible();
}

async function createRecipe(page,title) {
  await label(page,'Add recipe').click();
  await label(page,'New recipe title').fill(title);
  await label(page,'New recipe ingredients').fill('Carrot');
  await label(page,'New recipe steps').fill('Slice');
  await label(page,'Save new recipe').click();
  await openRecipe(page,title);
  await button(page,'Show recipe edit history').click();
  await visible(page,'No text edits recorded for this recipe.');
  await label(page,'Close recipe').click();
}

async function editRecipe(page,title,after,description) {
  await openRecipe(page,title);
  await label(page,`Edit recipe ${title}`).click();
  await label(page,'Recipe title').fill(after);
  if(description) await label(page,'Recipe description').fill(description);
  await label(page,'Save recipe changes').click();
  await button(page,'Show recipe edit history').click();
  await expect(page.getByText('Current edit',{exact:true}).first()).toBeVisible();
  await label(page,'Close recipe').click();
  await expect(label(page,`Open recipe ${after}`)).toBeVisible();
}

async function exchange(page) {
  await page.goto('./settings');
  await button(page,'Exchange encrypted cooking files').click();
  await expect(button(page,'Choose encrypted cooking update')).toBeEnabled();
}

async function encryptedUpdates(page,count) {
  const updates=page.getByRole('button',{name:/^Download encrypted update /});
  await expect(updates).toHaveCount(count);
  const files=[];
  for(const control of await updates.all()){
    const download=page.waitForEvent('download');
    await control.click();
    const file=await download;
    files.push(await readFile(await file.path()));
    await file.delete();
  }
  return files.sort((a,b)=>JSON.parse(a).header.deviceSequence-JSON.parse(b).header.deviceSequence);
}

async function receiveRecipeUpdate(page,buffer,reload) {
  const chooser=page.waitForEvent('filechooser');
  await button(page,'Choose encrypted cooking update').click();
  const loaded=reload ? page.waitForEvent('load') : null;
  await (await chooser).setFiles({name:'recipe-update.bin',mimeType:'application/octet-stream',buffer});
  if (loaded) await loaded;
}

test('admitted browser workspaces exchange offline recipe edits and explicitly restore a competing title', async ({browser,baseURL}) => {
  test.setTimeout(150_000);
  const contexts=await Promise.all([0,1].map(()=>browser.newContext({baseURL,acceptDownloads:true})));
  const [a,b]=await Promise.all(contexts.map(context=>context.newPage()));
  const errors=[];
  for (const page of [a,b]) page.on('pageerror',error=>errors.push(error.message));
  let oldFile;
  try {
    await Promise.all([prepare(a,baseURL,false,async()=>{
      await a.goto('./recipes');
      await createRecipe(a,'Pre-invitation title canary');
      await createRecipe(a,'Independent recipe canary');
      await editRecipe(a,'Pre-invitation title canary','Carrot soup');
      await exchange(a);
      [oldFile]=await encryptedUpdates(a,4);
    }),prepare(b,baseURL,false)]);
    await admit(a,b,baseURL);
    const oldScope=JSON.parse(oldFile).header.scopeId;
    const retained=await a.evaluate(async scopeId=>{
      const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      const name=localStorage.getItem('creative-cooking-local-workspace-v1');
      const db=await request(indexedDB.open(`${name}-records`));
      try {
        const keys=await request(db.transaction('records').objectStore('records').getAllKeys());
        return keys.map(key=>JSON.parse(key)).filter(([kind,scope])=>kind==='projection-pending'&&scope===scopeId).length;
      } finally { db.close(); }
    },oldScope);
    expect(retained).toBe(3);
    await b.goto('./recipes');
    await openRecipe(b,'Carrot soup');
    await button(b,'Show recipe edit history').click();
    await visible(b,'No text edits recorded for this recipe.');
    await expect(b.getByText('Pre-invitation title canary',{exact:true})).toHaveCount(0);
    await exchange(b);
    await receiveRecipeUpdate(b,oldFile,false);
    await expect(b.getByRole('alert').filter({hasText:'Update not applied'})).toBeVisible();

    for(const page of [a,b]) await page.goto('./recipes');
    await Promise.all(contexts.map(context=>context.setOffline(true)));
    await Promise.all([
      editRecipe(a,'Carrot soup','Roasted carrot soup'),
      editRecipe(b,'Carrot soup','Ginger carrot soup','B side independent description'),
    ]);
    await expect(label(a,'Open recipe Ginger carrot soup')).toHaveCount(0);
    await expect(label(b,'Open recipe Roasted carrot soup')).toHaveCount(0);
    await Promise.all(contexts.map(context=>context.setOffline(false)));
    await Promise.all([exchange(a),exchange(b)]);
    const [fromA,fromB]=await Promise.all([encryptedUpdates(a,2),encryptedUpdates(b,3)]);
    const tampered=Buffer.from(fromA[0]);
    const parsed=JSON.parse(tampered);
    parsed.header.documentId='tampered-routing';
    await receiveRecipeUpdate(b,Buffer.from(JSON.stringify(parsed)),false);
    await expect(b.getByRole('alert').filter({hasText:'Update not applied'})).toBeVisible();
    for (const [page,files] of [[a,fromB],[b,fromA]]) {
      for (const [index,file] of files.entries()) {
        if (index) await button(page,'Exchange encrypted cooking files').click();
        await receiveRecipeUpdate(page,file,true);
      }
    }
    await button(b,'Exchange encrypted cooking files').click();
    await receiveRecipeUpdate(b,fromA[0],false);
    await visible(b,'This exact update was already applied. No new changes were made.');

    for (const page of [a,b]) await page.goto('./recipes');
    const winner=await a.getByRole('button',{name:/^Open recipe (Roasted|Ginger) carrot soup$/}).getAttribute('aria-label');
    expect(winner).toBeTruthy();
    const winnerTitle=winner.replace('Open recipe ','');
    const alternative=winnerTitle==='Ginger carrot soup'?'Roasted carrot soup':'Ginger carrot soup';
    for (const page of [a,b]) {
      await expect(label(page,'Open recipe Independent recipe canary')).toBeVisible();
      await openRecipe(page,winnerTitle);
      await expect(page.getByText('B side independent description',{exact:true}).last()).toBeVisible();
      await button(page,'Show recipe edit history').click();
      await visible(page,alternative);
      await visible(page,'Competing edit');
    }

    // Keep A's completed document read pending at the transaction boundary
    // while the Recipes tab is reused to open a different recipe.
    await a.evaluate(() => {
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function(key) {
        if (this.transaction.mode === 'readonly' && typeof key === 'string' && key.startsWith('["document",')) {
          IDBObjectStore.prototype.get = get;
          const transaction = this.transaction, complete = transaction.oncomplete;
          transaction.oncomplete = function(event) {
            globalThis.releaseRecipeHistory = () => new Promise(resolve => {
              // A is the publisher. After the held document read, validating
              // its retained seed ends with this publication transaction.
              IDBObjectStore.prototype.get = function(seedKey) {
                if (typeof seedKey === 'string' && seedKey.startsWith('["projection-publication",')) {
                  IDBObjectStore.prototype.get = get;
                  this.transaction.addEventListener('complete', () => {
                    requestAnimationFrame(() => requestAnimationFrame(resolve));
                  }, {once:true});
                }
                return get.call(this,seedKey);
              };
              complete.call(this,event);
            });
          };
        }
        return get.call(this,key);
      };
    });
    await button(a,'Refresh recipe edit history').click();
    await a.waitForFunction(() => typeof globalThis.releaseRecipeHistory === 'function');
    await a.getByRole('button',{name:/^Add ingredients to shopping list/}).click();
    await button(a,'Back').click();
    await openRecipe(a,'Independent recipe canary');
    await button(a,'Show recipe edit history').click();
    await visible(a,'No text edits recorded for this recipe.');
    await a.evaluate(() => globalThis.releaseRecipeHistory());
    await expect(a.getByText('No text edits recorded for this recipe.',{exact:true})).toBeVisible();
    await expect(a.getByText('Competing edit',{exact:true})).toHaveCount(0);
    await expect(a.getByText(alternative,{exact:true})).toHaveCount(0);

    await b.evaluate(() => {
      const put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get;
      globalThis.recipeRestoreWrites = 0;
      IDBObjectStore.prototype.put = function(value,key) {
        if (typeof key === 'string' && key.startsWith('["document",')) {
          this.transaction.addEventListener('complete',() => {globalThis.recipeRestoreWrites++;});
        }
        return put.call(this,value,key);
      };
      IDBObjectStore.prototype.get = function(key) {
        if (globalThis.recipeRestoreWrites > 0 && this.transaction.mode === 'readonly' && typeof key === 'string' && key.startsWith('["document",')) {
          IDBObjectStore.prototype.get = get;
          throw Error('Injected recipe view refresh failure');
        }
        return get.call(this,key);
      };
    });
    await button(b,'Restore title edit').click();
    await visible(b,'Recipe edit saved. Refresh the recipe to see it.');
    await expect(button(b,'Restore title edit')).toHaveCount(0);
    await button(b,'Retry recipe refresh').click();
    await visible(b,'Recipe edit saved.');
    await expect(b.getByText('Current edit',{exact:true}).locator('..').filter({
      has:b.getByText(alternative,{exact:true}),
    })).toBeVisible();
    await expect(b.getByText('Competing edit',{exact:true})).toHaveCount(0);
    expect(await b.evaluate(() => globalThis.recipeRestoreWrites)).toBe(1);
    await exchange(b);
    const restoreFiles=await encryptedUpdates(b,4);
    await exchange(a);
    await receiveRecipeUpdate(a,restoreFiles.at(-1),true);
    for (const page of [a,b]) {
      await page.goto('./recipes');
      await page.reload();
      await openRecipe(page,alternative);
      await expect(page.getByText('B side independent description',{exact:true}).last()).toBeVisible();
      await button(page,'Show recipe edit history').click();
      await expect(page.getByText('Current edit',{exact:true}).first()).toBeVisible();
      await expect(page.getByText('Pre-invitation title canary',{exact:true})).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map(context=>context.close()));
  }
});

async function openProfiles(browser, baseURL) {
  const endpoints = [process.env.TEST_DIRECT_CDP_A, process.env.TEST_DIRECT_CDP_B];
  if (endpoints.every(Boolean)) {
    const browsers = await Promise.all(endpoints.map(endpoint => chromium.connectOverCDP(endpoint)));
    const contexts = browsers.map(instance => instance.contexts()[0]);
    return {contexts, persistent:true, close:() => Promise.all(browsers.map(instance => instance.close()))};
  }
  const contexts = await Promise.all([0,1].map(() => browser.newContext({baseURL, acceptDownloads:true})));
  return {contexts, persistent:false, close:() => Promise.all(contexts.map(context => context.close()))};
}

async function openPage(context, baseURL) {
  const page = await context.newPage();
  if (!page.url().startsWith(baseURL)) await page.goto(baseURL);
  return page;
}

test('admitted browser devices independently verify their direct connection, retry retained updates and reopen converged', async ({browser,baseURL}) => {
  test.setTimeout(180_000);
  const profiles = await openProfiles(browser, baseURL);
  const {contexts} = profiles;
  const [a,b] = await Promise.all(contexts.map(context => openPage(context, baseURL)));
  const errors = [], external = [];
  try {
    if (process.env.TEST_DIRECT_REOPEN_ONLY) {
      expect(profiles.persistent).toBe(true);
      await Promise.all([a,b].map(verifyCooking));
      return;
    }
    for (const page of [a,b]) {
      await page.addInitScript(observeRTC);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {if (new URL(request.url()).origin !== new URL(baseURL).origin) external.push(request.url());});
    }
    await Promise.all([prepare(a,baseURL,true),prepare(b,baseURL,false)]);
    await admit(a,b,baseURL);
    await Promise.all(contexts.map(context => context.setOffline(true)));
    await Promise.all([add(a,'Direct proof tarragon'),add(b,'Direct proof fennel')]);
    await Promise.all([a,b].map(saved));
    await expect(a.getByText('Direct proof fennel',{exact:true})).toHaveCount(0);
    await expect(b.getByText('Direct proof tarragon',{exact:true})).toHaveCount(0);
    await Promise.all(contexts.map(context => context.setOffline(false)));

    // Keep the in-memory edit unresolved while a peer tries to import. The next
    // import may refresh the projection only after that same local action saves.
    await b.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      const name = localStorage.getItem('creative-cooking-local-workspace-v1');
      globalThis.observeDirectFlush = false;
      globalThis.directFlushSelectionLocks = [];
      IDBObjectStore.prototype.put = function(value, key) {
        if (typeof key === 'string' && key.startsWith('["document",')) {
          if (globalThis.observeDirectFlush) {
            globalThis.directFlushSelectionLocks.push(navigator.locks.query().then(({held}) =>
              held.some(lock => lock.name === `creative-cooking/bootstrap/v1/${name}` && lock.mode === 'shared')));
          }
          throw Error('Injected local save failure');
        }
        return put.call(this, value, key);
      };
      globalThis.restoreLocalWrite = () => { IDBObjectStore.prototype.put = put; };
    });
    await add(b,'Direct pending rosemary');
    await expect(b.getByTestId('pantry-local-persistence-status')).toHaveText('Local save failed');
    for (const page of [a,b]) {
      await button(page, 'Open settings').click();
      await button(page, 'Exchange cooking updates directly').click();
    }
    const aHousehold = (await text(a, 'Open household')).split(' · ')[1];
    const bHousehold = (await text(b, 'Open household')).split(' · ')[1];
    expect(aHousehold).toBe(bHousehold);
    await button(a, 'Create connection offer').click();
    const offer = await text(a,'Outgoing direct connection message');
    await button(b, 'Answer a connection').click();
    const wrongHousehold = {...JSON.parse(offer), scopeId:crypto.randomUUID()};
    await label(b,'Direct connection offer').fill(JSON.stringify(wrongHousehold));
    await button(b,'Verify offer and create answer').click();
    await visible(b,'The connection message is for a different household, device or invitation.');
    const tampered = JSON.parse(offer);
    tampered.sdp = tampered.sdp.replace(/a=ice-pwd:[^\r\n]+/, 'a=ice-pwd:changed-unsigned-message');
    await label(b,'Direct connection offer').fill(JSON.stringify(tampered));
    await button(b,'Verify offer and create answer').click();
    await visible(b,'The connection message signature is invalid.');
    expect(await durable(b,bHousehold)).toEqual({inbox:0, applied:0, 'receipt-state':0, receipt:0});

    // Transfer an unchanged signed offer through the real file chooser.
    const signalDownload = a.waitForEvent('download');
    await button(a,'Download connection message').click();
    const offerFile = await readFile(await (await signalDownload).path());
    expect(offerFile.toString()).toBe(offer);
    const previouslyPasted = 'Previous connection message';
    await label(b,'Direct connection offer').fill(previouslyPasted);
    const emptyChooser = b.waitForEvent('filechooser');
    await button(b,'Choose connection message file').click();
    await (await emptyChooser).setFiles({name:'empty.json', mimeType:'application/json', buffer:Buffer.alloc(0)});
    await visible(b,'The connection message file is empty or too large.');
    await expect(label(b,'Direct connection offer')).toHaveValue(previouslyPasted);
    const signalChooser = b.waitForEvent('filechooser');
    await button(b,'Choose connection message file').click();
    await (await signalChooser).setFiles({name:'offer.json', mimeType:'application/json', buffer:offerFile});
    await expect(label(b,'Direct connection offer')).toHaveValue(offer);
    await button(b,'Verify offer and create answer').click();
    const answer = await text(b,'Outgoing direct connection message');
    const mismatchedAnswer = {...JSON.parse(answer), sessionId:'f'.repeat(32)};
    await label(a,'Direct connection answer').fill(JSON.stringify(mismatchedAnswer));
    await button(a,'Verify connection answer').click();
    await visible(a,'The connection message is for a different household, device or invitation.');
    await label(a,'Direct connection answer').fill(answer);
    await button(a,'Verify connection answer').click();
    const comparison = await text(a,'Direct verification code');
    expect(await text(b,'Direct verification code')).toBe(comparison);
    for (const page of [a,b]) {
      await expect.poll(() => page.evaluate(() => directProof()), {timeout:20_000}).toEqual({iceServers:[],connection:'connected',channel:'open',remoteSdpIntact:true,remoteCandidates:expect.any(Number),local:'host',remote:'host',protocol:'udp'});
      expect((await page.evaluate(() => directProof())).remoteCandidates).toBeGreaterThan(0);
      await expect(button(page,'Send cooking updates')).toHaveCount(0);
    }
    await label(a,'Independently compared direct verification code').fill('0000-0000-0000-0000-0000-0000-0000-0000');
    await button(a,'Confirm compared code').click();
    await visible(a,'The verification code does not match this connection.');
    await label(a,'Independently compared direct verification code').fill(comparison);
    await button(a,'Confirm compared code').click();
    await visible(a,'Waiting for the other device to confirm and connect.');
    for (const page of [a,b]) await expect(button(page,'Send cooking updates')).toHaveCount(0);
    expect(await durable(b,bHousehold)).toEqual({inbox:0, applied:0, 'receipt-state':0, receipt:0});
    await label(b,'Independently compared direct verification code').fill(comparison);
    await button(b,'Confirm compared code').click();
    for (const page of [a,b]) await visible(page,'Direct connection verified on both devices.');

    await a.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      const name = localStorage.getItem('creative-cooking-local-workspace-v1');
      globalThis.receiptSelectionLocks = [];
      IDBObjectStore.prototype.put = function(value, key) {
        if (typeof key === 'string' && key.startsWith('["receipt",')) {
          globalThis.receiptSelectionLocks.push(navigator.locks.query().then(({held}) =>
            held.some(lock => lock.name === `creative-cooking/bootstrap/v1/${name}` && lock.mode === 'shared')));
        }
        return put.call(this, value, key);
      };
    });
    await b.evaluate(() => { globalThis.observeDirectFlush = true; });
    await button(a,'Send cooking updates').click();
    await visible(a,'1 update still waiting for the other device to apply. You can retry this batch.');
    await visible(a,'Peer receipts for this connection: 1 stored, 0 applied.');
    await visible(b,'Received here: 0 applied, 1 retained without applying.');
    expect(await durable(b,bHousehold)).toEqual({inbox:1, applied:0, 'receipt-state':0, receipt:0});
    expect(await b.evaluate(() => Promise.all(globalThis.directFlushSelectionLocks))).toEqual([true]);
    await b.evaluate(() => {
      globalThis.restoreLocalWrite();
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        if (typeof key === 'string' && key.startsWith('["applied",')) {
          IDBObjectStore.prototype.put = put;
          throw Error('Injected import failure after document write');
        }
        return put.call(this, value, key);
      };
    });
    await button(a,'Send cooking updates').click();
    await visible(a,'1 update still waiting for the other device to apply. You can retry this batch.');
    await visible(a,'Peer receipts for this connection: 1 stored, 0 applied.');
    expect(await durable(b,bHousehold)).toEqual({inbox:1, applied:0, 'receipt-state':0, receipt:0});
    await b.evaluate(() => {
      const send = RTCDataChannel.prototype.send;
      const get = IDBObjectStore.prototype.get;
      let appliedSent = false;
      RTCDataChannel.prototype.send = function(data) {
        const result = send.call(this, data);
        const message = data instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(data)) : null;
        if (message?.kind === 'receipt' && message.claims?.state === 'applied') {
          appliedSent = true;
          RTCDataChannel.prototype.send = send;
        }
        return result;
      };
      IDBObjectStore.prototype.get = function(key) {
        if (appliedSent && this.transaction.mode === 'readonly' && typeof key === 'string' && key.startsWith('["document",')) {
          IDBObjectStore.prototype.get = get;
          throw Error('Injected projection refresh failure after import');
        }
        return get.call(this, key);
      };
    });
    await button(a,'Send cooking updates').click();
    await visible(a,'The other device applied this batch.');
    await visible(a,'Peer receipts for this connection: 1 stored, 1 applied.');
    expect(await durable(b,bHousehold)).toEqual({inbox:1, applied:1, 'receipt-state':0, receipt:0});
    expect(await a.evaluate(() => Promise.all(globalThis.receiptSelectionLocks))).toEqual([true,true]);
    const refreshError = b.getByText('Received updates are saved, but this view could not refresh.', {exact:true});
    await expect(refreshError).toBeVisible();
    await button(a,'Send cooking updates').click();
    await visible(a,'No local updates are waiting for this device.');
    await button(b,'Send cooking updates').click();
    await visible(b,'The other device applied this batch.');
    await visible(b,'Peer receipts for this connection: 2 stored, 2 applied.');
    expect(await durable(a,aHousehold)).toEqual({inbox:2, applied:2, 'receipt-state':1, receipt:2});

    await b.goBack();
    await expect(b.getByText('Direct proof tarragon',{exact:true})).toHaveCount(0);
    await button(b,'Open settings').click();
    await expect(refreshError).toBeVisible();
    await button(b,'Retry cooking refresh').click();
    await expect(refreshError).toHaveCount(0);
    expect(await durable(b,bHousehold)).toMatchObject({inbox:1, applied:1});

    for (const page of [a,b]) {
      await page.goBack();
      await verifyCooking(page);
      await page.close();
    }
    const restarted = await Promise.all(contexts.map(context => openPage(context, baseURL)));
    await Promise.all(restarted.map(verifyCooking));
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    for (const page of restarted) await page.close();
  } catch (error) {
    for (const [index,page] of [a,b].entries()) if (!page.isClosed()) {
      console.error(`Device ${index + 1}`, await page.locator('[role=alert]').allTextContents());
      console.error(`Device ${index + 1} RTC`, await page.evaluate(() => globalThis.directProof?.()).catch(() => null));
    }
    throw error;
  } finally {
    await Promise.allSettled([a,b].map(page => page.close()));
    await profiles.close();
  }
});

async function scopeFingerprint(page, scopeId, includeQuarantine = true, excludeReports = false) {
  return page.evaluate(async ({scopeId,includeQuarantine,excludeReports}) => {
    const name = localStorage.getItem('creative-cooking-local-workspace-v1');
    const db = await new Promise((resolve,reject) => {
      const request = indexedDB.open(`${name}-records`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const rows = await new Promise((resolve,reject) => {
        const rows = [], request = db.transaction('records').objectStore('records').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(rows);
          const [kind,scope,authorityScope] = JSON.parse(cursor.key);
          const inScope = scope === scopeId || kind === 'pairing-authority' && authorityScope === scopeId;
          if (inScope && (includeQuarantine || kind !== 'compromise-quarantine') &&
              (!excludeReports || !['compromise-review','compromise-frozen-original'].includes(kind))) rows.push([cursor.key,cursor.value]);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      const data = JSON.stringify(rows,(_key,value) => value instanceof Uint8Array ? Array.from(value) : value);
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data))));
    } finally { db.close(); }
  }, {scopeId,includeQuarantine,excludeReports});
}

async function downloadCooking(page) {
  await button(page,'Exchange encrypted cooking files').click();
  const buttons = page.getByRole('button',{name:/^Download encrypted update /});
  await expect(buttons.first()).toBeVisible();
  const files = [];
  for (const entry of await buttons.all()) {
    const download = page.waitForEvent('download');
    await entry.click();
    const bytes = await readFile(await (await download).path());
    files.push({bytes,id:(await entry.innerText()).split(' ').at(-1)});
  }
  return files;
}

async function uploadCooking(page, bytes) {
  const chooser = page.waitForEvent('filechooser');
  await button(page,'Choose encrypted cooking update').click();
  await (await chooser).setFiles({name:'cooking.bin',mimeType:'application/octet-stream',buffer:bytes});
}

test('local quarantine survives reopen, preserves direct receipts and rejects new signed cooking', async ({browser,baseURL}) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([0,1].map(() => browser.newContext({baseURL,acceptDownloads:true})));
  const [a,b] = await Promise.all(contexts.map(context => openPage(context,baseURL)));
  try {
    await Promise.all([prepare(a,baseURL,true),prepare(b,baseURL,false)]);
    const organizer = JSON.parse(await text(a,'Public device identity')).deviceId;
    const recipient = JSON.parse(await text(b,'Public device identity')).deviceId;
    expect(organizer).not.toBe(recipient);
    await admit(a,b,baseURL);
    await add(a,'Already applied shallot');
    await saved(a);
    await button(a,'Open settings').click();
    const [prior] = await downloadCooking(a);
    await button(b,'Open settings').click();
    await button(b,'Exchange encrypted cooking files').click();
    const loaded = b.waitForEvent('load');
    await uploadCooking(b,prior.bytes);
    await loaded;
    await b.goto(baseURL);
    await visible(b,'Already applied shallot');

    await button(b,'Open settings').click();
    const scope = (await text(b,'Open household')).split(' · ')[1];
    const review = () => button(b,`Review local quarantine for ${organizer}`);
    const confirm = () => button(b,'Quarantine on this device');
    await button(b,'Review household devices').click();
    await expect(label(b,`Household device ${recipient}`)).toContainText('This device');
    await expect(button(b,`Review local quarantine for ${recipient}`)).toHaveCount(0);
    await review().click();
    const otherTab = await openPage(contexts[1],baseURL);
    await button(otherTab,'Open settings').click();
    await button(otherTab,'Show device identity').click();
    await button(otherTab,'Return to original local household').click();
    await saved(otherTab);
    await button(otherTab,'Open settings').click();
    await button(otherTab,'Show device identity').click();
    await button(otherTab,'Open this shared household').click();
    await visible(otherTab,'Already applied shallot');
    await otherTab.close();
    const beforeStale = await scopeFingerprint(b,scope);
    await confirm().click();
    await visible(b,'Could not verify the current household devices. Refresh the list and review the device again.');
    expect(await scopeFingerprint(b,scope)).toEqual(beforeStale);

    await a.goBack();
    await add(a,'Retained direct scallion');
    await saved(a);
    await button(a,'Open settings').click();
    for (const page of [a,b]) await button(page,'Exchange cooking updates directly').click();
    await button(a,'Create connection offer').click();
    await button(b,'Answer a connection').click();
    await label(b,'Direct connection offer').fill(await text(a,'Outgoing direct connection message'));
    await button(b,'Verify offer and create answer').click();
    await label(a,'Direct connection answer').fill(await text(b,'Outgoing direct connection message'));
    await button(a,'Verify connection answer').click();
    const comparison = await text(a,'Direct verification code');
    expect(await text(b,'Direct verification code')).toBe(comparison);
    for (const page of [a,b]) {
      await label(page,'Independently compared direct verification code').fill(comparison);
      await button(page,'Confirm compared code').click();
    }
    for (const page of [a,b]) await visible(page,'Direct connection verified on both devices.');

    // Force an application failure after the authenticated direct object is retained.
    await b.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value,key) {
        if (typeof key === 'string' && key.startsWith('["applied",')) {
          IDBObjectStore.prototype.put = put;
          throw Error('Injected application failure');
        }
        return put.call(this,value,key);
      };
    });
    await button(a,'Send cooking updates').click();
    await visible(a,'1 update still waiting for the other device to apply. You can retry this batch.');
    await visible(a,'Peer receipts for this connection: 2 stored, 1 applied.');
    await visible(b,'Received here: 1 applied, 1 retained without applying.');
    expect(await durable(b,scope)).toEqual({inbox:2,applied:1,'receipt-state':0,receipt:0});
    const snapshot = await scopeFingerprint(b,scope,false);
    const acknowledged = await scopeFingerprint(a,scope);

    await button(b,'Refresh household devices').click();
    await review().click();
    await confirm().click();
    await visible(b,'Device quarantined on this device.');
    await expect(label(b,`Household device ${organizer}`)).toContainText('Quarantined on this device');
    expect(await scopeFingerprint(b,scope,false)).toEqual(snapshot);
    await button(a,'Send cooking updates').click();
    await visible(b,'Direct exchange is blocked on this device for the selected peer.');
    expect(await scopeFingerprint(a,scope)).toEqual(acknowledged);
    expect(await scopeFingerprint(b,scope,false)).toEqual(snapshot);

    await a.goBack();
    await add(a,'Blocked fresh chives');
    await saved(a);
    await button(a,'Open settings').click();
    const files = await downloadCooking(a);
    expect(files).toHaveLength(3);
    await button(b,'Exchange encrypted cooking files').click();
    const retained = b.getByText(/^Retained update blocked by local device quarantine: /);
    await expect(retained).toBeVisible();
    const retainedId = (await retained.innerText()).split(' ').at(-1);
    const fresh = files.find(({id}) => id !== prior.id && id !== retainedId);
    expect(fresh).toBeDefined();
    await expect(b.getByRole('button',{name:/^Retry retained update /})).toHaveCount(0);
    const blocked = await scopeFingerprint(b,scope);
    await uploadCooking(b,fresh.bytes);
    await visible(b,'Update blocked by local device quarantine. No update was applied.');
    expect(await scopeFingerprint(b,scope)).toEqual(blocked);
    await uploadCooking(b,prior.bytes);
    await visible(b,'This exact update was already applied. No new changes were made.');
    expect(await scopeFingerprint(b,scope)).toEqual(blocked);

    await b.goBack();
    await visible(b,'Already applied shallot');
    await expect(b.getByText('Blocked fresh chives',{exact:true})).toHaveCount(0);
    await expect(b.getByText('Retained direct scallion',{exact:true})).toHaveCount(0);
    await add(b,'Local dill after quarantine');
    await saved(b);
    await b.close();
    const reopened = await openPage(contexts[1],baseURL);
    await visible(reopened,'Already applied shallot');
    await visible(reopened,'Local dill after quarantine');
    await expect(reopened.getByText('Blocked fresh chives',{exact:true})).toHaveCount(0);
    await button(reopened,'Open settings').click();
    await button(reopened,'Review household devices').click();
    await expect(label(reopened,`Household device ${organizer}`)).toContainText('Quarantined on this device');
    await button(reopened,'Exchange encrypted cooking files').click();
    await expect(reopened.getByText(/^Retained update blocked by local device quarantine: /)).toBeVisible();
    await button(a,'Review household devices').click();
    await expect(label(a,`Household device ${recipient}`)).toContainText('Verified household device');
  } catch (error) {
    for (const page of [a,b]) if (!page.isClosed()) {
      console.error('Quarantine browser alerts',page.url(),await page.getByRole('alert').allTextContents());
    }
    throw error;
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('enrolled Settings devices share frozen signed incident evidence without applying cooking', async ({browser,baseURL}) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([0,1].map(()=>browser.newContext({baseURL,acceptDownloads:true})));
  const [organizer,recipient] = await Promise.all(contexts.map(context=>openPage(context,baseURL)));
  async function chooseReport(page,bytes) {
    const chooser = page.waitForEvent('filechooser');
    await button(page,'Choose signed incident report').click();
    await (await chooser).setFiles({name:'incident.cc-report',mimeType:'application/octet-stream',buffer:bytes});
  }
  try {
    await Promise.all([prepare(organizer,baseURL,true),prepare(recipient,baseURL,false)]);
    const organizerId = JSON.parse(await text(organizer,'Public device identity')).deviceId;
    const recipientId = JSON.parse(await text(recipient,'Public device identity')).deviceId;
    expect(organizerId).not.toEqual(recipientId);
    await admit(organizer,recipient,baseURL);
    await add(organizer,'Suspect-authored marjoram');
    await saved(organizer);
    await button(organizer,'Open settings').click();
    const [earlier] = await downloadCooking(organizer);
    await button(recipient,'Open settings').click();
    await button(recipient,'Exchange encrypted cooking files').click();
    const loaded = recipient.waitForEvent('load');
    await uploadCooking(recipient,earlier.bytes);
    await loaded;
    await recipient.goto(baseURL);
    await visible(recipient,'Suspect-authored marjoram');
    const pantryRow = recipient.getByTestId(/^pantry-item-/).filter({hasText:'Suspect-authored marjoram'});
    await pantryRow.getByRole('button',{name:'Set preference to 5 out of 5',exact:true}).click();
    await saved(recipient);
    await button(recipient,'Open settings').click();
    const scope = (await text(recipient,'Open household')).split(' · ')[1];
    const normal = page=>scopeFingerprint(page,scope,true,true);
    const beforeReporter = await normal(recipient);
    const beforeReceiver = await normal(organizer);

    await button(recipient,'Open household incident reports').click();
    await button(recipient,`Prepare report for ${organizerId}`).click();
    await recipient.getByRole('button',{name:new RegExp(`^Use signed pantry-create operation ${earlier.id}`)}).click();
    await visible(recipient,`Selected operation ${earlier.id}`);
    expect(await normal(recipient)).toEqual(beforeReporter);
    await button(recipient,'Sign and freeze incident report').click();
    await visible(recipient,'Signed report saved on this device.');
    await visible(recipient,'Frozen evidence · 3 signed operations');
    await visible(recipient,'Authored by the reported device');
    await expect(recipient.getByText('Depends on work by the reported device',{exact:true})).toHaveCount(2);
    expect(await normal(recipient)).toEqual(beforeReporter);

    const downloaded = recipient.waitForEvent('download');
    await button(recipient,'Download signed incident report').click();
    const file = await readFile(await (await downloaded).path());
    const tampered = Buffer.from(file);
    tampered[tampered.length-1] ^= 1;
    await button(organizer,'Open household incident reports').click();
    const allBeforeRejection = await scopeFingerprint(organizer,scope);
    await chooseReport(organizer,tampered);
    await visible(organizer,'The original evidence does not match the signed report.');
    expect(await scopeFingerprint(organizer,scope)).toEqual(allBeforeRejection);

    await chooseReport(organizer,file);
    await visible(organizer,'Signed report verified and available for review.');
    await visible(organizer,'Frozen evidence · 3 signed operations');
    await expect(organizer.getByText('Depends on work by the reported device',{exact:true})).toHaveCount(2);
    await visible(organizer,`Reporter device ${recipientId}`);
    expect(await normal(organizer)).toEqual(beforeReceiver);
    const savedReview = await scopeFingerprint(organizer,scope);
    await chooseReport(organizer,file);
    await visible(organizer,'This exact signed report was already saved.');
    expect(await scopeFingerprint(organizer,scope)).toEqual(savedReview);
    await expect(organizer.getByRole('button',{name:/^Review incident report /})).toHaveCount(1);

    // Two honest operations depend on the suspect's creation. Retaining them
    // alone should save the seed while reporting both operations as held.
    const dependentRows = organizer.getByText('Depends on work by the reported device',{exact:true});
    for(const row of await dependentRows.all())await row.locator('..').getByRole('checkbox').click();
    const saveDraft = button(organizer,'Save clean draft with 2 selected operations');
    await organizer.evaluate(()=>{
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value,key) {
        const pending = put.call(this,value,key);
        if(typeof key==='string'&&key.startsWith('["compromise-review"')&&value?.status==='local-draft') {
          IDBObjectStore.prototype.put = put;
          throw Error('injected clean draft write failure');
        }
        return pending;
      };
    });
    await saveDraft.click();
    await visible(organizer,'The incident report could not be opened or saved.');
    expect(await scopeFingerprint(organizer,scope)).toEqual(savedReview);
    await saveDraft.click();
    await visible(organizer,'Clean draft saved on this device.');
    const result = organizer.getByLabel('Saved clean draft',{exact:true});
    await expect(result.getByText('Included operations · 0',{exact:true})).toBeVisible();
    await expect(result.getByText('Omitted operations · 1',{exact:true})).toBeVisible();
    await expect(result.getByText('Held operations · 2',{exact:true})).toBeVisible();
    const savedDraft = await result.innerText();
    expect(savedDraft).not.toContain('Suspect-authored marjoram');
    expect(await normal(organizer)).toEqual(beforeReceiver);

    await organizer.goto(baseURL);
    await add(organizer,'Later signed tarragon');
    await saved(organizer);
    await button(organizer,'Open settings').click();
    await button(organizer,'Open household incident reports').click();
    await organizer.getByRole('button',{name:/^Review incident report /}).click();
    await visible(organizer,'Frozen evidence · 3 signed operations');
    await expect(organizer.getByText('Depends on work by the reported device',{exact:true})).toHaveCount(2);
    expect(await organizer.getByLabel('Saved clean draft',{exact:true}).innerText()).toBe(savedDraft);

    await button(organizer,`Prepare report for ${recipientId}`).click();
    await button(organizer,'Use verified household projection checkpoint').click();
    await button(organizer,'Sign and freeze incident report').click();
    await visible(organizer,'Signed report saved on this device.');
    await visible(organizer,'Verified household projection checkpoint');
    await expect(organizer.getByRole('button',{name:/^Review incident report /})).toHaveCount(2);
  } finally {
    await Promise.all(contexts.map(context=>context.close()));
  }
});
