import {test,expect} from './browser-fixture.mjs';

export async function startLocalWorkspace(page, path='./') {
  await page.goto(path);
  await page.getByRole('button',{name:'Start fresh local preview',exact:true}).click();
  await page.getByRole('button',{name:'Review household policy',exact:true}).click();
  await page.getByRole('button',{name:'Accept this household policy',exact:true}).click();
  await expect(page.getByRole('button',{name:'Accept this household policy',exact:true})).toHaveCount(0);
}

export {test,expect};
