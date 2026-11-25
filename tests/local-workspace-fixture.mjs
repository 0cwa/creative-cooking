import {test,expect} from './browser-fixture.mjs';

export async function startLocalWorkspace(page, path='./') {
  await page.goto(path);
  await page.getByRole('button',{name:'Start cooking',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start cooking',exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:/^(Setting up|Opening) your kitchen/})).toHaveCount(0);
}

export {test,expect};
