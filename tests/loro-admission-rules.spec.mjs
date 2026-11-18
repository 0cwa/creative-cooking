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
  await button(readyChooser,'Open existing workspace').click();
  await expect(button(readyChooser,'Start fresh local preview')).toHaveCount(0);
  expect(await readyChooser.evaluate(key=>localStorage.getItem(key),key)).toBe(`local:${name}`);
  await button(page,'Open settings').click();
  await button(page,'Manage adult admission rules').click();
  await expect(page.getByLabel('Active adult admission rule')).toHaveText('Every adult (unanimous). Requires 1 of 1 existing adults.');
});

test('two adults review, sign and retain alternative rules without changing the open household', async ({browser, baseURL}) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({baseURL, acceptDownloads:true})));
  try {
    const [first, second] = await Promise.all(contexts.map(context => context.newPage()));
    await start(first, page => page.getByRole('radio', {name:/Every adult/}).click());
    await start(second);
    await first.getByLabel('Ingredient and details').fill('Policy proof ginger');
    await first.getByLabel('Add ingredient').click();
    await expect(first.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
    await enroll(first, second);

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
      return {unsigned:JSON.stringify({...JSON.parse(signedByFirst), approvals:[]}), complete};
    }
    const firstProposal = await retainAlternative(/All but one/, /proposed All but one .* requires 1 of 2/);
    await retainAlternative(/Fixed number of adults/, /proposed Fixed quorum of 2 requires 2 of 2/, '2');
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
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
