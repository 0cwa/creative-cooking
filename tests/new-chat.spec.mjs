import { expect, test, startLocalWorkspace } from './local-workspace-fixture.mjs';

test('New notes archives current notes and previous notes can be reopened', async ({ page }) => {
  await startLocalWorkspace(page,'./chef');
  await page.getByLabel('Private cooking note').fill('Keep this conversation for later.');
  await page.getByLabel('Save note').click();
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
  await expect(page.getByText('Keep this conversation for later.', { exact: true })).toBeVisible();

  await page.getByLabel('Start new notes').click();

  await expect(page.getByText('Keep this conversation for later.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Keep a cooking idea', { exact: true })).toBeVisible();

  await page.getByLabel('Open previous notes').click();
  await expect(page.getByText('Previous notes', { exact: true })).toBeVisible();
  await expect(page.getByText('Keep this conversation for later.', { exact: true })).toBeVisible();

  await page.getByLabel('Open notes Keep this conversation for later.').click();
  await expect(page.getByText('Keep this conversation for later.', { exact: true })).toBeVisible();
  await expect(page.getByText('Previous notes', { exact: true })).toHaveCount(0);
});

test('previous notes support swipe-to-delete with confirmation', async ({ page }) => {
  await startLocalWorkspace(page,'./chef');
  await page.getByLabel('Private cooking note').fill('Conversation to remove');
  await page.getByLabel('Save note').click();
  await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
  await page.getByLabel('Start new notes').click();
  await page.getByLabel('Open previous notes').click();

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
  await expect(page.getByText('No previous notes yet', { exact: true })).toBeVisible();
});
