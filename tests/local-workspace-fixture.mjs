import {test,expect} from './browser-fixture.mjs';

export async function startLocalWorkspace(page, path='./') {
  await page.goto(path);
  await page.getByRole('button',{name:'Set up my kitchen',exact:true}).click();
  await page.getByRole('button',{name:'Accept settings and open my kitchen',exact:true}).click();
  await expect(page.getByRole('button',{name:'Accept settings and open my kitchen',exact:true})).toHaveCount(0);
}

export {test,expect};
