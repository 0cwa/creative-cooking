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

async function prepare(page, baseURL, seed) {
  await page.goto(baseURL);
  await button(page, 'Start fresh local preview').click();
  await button(page, 'Review household policy').click();
  await button(page, 'Accept this household policy').click();
  await saved(page);
  if (seed) {
    await add(page, 'Direct household seed leek');
    await saved(page);
  }
  await button(page, 'Open settings').click();
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
  const file = await readFile(await (await download).path());
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
      IDBObjectStore.prototype.put = function(value, key) {
        if (typeof key === 'string' && key.startsWith('["document",')) throw Error('Injected local save failure');
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
    const signalChooser = b.waitForEvent('filechooser');
    await button(b,'Choose connection message file').click();
    await (await signalChooser).setFiles({name:'offer.json', mimeType:'application/json', buffer:offerFile});
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

    await button(a,'Send cooking updates').click();
    await visible(a,'1 update still waiting for the other device to apply. You can retry this batch.');
    await visible(a,'Peer receipts for this connection: 1 stored, 0 applied.');
    await visible(b,'Received here: 0 applied, 1 retained without applying.');
    expect(await durable(b,bHousehold)).toEqual({inbox:1, applied:0, 'receipt-state':0, receipt:0});
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
    await button(a,'Send cooking updates').click();
    await visible(a,'The other device applied this batch.');
    await visible(a,'Peer receipts for this connection: 1 stored, 1 applied.');
    expect(await durable(b,bHousehold)).toEqual({inbox:1, applied:1, 'receipt-state':0, receipt:0});
    await button(a,'Send cooking updates').click();
    await visible(a,'No local updates are waiting for this device.');
    await button(b,'Send cooking updates').click();
    await visible(b,'The other device applied this batch.');
    await visible(b,'Peer receipts for this connection: 2 stored, 2 applied.');
    expect(await durable(a,aHousehold)).toEqual({inbox:2, applied:2, 'receipt-state':1, receipt:2});

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
