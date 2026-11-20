import { expect, test, startLocalWorkspace } from './local-workspace-fixture.mjs';

test('New chat archives the current conversation and previous chats can be reopened', async ({ page }) => {
  await startLocalWorkspace(page,'./chef');
  await page.getByLabel('Message Chef').fill('Keep this conversation for later.');
  await page.getByLabel('Save private message').click();
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
  await expect(page.getByText('Keep this conversation for later.', { exact: true })).toBeVisible();

  await page.getByLabel('Start a new chat').click();

  await expect(page.getByText('Keep this conversation for later.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('What sounds good?', { exact: true })).toBeVisible();

  await page.getByLabel('Open previous chats').click();
  await expect(page.getByText('Previous chats', { exact: true })).toBeVisible();
  await expect(page.getByText('Keep this conversation for later.', { exact: true })).toBeVisible();

  await page.getByLabel('Open conversation Keep this conversation for later.').click();
  await expect(page.getByText('Keep this conversation for later.', { exact: true })).toBeVisible();
  await expect(page.getByText('Previous chats', { exact: true })).toHaveCount(0);
});

test('previous chats support swipe-to-delete with confirmation', async ({ page }) => {
  await startLocalWorkspace(page,'./chef');
  await page.getByLabel('Message Chef').fill('Conversation to remove');
  await page.getByLabel('Save private message').click();
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
  await page.getByLabel('Start a new chat').click();
  await page.getByLabel('Open previous chats').click();

  const row = page.getByTestId(/^conversation-row-/).filter({hasText:'Conversation to remove'});
  await expect(row).toBeVisible();

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('Conversation to remove');
    await dialog.accept();
  });

  const box = await row.boundingBox();
  if (!box) throw new Error('Conversation row has no layout box');
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByText('Conversation to remove', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No previous chats yet', { exact: true })).toBeVisible();
});
