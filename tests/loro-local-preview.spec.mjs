import {test,expect} from './browser-fixture.mjs';

test('fresh preview keeps cooking and private data separate and reports failed saves',async({page})=>{
 const external=[];page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:4173/'))external.push(request.url())});
 await page.goto('./');await page.getByRole('button',{name:'Start fresh local preview'}).click();
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.getByLabel('Ingredient and details').fill('Golden beet');await page.getByLabel('Add ingredient').click();
 await expect(page.getByText('Golden beet',{exact:true})).toBeVisible();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.getByText('Recipes',{exact:true}).last().click();await page.getByLabel('Add recipe').click();
 await page.getByLabel('New recipe title').fill('Beet soup');await page.getByLabel('New recipe ingredients').fill('Golden beet');await page.getByLabel('New recipe steps').fill('Simmer gently');await page.getByLabel('Save new recipe').click();
 await expect(page.getByText('Beet soup',{exact:true})).toBeVisible();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.getByText('Chef',{exact:true}).last().click();await expect(page.getByText('Messages stay private',{exact:false})).toBeVisible();await page.waitForTimeout(600);await page.getByLabel('Message Chef').fill('Private dinner idea');await expect(page.getByLabel('Message Chef')).toHaveValue('Private dinner idea');await page.getByLabel('Save private message').click();await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
 await page.goto('./');await expect(page.getByText('Golden beet',{exact:true})).toBeVisible();await page.getByText('Recipes',{exact:true}).last().click();await expect(page.getByText('Beet soup',{exact:true})).toBeVisible();await page.getByText('Chef',{exact:true}).last().click();await expect(page.getByText('Private dinner idea',{exact:true})).toBeVisible();
 await page.getByText('Pantry',{exact:true}).last().click();await page.evaluate(()=>{const old=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(typeof key==='string'&&key.startsWith('["document",')){IDBObjectStore.prototype.put=old;throw Error('injected IO')}return old.call(this,value,key)}});
 await page.getByLabel('Ingredient and details').fill('Unsaved carrot');await page.getByLabel('Add ingredient').click();await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Local save failed');await expect(page.getByText('Unsaved carrot',{exact:true})).toBeVisible();
 await page.goto('./');await expect(page.getByText('Golden beet',{exact:true})).toBeVisible();await expect(page.getByText('Unsaved carrot',{exact:true})).toHaveCount(0);expect(external).toEqual([]);
});
