import {readFile} from 'node:fs/promises';
import {test, expect} from './browser-fixture.mjs';

const button = (page, name) => page.getByRole('button', {name, exact:true});
const text = (page, name) => page.getByLabel(name, {exact:true}).textContent();
const message = page => page.getByLabel('Admission rule proposal message');
const notice = (page, value) => page.getByRole('alert').filter({hasText:value});

async function start(page, selectRule = async () => {}) {
  await page.goto('./');
  await expect(page.getByText(/with the default, one adult can approve an invitation/i)).toBeVisible();
  await selectRule(page);
  await button(page, 'Start fresh local preview').click();
  await button(page, 'Review household policy').click();
  await button(page, 'Accept this household policy').click();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
}

async function enroll(first, second) {
  for (const page of [first, second]) {
    await button(page, 'Open settings').click();
    await button(page, 'Show device identity').click();
    await button(page, 'Invite or join a household').click();
  }
  const firstIdentity = JSON.parse(await text(first, 'Public device identity'));
  const secondIdentity = await text(second, 'Public device identity');
  expect(firstIdentity.adultId).not.toBe(JSON.parse(secondIdentity).adultId);
  await first.getByLabel('Recipient public identity').fill(secondIdentity);
  await button(first, 'Prepare current-cooking invitation').click();
  const offer = await text(first, 'Public invitation message');
  const code = await text(first, 'Invitation verification code');
  await button(first, 'Show public household authority').click();
  await second.getByLabel('Household authority bundle').fill(await text(first, 'Public household authority'));
  await second.getByLabel('Confirmed household root').fill(await text(first, 'Household root to compare'));
  await second.getByLabel('Confirmed household head').fill(await text(first, 'Household head to compare'));
  await button(second, 'Verify and accept public authority').click();
  await expect(second.getByText('Public authority accepted. No access or keys have been granted.')).toBeVisible();
  await button(second, 'Join invitation').click();
  await second.getByLabel('Public invitation message input').fill(offer);
  for (const page of [first, second]) {
    await page.getByLabel('Confirmed invitation code').fill(code);
    await button(page, 'Start or resume device verification').click();
  }
  for (const status of ['Exchange your response with the other device.', 'Exchange your acknowledgement with the other device.', 'Both devices have completed verification.']) {
    const firstMessage = await text(first, 'Your verification message');
    const secondMessage = await text(second, 'Your verification message');
    await first.getByLabel('Other device verification message').fill(secondMessage);
    await second.getByLabel('Other device verification message').fill(firstMessage);
    for (const page of [first, second]) {
      await button(page, 'Continue device verification').click();
      await expect(page.getByText(status)).toBeVisible();
    }
  }
  const pending = first.waitForEvent('download');
  await button(first, 'Admit and download encrypted household file').click();
  const file = await readFile(await (await pending).path());
  const upload = second.waitForEvent('filechooser');
  await button(second, 'Choose encrypted household file').click();
  await (await upload).setFiles({name:'household.bin', mimeType:'application/octet-stream', buffer:file});
  await button(second, 'Open this shared household').click();
  for (const page of [first, second]) {
    await page.goto('./');
    await expect(page.getByText('Policy proof ginger', {exact:true})).toBeVisible();
    await button(page, 'Open settings').click();
    await button(page, 'Manage adult admission rules').click();
    await expect(page.getByLabel('Active adult admission rule')).toHaveText('Every adult (unanimous). Requires 2 of 2 existing adults.');
  }
}

async function receive(page, signed) {
  await message(page).fill(signed);
  await button(page, 'Review admission rule proposal').click();
}

async function addIngredient(page, ingredient) {
  await page.getByLabel('Ingredient and details').fill(ingredient);
  await page.getByLabel('Add ingredient').click();
  await expect(page.getByText(ingredient, {exact:true})).toBeVisible();
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
}

async function openRules(page) {
  await button(page, 'Open settings').click();
  await button(page, 'Manage adult admission rules').click();
  await expect(page.getByLabel('Active adult admission rule')).toBeVisible();
}

async function downloadUpdate(page, objectId) {
  await button(page, 'Exchange encrypted cooking files').click();
  const item = objectId ? button(page, `Download encrypted update ${objectId}`) : page.getByRole('button', {name:/Download encrypted update /});
  const transfer = page.waitForEvent('download');
  await item.click();
  return readFile(await (await transfer).path());
}

async function importUpdate(page, bytes, expectedError) {
  await button(page, 'Open settings').click();
  await button(page, 'Exchange encrypted cooking files').click();
  const transfer = page.waitForEvent('filechooser');
  await button(page, 'Choose encrypted cooking update').click();
  const loaded = expectedError ? null : page.waitForEvent('load');
  await (await transfer).setFiles({name:'cooking.bin', mimeType:'application/octet-stream', buffer:bytes});
  if (expectedError) await expect(notice(page, expectedError)).toBeVisible();
  else await loaded;
  await page.goto('./');
}

async function retainedBranchState(page, scopeId) {
  return page.evaluate(async scope => {
    const name = localStorage.getItem('creative-cooking-local-workspace-v1');
    const request = operation => new Promise((resolve,reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
    });
    const db = await request(indexedDB.open(`${name}-records`));
    try {
      const storage = db.transaction('records','readonly').objectStore('records');
      const keys = await request(storage.getAllKeys());
      const kept = keys.filter(key => {
        const [kind, first, second] = JSON.parse(key);
        return kind === 'pairing-authority' ? first === 'household' && second === scope : first === scope &&
          ['document','document-owner','object','policy-checkout-parent','policy-disclosure-head','disclosure-active'].includes(kind);
      });
      return Object.fromEntries(await Promise.all(kept.map(async key => [key,JSON.parse(JSON.stringify(await request(storage.get(key))))])));
    } finally { db.close(); }
  }, scopeId);
}

async function reviewBranch(page, head) {
  await button(page, `Review cooking branch ${head}`).click();
  await expect(page.getByText(`Open cooking branch ${head} on this device?`)).toBeVisible();
}

async function confirmBranch(page) {
  const opened = page.waitForURL(url => url.pathname.endsWith('/creative-cooking/'));
  await button(page, 'Open this cooking branch').click();
  await opened;
  await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
}

test('fresh setup bounds fixed quorum by the actual electorate and preserves the choice on reload', async ({page}) => {
  await start(page, async () => {
    await page.getByRole('radio', {name:/Fixed number of adults/}).click();
    const count = page.getByLabel('Number of required adult approvals');
    await count.fill('2');
    await expect(button(page, 'Start fresh local preview')).toBeDisabled();
    await expect(page.getByText('Enter a whole number from 1 to 1, the size of the current electorate.')).toBeVisible();
    await count.fill('1');
  });
  await page.reload();
  await button(page, 'Open settings').click();
  await button(page, 'Manage adult admission rules').click();
  await expect(page.getByLabel('Active adult admission rule')).toHaveText('Fixed quorum of 1. Requires 1 of 1 existing adults.');
});

test('legacy choice persists without Web Locks', async ({page}) => {
  await page.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined}));
  await page.goto('./');
  await button(page,'Open existing workspace').click();
  await expect(button(page,'Open settings')).toBeVisible();
  await page.reload();
  await expect(button(page,'Open settings')).toBeVisible();
  await expect(button(page,'Start fresh local preview')).toHaveCount(0);
});

test('stale choosers preserve both pending and ready fresh workspace choices', async ({page, context}) => {
  const key='creative-cooking-storage-choice-v1';
  await page.goto('./');
  const [pendingChooser,readyChooser]=await Promise.all([context.newPage(),context.newPage()]);
  for(const chooser of [pendingChooser,readyChooser]){
    await chooser.goto(page.url());
    await expect(button(chooser,'Open existing workspace')).toBeVisible();
  }
  await page.getByRole('radio', {name:/Every adult/}).click();
  await page.evaluate(key=>{
    const save=Storage.prototype.setItem;
    Storage.prototype.setItem=function(name,value){
      if(name===key&&value.startsWith('local:'))throw Error('test: ready write failed');
      return save.call(this,name,value);
    };
  },key);
  await button(page,'Start fresh local preview').click();
  await expect(page.getByText('test: ready write failed')).toBeVisible();
  const saved=await page.evaluate(key=>localStorage.getItem(key),key);
  expect(saved).toMatch(/^pending:/);
  const {name,policy}=JSON.parse(saved.slice('pending:'.length));
  expect(policy).toEqual({kind:'unanimous',fixedCount:null});
  await button(pendingChooser,'Open existing workspace').click();
  await expect(button(pendingChooser,'Start fresh local preview')).toHaveCount(0);
  expect(await pendingChooser.evaluate(key=>localStorage.getItem(key),key)).toBe(saved);
  await page.reload();
  await button(page,'Review household policy').click();
  await button(page,'Accept this household policy').click();
  expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBe(`local:${name}`);
  await readyChooser.evaluate(()=>Object.defineProperty(navigator,'locks',{value:undefined}));
  await button(readyChooser,'Open existing workspace').click();
  await expect(button(readyChooser,'Start fresh local preview')).toHaveCount(0);
  expect(await readyChooser.evaluate(key=>localStorage.getItem(key),key)).toBe(`local:${name}`);
  await button(page,'Open settings').click();
  await button(page,'Manage adult admission rules').click();
  await expect(page.getByLabel('Active adult admission rule')).toHaveText('Every adult (unanimous). Requires 1 of 1 existing adults.');
});

test('two adults retain competing rules and open isolated cooking branches explicitly', async ({browser, baseURL}) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({baseURL, acceptDownloads:true})));
  try {
    const [first, second] = await Promise.all(contexts.map(context => context.newPage()));
    await start(first, page => page.getByRole('radio', {name:/Every adult/}).click());
    await start(second);
    await first.getByLabel('Ingredient and details').fill('Policy proof ginger');
    await first.getByLabel('Add ingredient').click();
    await expect(first.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    await enroll(first, second);
    const scopeId = (await text(first, 'Open household')).split(' · ')[1];
    const parentHead = (await first.getByText(/Current household head:/).textContent()).split(': ')[1];
    await first.goto('./');
    await addIngredient(first, 'Signed frontier thyme');
    await openRules(first);
    const parentUpdate = await downloadUpdate(first);
    const parentHeader = JSON.parse(parentUpdate.toString()).header;
    expect(parentHeader.branchHead).toBe(parentHead);

    async function retainAlternative(label, projected, quorum) {
      await first.getByRole('radio', {name:label}).click();
      if (quorum) await first.getByLabel('Number of required adult approvals').fill(quorum);
      await button(first, 'Create admission rule proposal').click();
      await expect(first.getByText('0 of 2 required approvals under the current rule.')).toBeVisible();
      await expect(first.getByText(projected)).toBeVisible();
      await button(first, 'Sign approval for reviewed rule').click();
      await expect(first.getByText('1 of 2 required approvals under the current rule.')).toBeVisible();
      await expect(button(first, 'Retain approved admission rule')).toBeDisabled();
      const signedByFirst = await message(first).inputValue();
      const altered = JSON.parse(signedByFirst);
      altered.event.proposalId = 'altered';
      await receive(second, JSON.stringify(altered));
      await expect(notice(second, 'INVALID_PROOF')).toBeVisible();
      await expect(button(second, 'Sign approval for reviewed rule')).toHaveCount(0);
      await receive(second, signedByFirst);
      await expect(second.getByText(projected)).toBeVisible();
      await button(second, 'Sign approval for reviewed rule').click();
      await expect(second.getByText('2 of 2 required approvals under the current rule.')).toBeVisible();
      const complete = await message(second).inputValue();
      expect(new Set(JSON.parse(complete).approvals.map(approval => approval.adultId)).size).toBe(2);
      await button(second, 'Retain approved admission rule').click();
      await expect(notice(second, 'Approved rule retained')).toBeVisible();
      await receive(first, complete);
      await button(first, 'Retain approved admission rule').click();
      await expect(notice(first, 'Approved rule retained')).toBeVisible();
      return {unsigned:JSON.stringify({...JSON.parse(signedByFirst), approvals:[]}), complete, head:JSON.parse(complete).approvals[0].eventHash};
    }
    const firstProposal = await retainAlternative(/All but one/, /proposed All but one .* requires 1 of 2/);
    const sibling = await retainAlternative(/Fixed number of adults/, /proposed Fixed quorum of 2 requires 2 of 2/, '2');
    for (const page of [first, second]) {
      await page.goto('./');
      await expect(page.getByText('Policy proof ginger', {exact:true})).toBeVisible();
      await button(page, 'Open settings').click();
      await button(page, 'Manage adult admission rules').click();
      await expect(page.getByLabel('Active adult admission rule')).toHaveText('Every adult (unanimous). Requires 2 of 2 existing adults.');
      await expect(page.getByText('All but one (default) · Retained')).toBeVisible();
      await expect(page.getByText('Fixed quorum of 2 · Retained')).toBeVisible();
    }
    await first.getByRole('radio', {name:/All but one/}).click();
    await button(first, 'Create admission rule proposal').click();
    await expect(message(first)).toHaveValue(firstProposal.unsigned);
    await receive(first, firstProposal.complete);
    await button(first, 'Retain approved admission rule').click();
    await expect(notice(first, 'This approved rule is already retained.')).toBeVisible();

    await reviewBranch(second, firstProposal.head);
    const missingBefore = await retainedBranchState(second, scopeId);
    await button(second, 'Open this cooking branch').click();
    await expect(notice(second, 'This device needs the cooking updates')).toBeVisible();
    expect(await retainedBranchState(second, scopeId)).toEqual(missingBefore);
    await second.goto('./');
    await importUpdate(second, parentUpdate);
    await expect(second.getByText('Signed frontier thyme', {exact:true})).toBeVisible();

    await first.goto('./');
    await addIngredient(first, 'Parent-only fennel');
    await openRules(first);
    const stale = await contexts[0].newPage();
    await stale.goto('./');
    await openRules(stale);
    await reviewBranch(stale, sibling.head);
    await reviewBranch(first, firstProposal.head);
    const beforeFault = await retainedBranchState(first, scopeId);
    await first.evaluate(target => {
      const save = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, slot) {
        if (typeof slot === 'string' && JSON.parse(slot)[0] === 'pairing-authority' && value.acceptedParent === target) {
          IDBObjectStore.prototype.put = save;
          throw Error('injected policy checkout failure');
        }
        return save.call(this, value, slot);
      };
    }, firstProposal.head);
    await button(first, 'Open this cooking branch').click();
    await expect(notice(first, 'Could not save the branch switch')).toBeVisible();
    expect(await retainedBranchState(first, scopeId)).toEqual(beforeFault);

    const choiceKey='creative-cooking-storage-choice-v1';
    const savedChoice=await stale.evaluate(key=>localStorage.getItem(key),choiceKey);
    await first.evaluate(choiceKey=>{
      const save=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){
        save.call(this,key,value);
        if(this===sessionStorage&&key==='creative-cooking-branch-reopen-v1')save.call(localStorage,choiceKey,'legacy');
      };
    },choiceKey);
    const reopening=first.waitForURL(url=>url.pathname.endsWith('/creative-cooking/'));
    await button(first,'Open this cooking branch').click();
    await reopening;
    await expect(first.getByText('The household branch changed before it could reopen. Retry to review the current workspace.')).toBeVisible();
    await expect(first.getByText('Signed frontier thyme',{exact:true})).toHaveCount(0);
    await stale.evaluate(({key,value})=>localStorage.setItem(key,value),{key:choiceKey,value:savedChoice});
    await first.reload();
    await openRules(second);
    await reviewBranch(second, firstProposal.head);
    await confirmBranch(second);
    for (const page of [first, second]) {
      await expect(page.getByText('Signed frontier thyme', {exact:true})).toBeVisible();
      await expect(page.getByText('Policy proof ginger', {exact:true})).toBeVisible();
      await expect(page.getByText('Parent-only fennel', {exact:true})).toHaveCount(0);
    }
    const afterCheckout = await retainedBranchState(first, scopeId);
    for (const key of Object.keys(beforeFault).filter(key => ['document','document-owner','object'].includes(JSON.parse(key)[0]))) {
      expect(afterCheckout[key]).toEqual(beforeFault[key]);
    }
    for (const page of [first, second]) {
      const state = await retainedBranchState(page, scopeId);
      expect(state[JSON.stringify(['document-owner',scopeId,`policy-${firstProposal.head}`])]).toBe(firstProposal.head);
    }
    await importUpdate(second, parentUpdate, 'INVALID_AUTHORITY');
    await first.getByLabel('Remove Signed frontier thyme').click();
    await expect(first.getByText('Signed frontier thyme', {exact:true})).toHaveCount(0);
    await expect(first.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    await openRules(first);
    const branchUpdate = await downloadUpdate(first);
    const branchHeader = JSON.parse(branchUpdate.toString()).header;
    expect(branchHeader.branchHead).toBe(firstProposal.head);
    expect(branchHeader.documentId).toBe(`policy-${firstProposal.head}`);
    expect(branchHeader.epochId).toBe(parentHeader.epochId);
    expect(branchHeader.documentGeneration).toBe(parentHeader.documentGeneration);
    expect(branchHeader.sourceEffectIds).toEqual(parentHeader.semanticEffectIds);
    await importUpdate(second, branchUpdate);
    await expect(second.getByText('Signed frontier thyme', {exact:true})).toHaveCount(0);
    await second.getByLabel('Remove Policy proof ginger').click();
    await expect(second.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    await openRules(second);
    const seededEdit = await downloadUpdate(second);
    const seededHeader = JSON.parse(seededEdit.toString()).header;
    expect(seededHeader.documentId).toBe(branchHeader.documentId);
    expect(seededHeader.disclosureIncomplete).toBe(true);
    expect(seededHeader.disclosurePolicyHashes.length).toBeGreaterThan(0);
    await first.goto('./');
    await importUpdate(first, seededEdit);
    await expect(first.getByText('Policy proof ginger', {exact:true})).toHaveCount(0);

    await openRules(first);
    await reviewBranch(first, sibling.head);
    await confirmBranch(first);
    await expect(first.getByText('Policy proof ginger', {exact:true})).toBeVisible();
    await expect(first.getByText('Signed frontier thyme', {exact:true})).toBeVisible();
    await addIngredient(first, 'Sibling-only parsley');
    await openRules(first);
    await reviewBranch(first, parentHead);
    await confirmBranch(first);
    await expect(first.getByText('Parent-only fennel', {exact:true})).toBeVisible();
    await expect(first.getByText('Signed frontier thyme', {exact:true})).toBeVisible();
    await expect(first.getByText('Sibling-only parsley', {exact:true})).toHaveCount(0);

    const beforeStale = await retainedBranchState(first, scopeId);
    await button(stale, 'Open this cooking branch').click();
    await expect(notice(stale, 'The household changed')).toBeVisible();
    expect(await retainedBranchState(first, scopeId)).toEqual(beforeStale);
    await button(stale, 'Back').click();
    await stale.getByLabel('Ingredient and details').fill('Stale-tab unsaved rosemary');
    await stale.getByLabel('Add ingredient').click();
    await expect(stale.getByTestId('pantry-local-persistence-status')).toHaveText('Local save failed');
    await expect(stale.getByText('Stale-tab unsaved rosemary', {exact:true})).toBeVisible();
    expect(await retainedBranchState(first, scopeId)).toEqual(beforeStale);
    await stale.close();

    await openRules(first);
    await reviewBranch(first, firstProposal.head);
    await confirmBranch(first);
    await first.reload();
    await expect(first.getByText('Policy proof ginger', {exact:true})).toHaveCount(0);
    await expect(first.getByText('Signed frontier thyme', {exact:true})).toHaveCount(0);
    await expect(first.getByText('Parent-only fennel', {exact:true})).toHaveCount(0);
    await openRules(first);
    expect(await downloadUpdate(first)).toEqual(branchUpdate);
    await reviewBranch(first, sibling.head);
    await first.evaluate(()=>{
      const save=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){
        if(this===sessionStorage&&key==='creative-cooking-branch-reopen-v1'){
          window.checkoutSessionWriteDenied=true;
          throw Error('injected session storage denial');
        }
        return save.call(this,key,value);
      };
    });
    await button(first,'Open this cooking branch').click();
    const manageRules=button(first,'Manage adult admission rules'), openSettings=button(first,'Open settings');
    await expect(manageRules.or(openSettings)).toBeVisible().catch(async error=>{
      console.error('In-place checkout reopen',await first.locator('body').innerText());
      throw error;
    });
    expect(await first.evaluate(()=>window.checkoutSessionWriteDenied)).toBe(true);
    if(await openSettings.isVisible())await openSettings.click();
    await manageRules.click();
    await expect(first.getByText(`Current household head: ${sibling.head}`,{exact:true})).toBeVisible();
    await first.goto('./');
    await expect(first.getByText('Sibling-only parsley', {exact:true})).toBeVisible();
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
