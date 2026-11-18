import {readFile} from 'node:fs/promises';
import {test,expect} from './browser-fixture.mjs';

const app='/creative-cooking/';
const recipeTitle='Current market soup';
const originalTitle='Superseded market soup';
const editedTitle='Newcomer market soup';
const originalPantry='Original workspace basil';
const changedPantry='Fresh invitation thyme';
const shoppingList='Invitation market';
const shoppingName='Invitation market carrots';
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const label=(page,name)=>page.getByLabel(name,{exact:true});
const text=(page,name)=>label(page,name).textContent();
const settings=async page=>{
 await page.goto(app+'settings');
 await button(page,'Show device identity').click();
 await button(page,'Invite or join a household').click();
};

test('Settings transfers and reopens a verified recipe document set',async({browser,baseURL})=>{
 test.setTimeout(120_000);
 const sponsorContext=await browser.newContext({baseURL,acceptDownloads:true});
 const newcomerContext=await browser.newContext({baseURL});
 try{
  const sponsor=await sponsorContext.newPage(),newcomer=await newcomerContext.newPage();
  for(const page of [sponsor,newcomer]){
   page.setDefaultTimeout(12_000);
   await page.goto(app);
   await button(page,'Start fresh local preview').click();
   await button(page,'Review household policy').click();
   await button(page,'Accept this household policy').click();
   await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  }
  await label(newcomer,'Ingredient and details').fill(originalPantry);
  await label(newcomer,'Add ingredient').click();
  await expect(newcomer.getByText(originalPantry,{exact:true})).toBeVisible();
  await expect(newcomer.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await newcomer.reload();
  await expect(newcomer.getByText(originalPantry,{exact:true})).toBeVisible();

  await sponsor.goto(app+'shopping');
  await label(sponsor,'New shopping list name').fill(shoppingList);
  await button(sponsor,'Create shopping list').click();
  await expect(sponsor.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
  await label(sponsor,'Shopping item name').fill(shoppingName);
  await label(sponsor,'Shopping quantity').fill('2.5');
  await label(sponsor,'Shopping unit').fill('kg');
  await button(sponsor,'Add').click();
  await expect(sponsor.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');

  // The production UI runs from the exported bundle. Use the source fixture
  // page only to allocate a child in the current branch before the UI flow.
  await sponsor.goto('/');
  const catalog=await sponsor.evaluate(async ({originalTitle,recipeTitle})=>{
   const {openLocalWorkspace}=await import('/src/loro/app/bootstrap.web.ts');
   const {openSelectedRecipeCatalog}=await import('/src/loro/app/selected-recipe-catalog.mjs');
   const {projectCooking,projectRecipes}=await import('/src/loro/domain/app-projection.mjs');
   const {executeAction}=await import('/src/loro/app/action.mjs');
   const {planRecipeAction}=await import('/src/loro/app/recipe-actions.mjs');
   const name=localStorage.getItem('creative-cooking-local-workspace-v1');
   const workspace=await openLocalWorkspace(name);
   try{
    const runtime=workspace.household,recipeId='invitation-market-soup';
    const child=await runtime.forRecipe(recipeId);
    const at=new Date().toISOString(),author=workspace.deviceId;
    const save=async (actionId,before,after)=>{
     const {doc}=await child.document();
     const commands=planRecipeAction({doc,before,after,actionId,author,at});
     await executeAction(child,workspace.sequences,actionId,commands,workspace.disclosure);
    };
    await save('fixture-create-child',null,{id:recipeId,title:originalTitle,description:'',
     portions:2,ingredients:[{id:'carrot',name:'carrots',amount:'2 cups',needsShopping:false}],
     steps:['Simmer gently.'],stepIds:['simmer'],notes:[],createdAt:at,updatedAt:at});
    const [before]=projectRecipes((await child.document()).doc);
    await save('fixture-update-child',before,{...before,title:recipeTitle});
    const selected=await openSelectedRecipeCatalog(runtime);
    return {root:runtime.scope.documentId,child:selected.children.get(recipeId).documentId,
     rootRecipes:projectRecipes(selected.parent.doc),childRecipes:projectRecipes(selected.children.get(recipeId).doc),
     shopping:projectCooking(selected.parent.doc).shopping};
   }finally{workspace.close()}
  },{originalTitle,recipeTitle});
  expect(catalog.child).not.toBe(catalog.root);
  expect(catalog.rootRecipes).toEqual([]);
  expect(catalog.childRecipes.map(recipe=>recipe.title)).toEqual([recipeTitle]);
  expect(catalog.shopping.items).toContainEqual(expect.objectContaining({
   name:shoppingName,displayQuantity:'2.5',displayUnit:'kg',
  }));

  await settings(sponsor);
  await settings(newcomer);
  const identity=await text(newcomer,'Public device identity');
  await label(sponsor,'Recipient public identity').fill(identity);
  await button(sponsor,'Prepare current-cooking invitation').click();
  await expect(label(sponsor,'Public invitation message')).toBeVisible().catch(async error=>{
   console.error('Preparation status',await sponsor.getByRole('alert').allTextContents());
   throw error;
  });
  let offer=await text(sponsor,'Public invitation message');
  expect(JSON.parse(offer).manifestVersion).toBe(5);
  for(const value of [recipeTitle,originalTitle,shoppingName])expect(offer).not.toContain(value);
  let code=await text(sponsor,'Invitation verification code');
  await button(sponsor,'Show public household authority').click();
  await label(newcomer,'Household authority bundle').fill(await text(sponsor,'Public household authority'));
  await label(newcomer,'Confirmed household root').fill(await text(sponsor,'Household root to compare'));
  await label(newcomer,'Confirmed household head').fill(await text(sponsor,'Household head to compare'));
  await button(newcomer,'Verify and accept public authority').click();
  await expect(newcomer.getByText('Public authority accepted. No access or keys have been granted.')).toBeVisible();

  const resume=async (page,confirmation)=>{
   await label(page,'Confirmed invitation code').fill(confirmation);
   await button(page,'Start or resume device verification').click();
  };
  const offerToNewcomer=async()=>{
   await button(newcomer,'Join invitation').click();
   await label(newcomer,'Public invitation message input').fill(offer);
  };
  await offerToNewcomer();
  await resume(newcomer,'0'.repeat(64));
  await expect(newcomer.getByText('CONFIRMATION_REQUIRED',{exact:true})).toBeVisible();
  const downgraded=JSON.parse(offer);
  delete downgraded.manifestVersion;
  await label(newcomer,'Public invitation message input').fill(JSON.stringify(downgraded));
  await resume(newcomer,code);
  await expect(newcomer.getByText('INVALID_PROOF',{exact:true})).toBeVisible();
  const finishVerification=async(reopenOrganizer=false)=>{
   await label(newcomer,'Public invitation message input').fill(offer);
   await resume(newcomer,code);
   await resume(sponsor,code);
   for(const state of ['Exchange your response with the other device.',
    'Exchange your acknowledgement with the other device.','Both devices have completed verification.']){
    const [left,right]=await Promise.all([text(sponsor,'Your verification message'),text(newcomer,'Your verification message')]);
    await label(sponsor,'Other device verification message').fill(right);
    await label(newcomer,'Other device verification message').fill(left);
    for(const page of [sponsor,newcomer]){
     await button(page,'Continue device verification').click();
     await expect(page.getByText(state,{exact:true})).toBeVisible();
    }
    if(reopenOrganizer&&state.startsWith('Exchange your response')){
     await settings(sponsor);
     await label(sponsor,'Recipient public identity').fill(identity);
     await button(sponsor,'Prepare current-cooking invitation').click();
     await expect(label(sponsor,'Public invitation message')).toHaveText(offer);
     await resume(sponsor,code);
     await expect(sponsor.getByText(state,{exact:true})).toBeVisible();
    }
   }
  };
  await finishVerification(true);
  const editor=await sponsorContext.newPage();
  try{
   await editor.goto(app);
   await expect(editor.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
   await label(editor,'Ingredient and details').fill(changedPantry);
   await label(editor,'Add ingredient').click();
   await expect(editor.getByText(changedPantry,{exact:true})).toBeVisible();
   await expect(editor.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  }finally{await editor.close();}
  await button(sponsor,'Admit and download encrypted household file').click();
  await expect(sponsor.getByText('Cooking changed after this invitation was prepared. Restart it and compare a new verification code.')).toBeVisible();
  await expect(button(sponsor,'Admit and download encrypted household file')).toHaveCount(0);
  await expect(sponsor.getByText(/^Encrypted files for household generation/)).toHaveCount(0);
  const previous=JSON.parse(offer),oldCode=code;
  await button(sponsor,'Restart invitation with current cooking').click();
  await expect(label(sponsor,'Public invitation message')).toBeVisible();
  offer=await text(sponsor,'Public invitation message');
  code=await text(sponsor,'Invitation verification code');
  expect(code).not.toBe(oldCode);
  expect(JSON.parse(offer).grant.keyEnvelopeRefs).not.toEqual(previous.grant.keyEnvelopeRefs);
  expect(JSON.parse(offer).item.event.proposalId).toBe(previous.item.event.proposalId);
  await label(newcomer,'Public invitation message input').fill(offer);
  await resume(newcomer,oldCode);
  await expect(newcomer.getByText('CONFIRMATION_REQUIRED',{exact:true})).toBeVisible();
  await finishVerification();
  const download=async (name)=>{
   const pending=sponsor.waitForEvent('download',{timeout:12_000});
   await button(sponsor,name).click();
   return readFile(await (await pending).path());
  };
  const file=await download('Admit and download encrypted household file');
  const recipient=JSON.parse(identity).deviceId;
  await expect(button(sponsor,`Download encrypted file for new device ${recipient}`)).toHaveCount(1);
  await settings(sponsor);
  await label(sponsor,'Previously prepared invitation message').fill(offer);
  expect(await download('Download an already admitted household file')).toEqual(file);

  const install=async (buffer=file)=>{
   const pending=newcomer.waitForEvent('filechooser');
   await button(newcomer,'Choose encrypted household file').click();
   await (await pending).setFiles({name:'household.bin',mimeType:'application/octet-stream',buffer});
  };
  const corrupted=Buffer.from(file);
  corrupted[corrupted.length-1]^=1;
  await install(corrupted);
  await expect(newcomer.getByText('INVALID_FILE',{exact:true})).toBeVisible();
  await expect(button(newcomer,'Open this shared household')).toHaveCount(0);
  await label(newcomer,'Public invitation message input').fill(JSON.stringify(previous));
  await resume(newcomer,oldCode);
  await expect(newcomer.getByText('Both devices have completed verification.')).toBeVisible();
  await install();
  await expect(newcomer.getByText('INVALID_PROOF',{exact:true})).toBeVisible();
  await expect(button(newcomer,'Open this shared household')).toHaveCount(0);
  await label(newcomer,'Public invitation message input').fill(offer);
  await resume(newcomer,code);
  await expect(newcomer.getByText('Both devices have completed verification.')).toBeVisible();
  await install();
  await expect(newcomer.getByText(/^Household installed\./)).toBeVisible();
  await expect(label(newcomer,'Open household')).toContainText('Original local household');
  await settings(newcomer);
  await offerToNewcomer();
  await resume(newcomer,code);
  await expect(newcomer.getByText('Both devices have completed verification.')).toBeVisible();
  await install();
  await expect(newcomer.getByText(/^This household was already installed\./)).toBeVisible();
  await button(newcomer,'Open this shared household').click();
  await expect(newcomer.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await expect(newcomer.getByText(changedPantry,{exact:true})).toBeVisible();

  const checkCooking=async (page,title)=>{
   await page.goto(app+'recipes');
   await label(page,'Open recipe '+title).click();
   await expect(page.getByText(/2 cups carrots/)).toBeVisible();
   await expect(page.getByText('1. Simmer gently.',{exact:true})).toBeVisible();
   await page.goto(app+'shopping');
   await expect(page.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
   const list=button(page,shoppingList);
   if(await list.count())await list.click();
   await expect(page.getByText(shoppingName,{exact:true})).toBeVisible();
   await expect(page.getByText('2.5 kg',{exact:true})).toBeVisible();
  };
  await checkCooking(sponsor,recipeTitle);
  await checkCooking(newcomer,recipeTitle);
  await newcomer.goto(app+'recipes');
  await label(newcomer,'Open recipe '+recipeTitle).click();
  await label(newcomer,'Edit recipe '+recipeTitle).click();
  await label(newcomer,'Recipe title').fill(editedTitle);
  await label(newcomer,'Save recipe changes').click();
  await expect(newcomer.getByRole('dialog').getByText(editedTitle,{exact:true})).toBeVisible();
  await label(newcomer,'Close recipe').click();
  await newcomer.getByRole('tab',{name:/Pantry/}).click();
  await expect(newcomer.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally').catch(async error=>{
   await button(newcomer,'Open settings').click();
   const failure=newcomer.getByText('Local data is not being saved',{exact:true});
   console.error('Recipe save status',await failure.locator('..').innerText({timeout:3000}).catch(()=>'(missing error detail)'));
   throw error;
  });
  await newcomer.reload();
  await checkCooking(newcomer,editedTitle);

  await newcomer.goto(app);
  await expect(newcomer.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
  await button(newcomer,'Open settings').click();
  await button(newcomer,'Show device identity').click();
  await button(newcomer,'Return to original local household').click();
  await expect(newcomer.getByText(originalPantry,{exact:true})).toBeVisible().catch(async error=>{
   console.error('Return to original household',newcomer.url(),await newcomer.getByRole('alert').allTextContents());
   throw error;
  });
  await newcomer.goto(app+'recipes');
  await expect(label(newcomer,'Open recipe '+editedTitle)).toHaveCount(0);
 }finally{
  await newcomerContext.close();
  await sponsorContext.close();
 }
});
