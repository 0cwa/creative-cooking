import {expect} from '@playwright/test';

export async function openHouseholdTools(page) {
  const section = page.getByRole('button', {name:'Household and advanced tools', exact:true});
  await expect(section).toBeVisible();
  if (await section.getAttribute('aria-expanded') !== 'true') await section.click();
  await expect(section).toHaveAttribute('aria-expanded', 'true');
}

export async function openSavedCloudConnections(page) {
  const section = page.getByRole('button', {name:'Saved cloud connections', exact:true});
  await expect(section).toBeVisible();
  if (await section.getAttribute('aria-expanded') !== 'true') await section.click();
  await expect(section).toHaveAttribute('aria-expanded', 'true');
}
