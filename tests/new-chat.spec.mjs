import { expect, test } from '@playwright/test';

test('New chat clears the current conversation after web confirmation', async ({ page }) => {
  const state = {
    chatMessages: [{
      id: 'chat-message-1',
      role: 'user',
      content: 'Keep this conversation until I confirm.',
      createdAt: '2026-09-23T12:00:00.000Z'
    }]
  };

  await page.addInitScript((savedState) => {
    window.localStorage.setItem('creative-cooking-state-v1', JSON.stringify(savedState));
  }, state);

  await page.goto('./chef');
  await expect(page.getByText('Keep this conversation until I confirm.', { exact: true })).toBeVisible();

  let confirmationMessage = '';
  page.once('dialog', async (dialog) => {
    confirmationMessage = dialog.message();
    expect(dialog.type()).toBe('confirm');
    await dialog.accept();
  });

  await page.getByLabel('Start a new chat').click();

  await expect.poll(() => confirmationMessage).toContain('Start a new chat?');
  await expect(page.getByText('Keep this conversation until I confirm.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('What sounds good?', { exact: true })).toBeVisible();
});
