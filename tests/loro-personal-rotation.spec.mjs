import {openHouseholdTools, openSavedCloudConnections} from './settings-navigation.mjs';
import {test,expect} from './browser-fixture.mjs';
import {readFile,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

const button=(page,name)=>page.getByRole('button',{name,exact:true});
const label=(page,name)=>page.getByLabel(name,{exact:true});
const click=(page,name)=>button(page,name).click();
const openPersonal=page=>click(page,'Manage personal authority after compromise');
const openRecovery=page=>click(page,'Set up personal recovery');
const output=page=>label(page,'Guardian message to transfer');
const credential='test-fixture-provider-credential';
const original='Personal rotation fixture soup';
const newer='Private message under the rotated key';

async function start(page){
 await page.goto('./');
 await click(page,'Start cooking');

 
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.goto('./settings');await openHouseholdTools(page);
}
async function savedMessage(page,message){
 await page.goto('./chef');
 await label(page,'Private cooking note').fill(message);
 await label(page,'Save note').click();
 await expect(page.getByText('Saved on this device',{exact:true})).toBeVisible();
}
async function download(page,path,locator){
 const [file]=await Promise.all([page.waitForEvent('download'),locator.click()]);
 await file.saveAs(path);
}
async function pinGuardian(page,bundle,role){
 const owner=role==='owner',prefix=owner?'Guardian':'Holder',holder=prefix.toLowerCase();
 await label(page,prefix+' name').fill(bundle.holder);
 await label(page,prefix+' signing public key').fill(bundle.signingKey);
 await label(page,prefix+' wrapping public key').fill(bundle.wrappingKey);
 await click(page,'Calculate '+holder+' fingerprint');
 const fingerprint=(await page.getByText(/^Fingerprint: /).textContent()).substring('Fingerprint: '.length);
 await label(page,'Confirmed '+holder+' fingerprint').fill(fingerprint);
 await click(page,owner?'Save verified guardian':'Save verified holder');
 await expect(page.getByText(owner?'Guardian key saved.':'Holder key saved.')).toBeVisible();
}
async function verifyOwner(page,authority){
 await label(page,'Owner authority message').fill(JSON.stringify(authority));
 await label(page,'Confirmed owner root pin').fill(authority.pin);
 await click(page,'Verify owner authority');
 await expect(page.getByText('Owner authority verified.')).toBeVisible();
}
async function restorePersonal(page,path,code){
 await label(page,'Recovery code').fill(code);
 await label(page,'Choose encrypted archive file').setInputFiles(path);
 await click(page,'Restore personal archive');
 await expect(page.getByText('Recovered personal archive',{exact:true})).toBeVisible();
}
async function selectTransfer(page,path,pin,parent){
 await label(page,'Choose personal successor file').setInputFiles(path);
 await expect(page.getByText('Personal successor file selected.')).toBeVisible();
 await label(page,'Confirmed personal root pin').fill(pin);
 await label(page,'Confirmed previous personal authority').fill(parent);
}

test('Settings rotates personal authority and the guardian catalog across independent browser contexts',async({browser,baseURL},testInfo)=>{
 test.setTimeout(180000);
 const contexts=[];
 const make=async()=>{const context=await browser.newContext({baseURL});contexts.push(context);return context.newPage()};
 const paths=['old-archive','successor','new-archive','replayed-successor'].map(n=>testInfo.outputPath(n+'.json'));
 const [oldArchive,successor,newArchive,replayedSuccessor]=paths;
 try{
  const owner=await make(),recipient=await make(),excluded=await make(),guardian=await make(),offline=await make();
  let bundle,legacyAuthority,legacyCode,priorEnrollment;
  await test.step('create private data and a v1 guardian archive',async()=>{
   await start(owner);
   // Existing provider credentials remain device-local even while new cloud setup is unavailable.
   await owner.evaluate(value => localStorage.setItem('creative-cooking-openrouter-key', value), credential);
   await owner.reload();
   await openHouseholdTools(owner);
   await openSavedCloudConnections(owner);
   await expect(owner.getByText('Key saved',{exact:true})).toBeVisible();
   await savedMessage(owner,original);
   await start(guardian);
   await openRecovery(guardian);
   await label(guardian,'My guardian name').fill('Ava');
   await click(guardian,'Open my guardian keys');
   await click(guardian,'Export my holder key');
   bundle=JSON.parse(await output(guardian).inputValue());
   await owner.getByLabel('Open settings').last().click();await openHouseholdTools(owner);
   await openSavedCloudConnections(owner);
   await expect(owner.getByText('Key saved',{exact:true})).toBeVisible();
   const encrypted=owner.getByText(/^\d+ encrypted updates? retained for exchange\.$/);
   await expect(encrypted).toBeVisible();
   const previousCount=await encrypted.textContent();
   await label(owner,'City').pressSequentially('Fixturetown');
   await expect(label(owner,'City')).toHaveValue('Fixturetown');
   await expect(encrypted).not.toHaveText(previousCount);
   await openPersonal(owner);
   await click(owner,'Review personal key rotation');
   await expect(owner.getByText(/^Saved copy revision /)).toBeVisible();
   await owner.reload();
   await openHouseholdTools(owner);
   await expect(label(owner,'City')).toHaveValue('Fixturetown');
   await openRecovery(owner);
   await click(owner,'Export owner authority');
   legacyAuthority=JSON.parse(await output(owner).inputValue());
   await pinGuardian(owner,bundle,'owner');
   await label(owner,'Guardian names').fill('Ava');
   await label(owner,'Required guardians').fill('1');
   await click(owner,'Create guardian enrollment');
   await expect(owner.getByText(/^Generation 0: initial/)).toBeVisible();
   priorEnrollment=JSON.parse(await output(owner).inputValue());
   expect(priorEnrollment.manifest.version).toBe(1);
   legacyCode=(await owner.getByText(/^Recovery code \(keep separately from the archive\): /).textContent()).match(/[a-f0-9]{64}$/)[0];
   await download(owner,oldArchive,owner.getByRole('link',{name:'Download encrypted personal archive'}));
   await verifyOwner(guardian,legacyAuthority);
   await pinGuardian(guardian,bundle,'holder');
   await label(guardian,'Guardian enrollment').fill(JSON.stringify(priorEnrollment));
   await click(guardian,'Accept and keep my share');
   await expect(guardian.getByText('Send this signed custody acknowledgement to the owner.')).toBeVisible();
  });
  let requestText,requestFingerprint,pin,parent;
  await test.step('restore the old private copy without writes and verify a separate device request',async()=>{
   await start(recipient);
   await openRecovery(recipient);
   await label(recipient,'My guardian name').fill(bundle.holder);
   await click(recipient,'Open my guardian keys');
   await click(recipient,'Export my holder key');
   const originalGuardian=JSON.parse(await output(recipient).inputValue());
   expect(originalGuardian.wrappingKey).not.toBe(bundle.wrappingKey);
   await pinGuardian(recipient,originalGuardian,'owner');
   await click(recipient,'Close recovery setup');
   await openPersonal(recipient);
   await restorePersonal(recipient,oldArchive,legacyCode);
   await expect(recipient.getByText(original,{exact:true}).last()).toBeVisible();
   await expect(recipient.getByText('city: Fixturetown',{exact:true})).toBeVisible();
   await expect(recipient.getByText(/This archive grants no current personal write authority/)).toBeVisible();
   await expect(label(recipient,'City')).not.toHaveValue('Fixturetown');
   await click(recipient,'Request personal authority for restored archive');
   requestText=await label(recipient,'My personal successor request').inputValue();
   requestFingerprint=(await recipient.getByText(/^Personal request fingerprint /).textContent()).split(' ').at(-1);
   await start(excluded);
   await openPersonal(excluded);
   await restorePersonal(excluded,oldArchive,legacyCode);
   await expect(excluded.getByText(original,{exact:true}).last()).toBeVisible();
  });
  await test.step('publish from the current authority and deny a copied file to the excluded device',async()=>{
   await openPersonal(owner);
   await click(owner,'Review personal key rotation');
   pin=(await owner.getByText(/^Personal root pin /).textContent()).split(' ').at(-1);
   parent=(await owner.getByText(/^Previous personal authority /).textContent()).split(' ').at(-1);
   expect(pin).toBe(legacyAuthority.pin);
   await label(owner,'Personal successor request').fill(requestText);
   await label(owner,'Confirmed personal request fingerprint').fill(requestFingerprint);
   await click(owner,'Include verified personal device');
   const target=JSON.parse(requestText).request.deviceId;
   await expect(owner.getByText(`Verified recipient ${target}`)).toBeVisible();
   await click(owner,'Authorize successor and rotate personal key');
   await expect(owner.getByText(/Personal successor saved/)).toBeVisible();
   await download(owner,successor,button(owner,`Save successor for ${target}`));
   await selectTransfer(excluded,successor,pin,parent);
   await click(excluded,'Install verified personal successor');
   await expect(excluded.getByText('This device has no authorization in that personal transfer.')).toBeVisible();
   await expect(label(excluded,'Personal document generation')).toHaveText('Personal generation 1');
   await click(owner,'Reopen personal workspace');
   await owner.goto('./settings');await openHouseholdTools(owner);
   await expect(label(owner,'Personal document generation')).toHaveText('Personal generation 2');
   await expect(label(owner,'City')).toHaveValue('Fixturetown');
   await openPersonal(owner);
   await click(owner,'Load latest personal successor files');
   await download(owner,replayedSuccessor,button(owner,`Save successor for ${target}`));
   expect(await readFile(replayedSuccessor)).toEqual(await readFile(successor));
  });
  await test.step('install on the authorized device, reopen and save under the new epoch',async()=>{
   await selectTransfer(recipient,successor,pin,'0'.repeat(64));
   await click(recipient,'Install verified personal successor');
   await expect(recipient.getByText('Confirm the personal root and previous authority with the surviving device.')).toBeVisible();
   await label(recipient,'Confirmed previous personal authority').fill(parent);
   await click(recipient,'Install verified personal successor');
   await expect(recipient.getByText(/Personal successor saved/)).toBeVisible();
   await click(recipient,'Reopen personal workspace');
   await recipient.goto('./settings');await openHouseholdTools(recipient);
   await expect(label(recipient,'Personal document generation')).toHaveText('Personal generation 2');
   await expect(label(recipient,'City')).toHaveValue('Fixturetown');
   await openSavedCloudConnections(recipient);
   await expect(recipient.getByText('No key saved',{exact:true})).toBeVisible();
   await openRecovery(recipient);
   await label(recipient,'Guardian names').fill(bundle.holder);
   await label(recipient,'Required guardians').fill('1');
   await click(recipient,'Create guardian enrollment');
   await expect(recipient.getByText('Verify and save each guardian’s key for this personal workspace.',{exact:true})).toBeVisible();
   await pinGuardian(recipient,bundle,'owner');
   await click(recipient,'Create guardian enrollment');
   await expect(recipient.getByText(/^Generation 0: initial/)).toBeVisible();
   const selectedEnrollment=JSON.parse(await label(recipient,'Owner guardian enrollment').inputValue());
   expect(selectedEnrollment.manifest.authorityPin).toBe(pin);
   expect(selectedEnrollment.manifest.roster[0]).toMatchObject({
    holder:bundle.holder,signingKey:bundle.signingKey,wrappingKey:bundle.wrappingKey
   });
   await savedMessage(recipient,newer);
   await recipient.reload();
   await expect(recipient.getByText(newer,{exact:true}).last()).toBeVisible();
   await savedMessage(owner,newer);
   await owner.reload();
   await expect(owner.getByText(newer,{exact:true}).last()).toBeVisible();
  });
  let rotated,code;
  await test.step('reissue a guardian share for the verified new epoch and retain the historical share',async()=>{
   await owner.goto('./settings');await openHouseholdTools(owner);
   await openRecovery(owner);
   await click(owner,'Export owner authority');
   const authority=JSON.parse(await output(owner).inputValue());
   expect(authority.state.version).toBe(3);
   const rotation=authority.state.events.at(-1).rotation;
   await label(owner,'Guardian names').fill('Ava');
   await label(owner,'Required guardians').fill('1');
   await click(owner,'Create guardian enrollment');
   await expect(owner.getByText(/^Generation 1: affected-personal-key-rotated/)).toBeVisible();
   rotated=JSON.parse(await output(owner).inputValue());
   expect(rotated.manifest.epochId).toBe(rotation.epochId);
   expect(rotated.catalog.keyRefs).toEqual([rotation.epochId]);
   expect(rotated.catalog.keyRefs).not.toEqual(priorEnrollment.catalog.keyRefs);
   expect(rotated.catalog.previousCatalogHash).toBe(priorEnrollment.manifest.catalogHash);
   code=(await owner.getByText(/^Recovery code \(keep separately from the archive\): /).textContent()).match(/[a-f0-9]{64}$/)[0];
   expect(code).not.toBe(legacyCode);
   await download(owner,newArchive,owner.getByRole('link',{name:'Download encrypted personal archive'}));
   await verifyOwner(guardian,authority);
   await label(guardian,'Guardian enrollment').fill(JSON.stringify(rotated));
   await click(guardian,'Accept and keep my share');
   await expect(guardian.getByText('Send this signed custody acknowledgement to the owner.')).toBeVisible();
   await label(owner,'Guardian acknowledgement').fill(await output(guardian).inputValue());
   await click(owner,'Record guardian acknowledgement');
   await expect(owner.getByText(/1 confirmed, 0 pending; threshold 1. affected-personal-key-rotated/)).toBeVisible();
   await label(guardian,'Recovery owner').fill(authority.owner);
   for(const generation of ['1','0']){
    await label(guardian,'Recovery generation').fill(generation);
    await click(guardian,'Return my contribution');
    await expect(guardian.getByText('Send the signed contribution to the person restoring.')).toBeVisible();
   }
  });
  await test.step('restore the new private archive offline through the chooser',async()=>{
   // Run the archive parser under Node's native type stripping. Playwright's
   // transformer treats the app's type-only files as CommonJS.
   const inspection=execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`
    import {readFileSync} from 'node:fs';
    import sodium from 'libsodium-wrappers';
    import {openRecoveryArchive} from './src/loro/app/recovery-archive.mjs';
    const {path,code,credential}=JSON.parse(readFileSync(0,'utf8'));
    await sodium.ready;
    const archive=JSON.parse(readFileSync(path,'utf8'));
    const {body}=await openRecoveryArchive(sodium,archive,code);
    process.stdout.write(JSON.stringify({catalog:body.catalog,objects:body.objects.length,
      excluded:!JSON.stringify(body).includes(credential)&&!Buffer.from(body.snapshot.bytes,'hex').includes(credential)}));
   `],{input:JSON.stringify({path:newArchive,code,credential}),encoding:'utf8',stdio:['pipe','pipe','inherit']});
   const opened=JSON.parse(inspection);
   expect(opened.catalog).toEqual(rotated.catalog);
   expect(opened.objects).toBeGreaterThan(0);
   expect(opened.excluded).toBe(true);
   await start(offline);
   await offline.evaluate(async()=>{
    await navigator.serviceWorker.ready;
    localStorage.removeItem('creative-cooking-storage-choice-v1');
   });
   await offline.goto('./');
   await expect(offline.getByText('Welcome to Creative Cooking',{exact:true})).toBeVisible();
   await offline.context().setOffline(true);
   await offline.reload();
   await expect(offline.getByText('Welcome to Creative Cooking',{exact:true})).toBeVisible();
   await click(offline,'Recover an existing kitchen');
   await restorePersonal(offline,newArchive,code);
   await expect(offline.getByText('Private data copy available to read.')).toBeVisible();
   await expect(offline.getByText('city: Fixturetown',{exact:true})).toBeVisible();
   await expect(offline.getByText(original,{exact:true}).last()).toBeVisible();
   await expect(offline.getByText(newer,{exact:true}).last()).toBeVisible();
  });
 }finally{
  await Promise.all(contexts.map(context=>context.close()));
  await Promise.all(paths.map(path=>unlink(path).catch(()=>{})));
 }
});
