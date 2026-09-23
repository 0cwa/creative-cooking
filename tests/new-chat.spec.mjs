import { expect, test } from '@playwright/test';

test('New chat archives the current conversation and previous chats can be reopened', async ({ page }) => {
  const state = {
    chatMessages: [{
      id: 'chat-message-1',
      role: 'user',
      content: 'Keep this conversation for later.',
      createdAt: '2026-09-23T12:00:00.000Z'
    }]
  };

  await page.addInitScript((savedState) => {
    window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify(savedState));
  }, state);

  await page.goto('./chef');
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
  const state = {
    chatMessages: [{
      id: 'swipe-message-1',
      role: 'user',
      content: 'Conversation to remove',
      createdAt: '2026-09-23T13:00:00.000Z'
    }]
  };

  await page.addInitScript((savedState) => {
    window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify(savedState));
  }, state);

  await page.goto('./chef');
  await page.getByLabel('Start a new chat').click();
  await page.getByLabel('Open previous chats').click();

  const row = page.getByTestId('conversation-row-chat-swipe-message-1');
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
