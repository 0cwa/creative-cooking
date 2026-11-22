import {openHouseholdTools} from './settings-navigation.mjs';
import {test,expect} from './browser-fixture.mjs';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

function fixtureDigest(kind,value) {
 return execFileSync(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types','--input-type=module','-e',`
  import sodium from 'libsodium-wrappers';
  import {readFileSync} from 'node:fs';
  import {domain} from ${JSON.stringify(new URL('../src/loro/authority/validator.mjs',import.meta.url).href)};
  import {ceremonyBytes} from ${JSON.stringify(new URL('../src/loro/pairing/candidate-v2.mjs',import.meta.url).href)};
  const [kind,input]=JSON.parse(readFileSync(0,'utf8'),(_key,value)=>value?.__bytes?Uint8Array.from(value.__bytes):value);
  await sodium.ready;
  const bytes=kind==='ceremony'?ceremonyBytes(input.transcript,input.guard):domain('projection-source-snapshot',input);
  process.stdout.write(sodium.to_hex(sodium.crypto_generichash(32,bytes)));
 `],{input:JSON.stringify([kind,value]),encoding:'utf8'});
}
for(const adultRemoval of [false,true]){
const decision=adultRemoval?'adult removal':'device revocation';
test(`three enrolled devices preserve and explicitly reopen household admissions and ${decision}`,async({browser,baseURL})=>{
 test.setTimeout(240000);const aCtx=await browser.newContext({baseURL,acceptDownloads:true}),bCtx=await browser.newContext({baseURL,acceptDownloads:true}),cCtx=await browser.newContext({baseURL,acceptDownloads:true});const a=await aCtx.newPage(),b=await bCtx.newPage(),c=await cCtx.newPage(),errors=[];a.setDefaultTimeout(12000);b.setDefaultTimeout(12000);for(const p of [a,b,c]){p.on('pageerror',e=>errors.push(String(e)));p.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text())});p.on('requestfailed',r=>console.error('REQUEST',r.url(),r.failure()))}try{
 const setup=async p=>{await p.goto('./');await p.getByRole('button',{name:'Set up my kitchen'}).click().catch(async e=>{console.error('SETUP PAGE',p.url(),(await p.locator('body').innerText()).slice(0,2500),errors);throw e});await p.getByRole('button',{name:'Accept settings and open my kitchen'}).click();await expect(p.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally')};
 await setup(a);await setup(b);await setup(c);await addPantry(b,'Original household bay leaf');await addPantry(c,'Newcomer local basil');await c.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(c);await c.getByRole('button',{name:'Show device identity'}).click();const thirdIdentity=await c.getByLabel('Public device identity',{exact:true}).textContent();await a.getByLabel('Ingredient and details').fill('Invitation proof onion');await a.getByLabel('Add ingredient').click();await expect(a.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await a.goto('./shopping');
 await a.getByLabel('New shopping list name').fill('Revocation market');
 await a.getByRole('button',{name:'Create shopping list',exact:true}).click();
 await a.getByLabel('Shopping item name').fill('Rotation carrots');
 await a.getByLabel('Shopping quantity').fill('2.5');
 await a.getByLabel('Shopping unit').fill('kg');
 await a.getByRole('button',{name:'Add',exact:true}).click();
 await expect(a.getByText('2.5 kg',{exact:true})).toBeVisible();
 await expect(a.getByTestId('shopping-local-persistence-status')).toHaveText('Saved on this device only.');
 await a.goto('./');
 for(const p of [a,b]){await p.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(p);await p.getByRole('button',{name:'Show device identity'}).click();await p.getByRole('button',{name:'Invite or join a household'}).click()}
 const identity=await b.getByLabel('Public device identity',{exact:true}).textContent();await a.getByLabel('Recipient public identity').fill(identity);await a.getByRole('button',{name:'Prepare current-cooking invitation'}).click();await expect(a.getByLabel('Public invitation message',{exact:true})).toBeVisible();const offer=await a.getByLabel('Public invitation message',{exact:true}).textContent(),code=await a.getByLabel('Invitation verification code').textContent();expect(offer).not.toContain('Invitation proof onion');
 await a.getByRole('button',{name:'Show public household authority'}).click();const authority=await a.getByLabel('Public household authority',{exact:true}).textContent(),root=await a.getByLabel('Household root to compare').textContent(),head=await a.getByLabel('Household head to compare').textContent();await b.getByLabel('Household authority bundle').fill(authority);await b.getByLabel('Confirmed household root').fill(root);await b.getByLabel('Confirmed household head').fill(head);await b.getByRole('button',{name:'Verify and accept public authority'}).click();await expect(b.getByText('Public authority accepted. No access or keys have been granted.')).toBeVisible();await b.getByRole('button',{name:'Join invitation'}).click();await b.getByLabel('Public invitation message input').fill(offer);await b.getByLabel('Confirmed invitation code').fill('0'.repeat(64));await b.getByRole('button',{name:'Start or resume device verification'}).click();await expect(b.locator('[role=alert]').last()).toBeVisible();await b.getByLabel('Confirmed invitation code').fill(code);await b.getByRole('button',{name:'Start or resume device verification'}).click();await a.getByLabel('Confirmed invitation code').fill(code);await a.getByRole('button',{name:'Start or resume device verification'}).click();
 for(let i=0;i<3;i++){const am=await a.getByLabel('Your verification message').textContent(),bm=await b.getByLabel('Your verification message').textContent();await a.getByLabel('Other device verification message').fill(bm);await b.getByLabel('Other device verification message').fill(am);await a.getByRole('button',{name:'Continue device verification'}).click();await b.getByRole('button',{name:'Continue device verification'}).click();const expected=['Exchange your response with the other device.','Exchange your acknowledgement with the other device.','Both devices have completed verification.'][i];for(const p of [a,b])await expect(p.getByText(expected)).toBeVisible().catch(async e=>{console.error('CEREMONY',i,await p.locator('[role=alert]').allTextContents());throw e});if(i===0){await a.reload();await openHouseholdTools(a);await a.getByRole('button',{name:'Invite or join a household'}).click();await a.getByLabel('Recipient public identity').fill(identity);await a.getByRole('button',{name:'Prepare current-cooking invitation'}).click();await expect(a.getByLabel('Public invitation message',{exact:true})).toHaveText(offer);await a.getByLabel('Confirmed invitation code').fill(code);await a.getByRole('button',{name:'Start or resume device verification'}).click();await expect(a.getByText('Exchange your response with the other device.')).toBeVisible()}}
 await expect(a.getByText('Both devices have completed verification.')).toBeVisible();await expect(b.getByText('Both devices have completed verification.')).toBeVisible();const different=JSON.parse(offer);different.scope.id=crypto.randomUUID();await b.getByLabel('Public invitation message input').fill(JSON.stringify(different));await expect(b.getByRole('button',{name:'Choose encrypted household file'})).toHaveCount(0);await b.getByLabel('Confirmed invitation code').fill('0'.repeat(64));await b.getByRole('button',{name:'Start or resume device verification'}).click();await expect(b.getByRole('button',{name:'Choose encrypted household file'})).toHaveCount(0);await b.getByLabel('Public invitation message input').fill(offer);await b.getByLabel('Confirmed invitation code').fill(code);await b.getByRole('button',{name:'Start or resume device verification'}).click();await expect(b.getByText('Both devices have completed verification.')).toBeVisible();const pending=a.waitForEvent('download');await a.getByRole('button',{name:'Admit and download encrypted household file'}).click();const download=await pending.catch(async e=>{console.error('PUBLISH',await a.locator('[role=alert]').allTextContents());throw e}),bytes=await readFile(await download.path());expect(bytes.includes(Buffer.from('Invitation proof onion'))).toBe(false);await a.reload();await openHouseholdTools(a);await a.getByRole('button',{name:'Invite or join a household'}).click();await a.getByLabel('Previously prepared invitation message').fill(offer);const retryDownload=a.waitForEvent('download');await a.getByRole('button',{name:'Download an already admitted household file'}).click();expect(await readFile(await (await retryDownload).path())).toEqual(bytes);const chooserPromise=b.waitForEvent('filechooser');await b.getByRole('button',{name:'Choose encrypted household file'}).click();const chooser=await chooserPromise;await chooser.setFiles({name:'household.bin',mimeType:'application/octet-stream',buffer:bytes});await expect(b.getByText(/Household installed/)).toBeVisible();await expect(b.getByRole('button',{name:'Open this shared household'})).toBeVisible();await b.getByRole('button',{name:'Open this shared household'}).click();await expect(b.getByText('Invitation proof onion',{exact:true})).toBeVisible();await b.getByLabel('Ingredient and details').fill('Invitation proof mint');await b.getByLabel('Add ingredient').click();await expect(b.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await b.reload();await expect(b.getByText('Invitation proof mint',{exact:true})).toBeVisible();await b.getByLabel('Remove Invitation proof mint').click();await expect(b.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await b.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(b);await b.getByRole('button',{name:'Exchange encrypted cooking files'}).click();const outbound=b.getByRole('button',{name:/Download encrypted update /});await expect(outbound).toHaveCount(2);const files=[];for(let i=0;i<2;i++){const transfer=b.waitForEvent('download');await outbound.nth(i).click();files.push(await readFile(await (await transfer).path()))}const dependencies=file=>JSON.parse(file.toString()).header.sourceEffectIds.length,update=files.find(x=>dependencies(x)===0),dependent=files.find(x=>dependencies(x)>0);expect(update).toBeTruthy();expect(dependent).toBeTruthy();expect(update.includes(Buffer.from('Invitation proof mint'))).toBe(false);await a.getByRole('button',{name:'Exchange encrypted cooking files'}).click();const badFile=Buffer.from(update);badFile[badFile.length-2]^=1;const badUpload=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();await (await badUpload).setFiles({name:'damaged.bin',mimeType:'application/octet-stream',buffer:badFile});await expect(a.getByText(/Update not applied:/)).toBeVisible();await a.getByRole('button',{name:'Refresh retained cooking updates'}).click();await expect(a.getByText(/Retained update awaiting application/)).toHaveCount(0);await a.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(typeof key==='string'&&key.startsWith('[\"inbox\",')){IDBObjectStore.prototype.put=put;throw Error('injected staging failure')}return put.call(this,value,key)}});const fault=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();await (await fault).setFiles({name:'fault.bin',mimeType:'application/octet-stream',buffer:update});await expect(a.getByText(/Update not applied:/)).toBeVisible();await a.getByRole('button',{name:'Refresh retained cooking updates'}).click();await expect(a.getByText(/Retained update awaiting application/)).toHaveCount(0);const early=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();await (await early).setFiles({name:'dependent.bin',mimeType:'application/octet-stream',buffer:dependent});await expect(a.getByText(/MISSING_DEPENDENCY/)).toBeVisible();await a.getByRole('button',{name:'Refresh retained cooking updates'}).click();await expect(a.getByText(/Retained update awaiting application/)).toBeVisible();const upload=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();const applied=a.waitForEvent('load',{timeout:15000});await (await upload).setFiles({name:'update.bin',mimeType:'application/octet-stream',buffer:update});await applied;await a.goto('./');await expect(a.getByText('Invitation proof mint',{exact:true})).toBeVisible();await a.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(a);await a.getByRole('button',{name:'Exchange encrypted cooking files'}).click();const retry=a.getByRole('button',{name:/Retry retained update /});await expect(retry).toHaveCount(1);const retried=a.waitForEvent('load');await retry.click();await retried;await a.goto('./');await expect(a.getByText('Invitation proof mint',{exact:true})).toHaveCount(0);await a.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(a);await a.getByRole('button',{name:'Exchange encrypted cooking files'}).click();const duplicate=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();await (await duplicate).setFiles({name:'dependent-again.bin',mimeType:'application/octet-stream',buffer:dependent});await expect(a.getByText('This exact update was already applied. No new changes were made.',{exact:true})).toBeVisible();await a.goto('./');await expect(a.getByText('Invitation proof mint',{exact:true})).toHaveCount(0);await a.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(a);await a.getByRole('button',{name:'Review an adult invitation'}).click();await a.getByLabel('New invitee public identity').fill(thirdIdentity);await a.getByRole('button',{name:'Create public invitation proposal'}).click();const proposalText=await a.getByLabel('Invitation proposal',{exact:true}).textContent();await b.getByRole('button',{name:'Review an adult invitation'}).click();await b.getByLabel('Invitation proposal input').fill(proposalText);await b.getByRole('button',{name:'Review invitation proposal'}).click();await expect(b.getByText('Approvals: 1 of 1 required from 2 adults.')).toBeVisible();await b.getByRole('button',{name:'Approve reviewed invitation'}).click();const approvalText=await b.getByLabel('Signed invitation approval').textContent();await a.getByLabel('Invitation proposal input').fill(proposalText);await a.getByLabel('Invitation approval input').fill(approvalText);await a.getByRole('button',{name:'Verify and collect approval'}).click();await expect(a.getByText('Verified 2 of 1 required adult approvals. Further admission and device verification are still required.')).toBeVisible();await a.getByRole('button',{name:'Agree to share current cooking'}).click();await b.getByRole('button',{name:'Agree to share current cooking'}).click();await a.getByRole('button',{name:'Sign current-cooking agreement'}).click();await b.getByRole('button',{name:'Sign current-cooking agreement'}).click();const signedA=JSON.parse(await a.getByLabel('Signed current-cooking agreement',{exact:true}).textContent()),signedB=JSON.parse(await b.getByLabel('Signed current-cooking agreement',{exact:true}).textContent());await a.getByLabel('Signed current-cooking agreement input').fill(JSON.stringify(signedA));await a.getByRole('button',{name:'Add signed agreement'}).click();await a.getByRole('button',{name:'Verify and retain all agreements'}).click();await expect(a.getByText('INVALID_INPUT',{exact:true})).toBeVisible();await a.getByLabel('Signed current-cooking agreement input').fill(JSON.stringify(signedB));await a.getByRole('button',{name:'Add signed agreement'}).click();await a.getByRole('button',{name:'Verify and retain all agreements'}).click();await expect(a.getByText('All required signatures were verified and the current-cooking sharing agreement was retained. Admission and device key exchange are still required.')).toBeVisible();for(const entry of [signedB,signedA]){await b.getByLabel('Signed current-cooking agreement input').fill(JSON.stringify(entry));await b.getByRole('button',{name:'Add signed agreement'}).click()}await b.getByRole('button',{name:'Verify and retain all agreements'}).click();await expect(b.getByText('All required signatures were verified and the current-cooking sharing agreement was retained. Admission and device key exchange are still required.')).toBeVisible();await a.getByRole('button',{name:'Review current-cooking grant'}).click();await a.getByLabel('Approved invitation for grant').fill(proposalText);await a.getByRole('button',{name:'Prepare current-cooking grant'}).click();const grantText=await a.getByLabel('Prepared cooking grant',{exact:true}).textContent();await b.getByRole('button',{name:'Review current-cooking grant'}).click();await b.getByLabel('Cooking grant to review').fill(grantText);await b.getByRole('button',{name:'Inspect proposed cooking grant'}).click();await expect(b.getByLabel('Proposed current cooking')).toContainText('Invitation proof onion');await b.getByRole('button',{name:'Sign reviewed cooking grant'}).click();const grantApproval=await b.getByLabel('Signed cooking grant approval').textContent();await a.getByLabel('Cooking grant to review').fill(grantText);await a.getByLabel('Cooking grant approval input').fill(grantApproval);await a.getByRole('button',{name:'Verify and collect grant approval'}).click();await expect(a.getByText('Verified 2 of 1 required adult signatures. Admission still requires device verification.')).toBeVisible();const collectedText=await a.getByLabel('Cooking grant with collected approvals').textContent();await a.getByRole('button',{name:'Verify an existing device'}).click();await b.getByRole('button',{name:'Verify an existing device'}).click();await a.getByLabel('Collected grant for existing device').fill(collectedText);const staleIdentity={...JSON.parse(identity),wrappingKey:'0'.repeat(64)};
 await a.getByLabel('Existing device public identity').fill(JSON.stringify(staleIdentity));
 await a.getByRole('button',{name:'Prepare existing-device verification'}).click();
 const staleOffer=await a.getByLabel('Existing-device verification message',{exact:true}).textContent();
 await a.getByLabel('Existing device public identity').fill(identity);await a.getByRole('button',{name:'Prepare existing-device verification'}).click();const existingOffer=await a.getByLabel('Existing-device verification message',{exact:true}).textContent(),existingCode=await a.getByLabel('Existing-device verification code').textContent();expect(existingOffer).not.toBe(staleOffer);
 await a.getByLabel('Confirmed existing-device code').fill('0'.repeat(64));
 await a.getByRole('button',{name:'Start existing-device verification'}).click();
 await expect(a.getByText('Verification code does not match.')).toBeVisible();
 await expect(a.getByLabel('Existing-device verification message',{exact:true})).toHaveText(existingOffer);
 await b.getByRole('button',{name:'Verify this existing device'}).click();await b.getByLabel('Existing-device verification message input').fill(existingOffer);await b.getByLabel('Confirmed existing-device code').fill('0'.repeat(64));await b.getByRole('button',{name:'Start existing-device verification'}).click();await expect(b.getByText('CONFIRMATION_REQUIRED',{exact:true})).toBeVisible();await expect(b.getByLabel('Existing-device outgoing message')).toHaveCount(0);await b.getByLabel('Confirmed existing-device code').fill(existingCode);await b.getByRole('button',{name:'Start existing-device verification'}).click();await a.getByLabel('Confirmed existing-device code').fill(existingCode);await a.getByRole('button',{name:'Start existing-device verification'}).click();for(let i=0;i<3;i++){const am=await a.getByLabel('Existing-device outgoing message').textContent(),bm=await b.getByLabel('Existing-device outgoing message').textContent();await a.getByLabel('Other existing-device message').fill(bm);await b.getByLabel('Other existing-device message').fill(am);await a.getByRole('button',{name:'Continue existing-device verification'}).click();if(i===2){await expect(a.getByText('Existing-device verification complete.')).toBeVisible()}else{await b.getByRole('button',{name:'Continue existing-device verification'}).click();const expected=i===0?'Exchange the response with the other device.':'Exchange the ack with the other device.';for(const p of [a,b])await expect(p.getByText(expected)).toBeVisible()}}await a.getByRole('button',{name:'Show existing-device evidence'}).click();await expect(a.getByText('Device verification evidence is ready. The new household key has not been installed yet.')).toBeVisible();
 const organizerAck=await a.getByLabel('Existing-device outgoing message').textContent();
 const existingEvidence=await a.getByLabel('Existing-device evidence',{exact:true}).textContent();
 const existingId=JSON.parse(identity).deviceId,thirdId=JSON.parse(thirdIdentity).deviceId;
 await a.getByRole('button',{name:'Invite or join a household'}).click();
 await a.getByLabel('Collected grant for invitation').fill(collectedText);
 await a.getByRole('button',{name:'Prepare invitation from collected grant'}).click();
 const laterOffer=await a.getByLabel('Public invitation message',{exact:true}).textContent();
 const laterCode=await a.getByLabel('Invitation verification code').textContent();
 expect(laterOffer).not.toContain('Invitation proof onion');
 await a.getByRole('button',{name:'Show device identity'}).click();
 await a.getByRole('button',{name:'Show public household authority'}).click();
 const laterParent=JSON.parse(await a.getByLabel('Public household authority',{exact:true}).textContent());
 await c.getByLabel('Household authority bundle').fill(JSON.stringify(laterParent));
 await c.getByLabel('Confirmed household root').fill(laterParent.rootPin);
 await c.getByLabel('Confirmed household head').fill(laterParent.selectedHead);
 await c.getByRole('button',{name:'Verify and accept public authority'}).click();
 await expect(c.getByText('Public authority accepted. No access or keys have been granted.')).toBeVisible();
 await c.getByRole('button',{name:'Invite or join a household'}).click();
 await c.getByRole('button',{name:'Join invitation'}).click();
 await c.getByLabel('Public invitation message input').fill(laterOffer);
 for(const p of [a,c]){
  await p.getByLabel('Confirmed invitation code').fill(laterCode);
  await p.getByRole('button',{name:'Start or resume device verification'}).click();
 }
 for(const expected of ['Exchange your response with the other device.','Exchange your acknowledgement with the other device.','Both devices have completed verification.']){
  const [left,right]=await Promise.all([a,c].map(p=>p.getByLabel('Your verification message').textContent()));
  for(const [p,message] of [[a,right],[c,left]]){
   await p.getByLabel('Other device verification message').fill(message);
   await p.getByRole('button',{name:'Continue device verification'}).click();
  }
  for(const p of [a,c])await expect(p.getByText(expected)).toBeVisible();
 }

 const {scope,selectedHead:oldHead}=laterParent,oldDocument=laterParent.state.events.at(-1).event.subject.documentId;
 const beforePublish=await readRetained(a,scope.id,oldDocument,oldHead);
 const sourceDigest=fixtureDigest('snapshot',Buffer.from(beforePublish.document.bytes).toString('hex'));
 expect(JSON.parse(collectedText).prepared.manifest.sourceCheckpointHash).toBe(sourceDigest);
 await a.getByRole('button',{name:'Publish verified household generation'}).click();
 await expect(a.getByText('Collect completed verification evidence for every existing device.')).toBeVisible();
 expect(await readRetained(a,scope.id,oldDocument,oldHead)).toEqual(beforePublish);
 const unrelated=JSON.parse(existingEvidence);
 unrelated.context.admissionEventHash='0'.repeat(64);
 await a.getByLabel('Completed existing-device evidence').fill(JSON.stringify(unrelated));
 await a.getByRole('button',{name:'Collect existing-device evidence'}).click();
 await expect(a.getByText('The device evidence belongs to a different invitation or household.')).toBeVisible();
 await a.getByLabel('Completed existing-device evidence').fill(existingEvidence);
 await a.getByRole('button',{name:'Collect existing-device evidence'}).click();
 await expect(a.getByText(`${existingId} · Verified`)).toBeVisible();
 const publicationLock=await a.evaluate(async()=>{
  const name=localStorage.getItem('creative-cooking-local-workspace-v1');
  const lock=`creative-cooking/bootstrap/v1/${name}`;
  await new Promise(resolve=>{
   void navigator.locks.request(lock,()=>new Promise(release=>{
    window.releaseAdmissionTestLock=release;
    resolve();
   }));
  });
  return lock;
 });
 try {
  await a.getByRole('button',{name:'Publish verified household generation'}).click();
  await expect.poll(()=>a.evaluate(async name=>(await navigator.locks.query()).pending.some(lock=>lock.name===name),publicationLock)).toBe(true);
  await expect(a.getByRole('button',{name:'Open existing workspace',exact:true})).toHaveCount(0);
  expect(await a.evaluate(()=>localStorage.getItem('creative-cooking-storage-choice-v1'))).toMatch(/^local:/);
 } finally {
  await a.evaluate(()=>window.releaseAdmissionTestLock?.());
 }
 await expect(a.getByText('Household generation 3 was published. Share each encrypted file with its named device.')).toBeVisible().catch(async error=>{
  console.error('SECOND PUBLICATION',await a.locator('[role=alert]').allTextContents());
  throw error;
 });
 await expect(a.getByLabel('Household document generation')).toHaveText('Household generation 2');
 const published=await readRetained(a,scope.id,oldDocument,oldHead);
 expect(published.head).not.toBe(oldHead);
 expect(published.document).toEqual(beforePublish.document);
 await a.getByRole('button',{name:'Publish verified household generation'}).click();
 await expect(a.getByText('Household generation 3 was already published. Share each encrypted file with its named device.')).toBeVisible();
 expect(await readRetained(a,scope.id,oldDocument,oldHead)).toEqual(published);
 await a.getByRole('button',{name:'Back',exact:true}).click();
 await a.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(a);
 await a.getByRole('button',{name:'Invite or join a household'}).click();
 await expect(a.getByRole('button',{name:'Reopen household after admission'})).toBeVisible();
 const newcomerLabel=`Download encrypted file for new device ${thirdId}`;
 const existingLabel=`Download encrypted file for existing device ${existingId}`;
 const newcomerFile=await downloadFile(a,newcomerLabel),existingFile=await downloadFile(a,existingLabel);
 expect(newcomerFile).not.toEqual(existingFile);
 for(const file of [newcomerFile,existingFile])expect(file.includes(Buffer.from('Invitation proof onion'))).toBe(false);
 await a.getByRole('button',{name:'Reopen household after admission'}).click();
 await expect(a.getByText('Invitation proof onion',{exact:true})).toBeVisible();
 await a.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(a);
 await expect(a.getByLabel('Household document generation')).toHaveText('Household generation 3');
 await a.getByRole('button',{name:'Invite or join a household'}).click();
 expect(await downloadFile(a,newcomerLabel)).toEqual(newcomerFile);
 expect(await downloadFile(a,existingLabel)).toEqual(existingFile);

 await b.goto('./');
 await expect(b.getByText('Invitation proof onion',{exact:true})).toBeVisible();
 await addPantry(b,'Old generation rosemary');
 await b.reload();
 await expect(b.getByText('Old generation rosemary',{exact:true})).toBeVisible();
 await b.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(b);
 const oldMember=await readRetained(b,scope.id,oldDocument,oldHead);
 expect(oldMember.head).toBe(oldHead);
 expect(oldMember.enrollment).toBeTruthy();
 expect(oldMember.counter).toBeGreaterThan(0);
 expect(oldMember.outbound.length).toBeGreaterThan(0);
 await expect(b.getByLabel('Household document generation')).toHaveText('Household generation 2');
 await b.getByRole('button',{name:'Verify an existing device'}).click();
 await b.getByRole('button',{name:'Verify this existing device'}).click();
 const existingAction='Install and open household generation';
 await uploadFile(b,existingAction,newcomerFile);
 await expect(b.getByText('INVALID_FILE',{exact:true})).toBeVisible();
 expect(await readRetained(b,scope.id,oldDocument,oldHead)).toEqual(oldMember);
 await uploadFile(b,existingAction,existingFile);
 await expect(b.getByText('INCOMPLETE',{exact:true})).toBeVisible();
 expect(await readRetained(b,scope.id,oldDocument,oldHead)).toEqual(oldMember);
 await b.getByLabel('Existing-device verification message input').fill(existingOffer);
 await b.getByLabel('Confirmed existing-device code').fill(existingCode);
 await b.getByRole('button',{name:'Start existing-device verification'}).click();
 await expect(b.getByText('Exchange the ack with the other device.')).toBeVisible();
 await b.getByLabel('Other existing-device message').fill(organizerAck);
 await b.getByRole('button',{name:'Continue existing-device verification'}).click();
 await expect(b.getByText('Existing-device verification complete.')).toBeVisible();

 await uploadFile(c,'Choose encrypted household file',existingFile);
 await expect(c.getByText('INVALID_FILE',{exact:true})).toBeVisible();
 await expect(c.getByRole('button',{name:'Open this shared household'})).toHaveCount(0);

 const parentReceiptIndex=JSON.stringify(['recipient-admission-event',scope.id,oldHead]);
 const savedParentReceiptIndex=await changeWorkspaceRecord(b,parentReceiptIndex);
 expect(typeof savedParentReceiptIndex).toBe('string');
 try {
  await uploadFile(b,existingAction,existingFile);
  await expect(b.getByText('INVALID_AUTHORITY',{exact:true})).toBeVisible();
  expect(await readRetained(b,scope.id,oldDocument,oldHead)).toEqual(oldMember);
 } finally {
  await changeWorkspaceRecord(b,parentReceiptIndex,savedParentReceiptIndex);
 }

 await b.evaluate(()=>{
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,key){
   if(typeof key==='string'&&key.startsWith('["recipient-admission",')&&key.includes('"receive-generation-')){
    IDBObjectStore.prototype.put=put;
    throw Error('injected recipient transaction failure');
   }
   return put.call(this,value,key);
  };
 });
 await uploadFile(b,existingAction,existingFile);
 await expect(b.getByText('IO',{exact:true})).toBeVisible();
 expect(await readRetained(b,scope.id,oldDocument,oldHead)).toEqual(oldMember);
 await expect(b.getByLabel('Household document generation')).toHaveText('Household generation 2');
 await uploadFile(b,existingAction,existingFile);
 await expect(b.getByText('Invitation proof onion',{exact:true})).toBeVisible();
 await expect(b.getByText('Old generation rosemary',{exact:true})).toHaveCount(0);
 const advancedMember=await readRetained(b,scope.id,oldDocument,oldHead);
 expect(advancedMember).toMatchObject({head:published.head,document:oldMember.document,enrollment:oldMember.enrollment,counter:oldMember.counter,receipts:oldMember.receipts+1});
 expect(advancedMember.outbound).toEqual(oldMember.outbound);
 await addPantry(b,'New generation dill');
 const nextMember=await readRetained(b,scope.id,oldDocument,oldHead);
 expect(nextMember.counter).toBe(oldMember.counter+1);
 await b.reload();
 await expect(b.getByText('New generation dill',{exact:true})).toBeVisible();
 await b.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(b);
 await expect(b.getByLabel('Household document generation')).toHaveText('Household generation 3');
 await b.getByRole('button',{name:'Verify an existing device'}).click();
 await b.getByRole('button',{name:'Verify this existing device'}).click();
 await uploadFile(b,existingAction,existingFile);
 await expect(b.getByText('Household generation 3 is already open on this device.')).toBeVisible();
 expect(await readRetained(b,scope.id,oldDocument,oldHead)).toEqual(nextMember);
 await b.getByRole('button',{name:'Show device identity'}).click();
 await b.getByRole('button',{name:'Return to original local household'}).click();
 await expect(b.getByText('Original household bay leaf',{exact:true})).toBeVisible();
 await b.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(b);
 await b.getByRole('button',{name:'Show device identity'}).click();
 await b.getByRole('button',{name:'Open this shared household'}).click();
 await expect(b.getByText('New generation dill',{exact:true})).toBeVisible();

 await uploadFile(c,'Choose encrypted household file',newcomerFile);
 await expect(c.getByText(/Household installed/)).toBeVisible();
 await expect(c.getByLabel('Household document generation')).toHaveText('Household generation 1');
 const newcomer=await readRetained(c,scope.id,oldDocument);
 expect(newcomer.head).toBe(published.head);
 expect(newcomer.document).toBeNull();
 expect(newcomer.receipts).toBe(1);
 await c.reload();
 await openHouseholdTools(c);
 await expect(c.getByLabel('Household document generation')).toHaveText('Household generation 1');
 await c.getByRole('button',{name:'Show device identity'}).click();
 await c.getByRole('button',{name:'Invite or join a household'}).click();
 await c.getByRole('button',{name:'Join invitation'}).click();
 const changedOffer=JSON.parse(laterOffer);
 changedOffer.ceremony.transcript.responder.nonce.__bytes[0]^=1;
 const changedCode=fixtureDigest('ceremony',changedOffer.ceremony);
 await c.getByLabel('Public invitation message input').fill(JSON.stringify(changedOffer));
 await c.getByLabel('Confirmed invitation code').fill(changedCode);
 await c.getByRole('button',{name:'Start or resume device verification'}).click();
 await expect(c.getByText('INVALID_AUTHORITY',{exact:true})).toBeVisible();
 await expect(c.getByRole('button',{name:'Choose encrypted household file'})).toHaveCount(0);
 await c.getByLabel('Public invitation message input').fill(laterOffer);
 await c.getByLabel('Confirmed invitation code').fill(laterCode);
 await c.getByRole('button',{name:'Start or resume device verification'}).click();
 await expect(c.getByText('Both devices have completed verification.')).toBeVisible();
 await uploadFile(c,'Choose encrypted household file',newcomerFile);
 await expect(c.getByText(/This household was already installed/)).toBeVisible();
 expect(await readRetained(c,scope.id,oldDocument)).toEqual(newcomer);
 await c.getByRole('button',{name:'Open this shared household'}).click();
 await expect(c.getByText('Invitation proof onion',{exact:true})).toBeVisible();
 await expect(c.getByText('Newcomer local basil',{exact:true})).toHaveCount(0);
 await addPantry(c,'Third device thyme');
 await c.reload();
 await expect(c.getByText('Third device thyme',{exact:true})).toBeVisible();
 await c.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(c);
 await expect(c.getByLabel('Household document generation')).toHaveText('Household generation 3');
 const recoveryKits=adultRemoval?null:await test.step('register two personal continuity generations with current adults',()=>
  registerRecovery(a,b,c));
 await test.step(`approve, publish, install and reopen ${decision} through Settings`,async()=>{
  await routedRevocation({a,b,c,existingId,thirdId,thirdAdult:JSON.parse(thirdIdentity).adultId,scope,publishedHead:published.head,adultRemoval});
 });
 if(recoveryKits){
  const freshContext=await browser.newContext({baseURL,acceptDownloads:true});
  try{await test.step('restore privately, then authorize and install household readmission',()=>
   routedReadmission(a,b,c,freshContext,setup,scope,recoveryKits));}
  finally{await freshContext.close();}
 }
 await c.getByRole('button',{name:'Show device identity'}).click();
 await c.getByRole('button',{name:'Return to original local household'}).click();
 await expect(c.getByText('Newcomer local basil',{exact:true})).toBeVisible();
 const beforeLostCounter=await readRetained(b,scope.id,oldDocument,oldHead);
 if(!adultRemoval){
  const enrollment=beforeLostCounter.enrollment;
  const otherBinding='f'.repeat(64),otherName=`joined-v2-${otherBinding}`;
  await b.evaluate(async({scopeId,otherName,otherBinding,enrollment})=>{
   const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
   const opening=indexedDB.open(`${otherName}-sequences`,1);
   opening.onupgradeneeded=()=>{
    const store=opening.result.createObjectStore('sequences');
    store.put(1,'format');store.put(otherBinding,'binding');store.put(0,JSON.stringify(['counter',scopeId]));
   };
   (await request(opening)).close();
   const db=await request(indexedDB.open(`${localStorage.getItem('creative-cooking-local-workspace-v1')}-joined`));
   try{
    const tx=db.transaction('enrollments','readwrite');
    await new Promise((resolve,reject)=>{
     tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
     tx.objectStore('enrollments').put({...enrollment,sequenceName:otherName},scopeId);
    });
   }finally{db.close();}
  },{scopeId:scope.id,otherName,otherBinding,enrollment});
  await b.reload();
  await b.getByRole('button',{name:'Show technical details',exact:true}).click();
   await expect(b.getByText('ENROLLMENT_CONFLICT',{exact:true})).toBeVisible();
  await b.evaluate(async({scopeId,otherName,enrollment})=>{
   const db=await new Promise((resolve,reject)=>{
    const opening=indexedDB.open(`${localStorage.getItem('creative-cooking-local-workspace-v1')}-joined`);
    opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error);
   });
   try{
    const tx=db.transaction('enrollments','readwrite');
    await new Promise((resolve,reject)=>{
     tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
     tx.objectStore('enrollments').put(enrollment,scopeId);
    });
   }finally{db.close();}
   await new Promise((resolve,reject)=>{
    const deletion=indexedDB.deleteDatabase(`${otherName}-sequences`);
    deletion.onsuccess=resolve;deletion.onerror=()=>reject(deletion.error);
   });
  },{scopeId:scope.id,otherName,enrollment});
  await b.reload();
  await expect(b.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 }
 await b.evaluate(({scopeId,sequenceName})=>new Promise((resolve,reject)=>{
  const opening=indexedDB.open(`${sequenceName}-sequences`);
  opening.onerror=()=>reject(opening.error);
  opening.onsuccess=()=>{
   const db=opening.result,tx=db.transaction('sequences','readwrite');
   tx.objectStore('sequences').delete(JSON.stringify(['counter',scopeId]));
   tx.oncomplete=()=>{db.close();resolve()};
   tx.onabort=()=>{db.close();reject(tx.error)};
  };
 }),{scopeId:scope.id,sequenceName:oldMember.enrollment.sequenceName});
 await b.reload();
 await b.getByRole('button',{name:'Show technical details',exact:true}).click();
  await expect(b.getByText('MISSING_SEQUENCES',{exact:true})).toBeVisible();
 expect(await readRetained(b,scope.id,oldDocument,oldHead)).toEqual({...beforeLostCounter,counter:null});
 expect(errors).toEqual([]);
 }finally{await aCtx.close();await bCtx.close();await cCtx.close()}
});
}

async function addPantry(page,name){
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await page.getByLabel('Ingredient and details').fill(name);
 await page.getByLabel('Add ingredient').click();
 await expect(page.getByText(name,{exact:true})).toBeVisible().catch(async error=>{
  console.error('PANTRY EDIT',name,(await page.locator('body').innerText()).slice(0,1300));
  throw error;
 });
 await expect(page.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
}

async function downloadFile(page,name){
 const pending=page.waitForEvent('download');
 await page.getByRole('button',{name,exact:true}).click();
 return readFile(await (await pending).path());
}

async function uploadFile(page,name,buffer){
 const pending=page.waitForEvent('filechooser');
 await page.getByRole('button',{name,exact:true}).click();
 await (await pending).setFiles({name:'household.bin',mimeType:'application/octet-stream',buffer});
}

function changeWorkspaceRecord(page,slot,replacement){
 return page.evaluate(({slot,replacement})=>new Promise((resolve,reject)=>{
  const name=localStorage.getItem('creative-cooking-local-workspace-v1');
  const opening=indexedDB.open(`${name}-records`);
  opening.onerror=()=>reject(opening.error);
  opening.onsuccess=()=>{
   const db=opening.result,tx=db.transaction('records','readwrite'),store=tx.objectStore('records');
   const read=store.get(slot);
   read.onsuccess=()=>replacement===undefined?store.delete(slot):store.put(replacement,slot);
   tx.oncomplete=()=>{db.close();resolve(read.result)};
   tx.onabort=()=>{db.close();reject(tx.error)};
  };
 }),{slot,replacement});
}

function readRetained(page,scopeId,documentId,branchHead){
 return page.evaluate(async({scopeId,documentId,branchHead})=>{
  const name=localStorage.getItem('creative-cooking-local-workspace-v1');
  const checked=await indexedDB.databases(),req=request=>new Promise((resolve,reject)=>{
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error);
  });
  const read=async(dbName,table,fn)=>{
   if(!checked.some(entry=>entry.name===dbName))return null;
   const db=await req(indexedDB.open(dbName));
   try{return await fn(db.transaction(table,'readonly').objectStore(table))}
   finally{db.close()}
  };
  const key=(...parts)=>JSON.stringify(parts);
  const retained=await read(`${name}-records`,'records',async store=>{
   const keys=await req(store.getAllKeys());
   const authority=await req(store.get(key('pairing-authority','household',scopeId)));
   const document=await req(store.get(key('document',scopeId,documentId)));
   const relevant=kind=>keys.filter(slot=>{
    const parts=JSON.parse(slot);
    return parts[0]===kind&&parts[1]===scopeId;
   });
   const retainedOutbound=await Promise.all(relevant('object').map(async slot=>[slot,await req(store.get(slot))]));
   const outbound=retainedOutbound.filter(([,entry])=>entry.branchHead===branchHead).map(([slot,entry])=>[slot,Array.from(entry.bytes)]);
   return {head:authority?.acceptedParent??null,document:document?{revision:document.revision,bytes:Array.from(document.bytes)}:null,
    receipts:relevant('recipient-admission').length,outbound};
  });
  const enrollment=await read(`${name}-joined`,'enrollments',store=>req(store.get(scopeId)));
  const counter=enrollment?await read(`${enrollment.sequenceName}-sequences`,'sequences',store=>req(store.get(key('counter',scopeId)))):null;
  return {...retained,enrollment:enrollment??null,counter:counter??null};
 },{scopeId,documentId,branchHead});
}

async function routedRevocation({a,b,c,existingId,thirdId,thirdAdult,scope,publishedHead,adultRemoval}){
 const decision=adultRemoval?'adult removal':'revocation';
 const panel=adultRemoval?'adult removal':'device revocation';
 const approve=adultRemoval?'Sign approval for this adult removal':'Sign approval for this revocation and draft';
 const publish=adultRemoval?'Confirm adult removal and publish rotation':'Confirm revocation and publish rotation';
 const button=(page,name)=>page.getByRole('button',{name,exact:true});
 const message=page=>page.getByLabel(`Signed ${decision} message`);
 const open=async page=>{
  await page.goto('./settings');await openHouseholdTools(page);
  await button(page,`Manage ${panel}`).click();
  await expect(page.getByText(/Selected household branch /)).toBeVisible();
 };
 const review=async(page,value)=>{
  await message(page).fill(value);
  await button(page,`Review signed ${decision}`).click();
 };
 const fault=async(page,namespace,includes)=>page.evaluate(({namespace,includes})=>{
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,key){
   const request=put.call(this,value,key);
   if(typeof key==='string'&&key.startsWith(`["${namespace}",`)&&key.includes(includes)){
    IDBObjectStore.prototype.put=put;
    throw Error('injected rotation transaction failure after scheduling the write');
   }
   return request;
  };
 },{namespace,includes});
 const rows=page=>page.evaluate(async scopeId=>{
  const request=op=>new Promise((resolve,reject)=>{op.onsuccess=()=>resolve(op.result);op.onerror=()=>reject(op.error);});
  const name=localStorage.getItem('creative-cooking-local-workspace-v1');
  const db=await request(indexedDB.open(`${name}-records`));
  try{
   const store=db.transaction('records').objectStore('records');
   const keys=(await request(store.getAllKeys())).filter(key=>{
    const [kind,first,second]=JSON.parse(key);
    return first===scopeId||second===scopeId||kind.startsWith('local-key')||kind==='pairing-guard';
   });
   const values=await Promise.all(keys.map(key=>request(store.get(key))));
   return Object.fromEntries(keys.map((key,i)=>[key,JSON.parse(JSON.stringify(values[i]))]));
  }finally{db.close();}
 },scope.id);

 await button(c,'Exchange encrypted cooking files').click();
 const lateButton=c.getByRole('button',{name:/Download encrypted update /});
 await expect(lateButton).toHaveCount(1);
 const lateName=await lateButton.textContent();
 const late=await downloadFile(c,lateName);
 const lateId=lateName.split('Download encrypted update ')[1];

 if(!adultRemoval){
  await a.goto('./settings');await openHouseholdTools(a);
  await button(a,'Review household devices').click();
  await button(a,`Review local quarantine for ${thirdId}`).click();
  await button(a,'Quarantine on this device').click();
  await expect(a.getByText('Device quarantined on this device.')).toBeVisible();
  await button(a,'Open household incident reports').click();
  await button(a,`Prepare report for ${thirdId}`).click();
  await button(a,'Use verified household projection checkpoint').click();
  await button(a,'Sign and freeze incident report').click();
  await expect(a.getByLabel('Frozen incident evidence')).toBeVisible();
  await button(a,'Save clean draft with 0 selected operations').click();
  await expect(a.getByLabel('Saved clean draft')).toContainText('Revocation market');
 }
 await open(a);
 await open(b);
 await button(b,'Create signed recipient binding').click();
 const binding=await b.getByLabel('Signed recipient binding').textContent();
 const wrong=JSON.parse(binding);
 wrong.wrappingKey='0'.repeat(64);
 await a.getByLabel('Remaining device bindings').fill(JSON.stringify(wrong));
 const prepare=adultRemoval?button(a,`Prepare removal of adult ${thirdAdult}`):
  a.getByRole('button',{name:/^Prepare revocation from /});
 if(adultRemoval)await expect(a.getByRole('button',{name:/^Prepare revocation from /})).toHaveCount(0);
 await prepare.click();
 await expect(a.getByText(/binding is invalid/)).toBeVisible();
 await a.getByLabel('Remaining device bindings').fill(binding);
 await prepare.click();
 await expect(a.getByText('0 of 2 required adult approvals.')).toBeVisible();
 let proposal=await message(a).inputValue();
 const parent=JSON.parse(proposal).item.event.parentHead;
 expect(parent).toBe(publishedHead);
 if(adultRemoval){
  const prepared=JSON.parse(proposal);
  expect(prepared.item.event.kind).toBe('removeAdult');
  expect(prepared.manifest.kind).toBe('adult-removal-source');
  expect(prepared.manifest).not.toHaveProperty('reviewId');
  await expect(a.getByText(`Adult to remove ${thirdAdult}`,{exact:true})).toBeVisible();
  await expect(a.getByText(`Excluded devices ${thirdId}`,{exact:true})).toBeVisible();
 }
 await button(a,approve).click();
 await expect(a.getByText('1 of 2 required adult approvals.')).toBeVisible();
 await expect(button(a,publish)).toHaveCount(0);
 await review(b,await message(a).inputValue());
 await button(b,approve).click();
 await expect(b.getByText('2 of 2 required adult approvals.')).toBeVisible();
 proposal=await message(b).inputValue();
 const parsed=JSON.parse(proposal);
 const {documentId,newEpochId}=parsed.item.event.subject;
 expect(parsed.grant.recipients).toContain(existingId);
 expect(parsed.grant.recipients).not.toContain(thirdId);
 expect(parsed.grant.packageRefs).toHaveLength(1);
 const altered=structuredClone(parsed);
 altered.manifest[adultRemoval?'sourceHash':'reportHash']='0'.repeat(64);
 await review(a,JSON.stringify(altered));
 await expect(a.getByText('INVALID_GRANT',{exact:true})).toBeVisible();
 await review(a,proposal);
 await expect(a.getByText('2 of 2 required adult approvals.')).toBeVisible();
 const beforeA=await rows(a), beforeB=await rows(b);
 await fault(a,'projection-publication',parsed.item.event.proposalId);
 await button(a,publish).click();
 await expect(a.getByText('Local storage could not complete the change. You can retry.')).toBeVisible();
 expect(await rows(a)).toEqual(beforeA);
 await a.reload();
 await open(a);
 await review(a,proposal);
 const authoritySlot=JSON.stringify(['pairing-authority','household',scope.id]);
 await a.evaluate(({publication,authoritySlot})=>{
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,key){
   const request=put.call(this,value,key);
   if(typeof key==='string'&&key.startsWith('["projection-publication",')&&key.includes(publication)){
    IDBObjectStore.prototype.put=put;
    this.transaction.addEventListener('complete',()=>{
     const get=IDBObjectStore.prototype.get;
     IDBObjectStore.prototype.get=function(key){
      if(key===authoritySlot){
       IDBObjectStore.prototype.get=get;
       throw Error('injected status failure after committed rotation');
      }
      return get.call(this,key);
     };
    },{once:true});
   }
   return request;
  };
 },{publication:parsed.item.event.proposalId,authoritySlot});
 await button(a,publish).click();
 await expect(a.getByText('Rotation saved. Refresh the selected household branch to continue.',{exact:true})).toBeVisible();
 await expect(a.getByText('Local storage could not complete the change. You can retry.',{exact:true})).toBeVisible();
 const committedRows=await rows(a);
 expect(committedRows[authoritySlot].acceptedParent).toBe(parsed.grant.eventHash);
 await button(a,'Exchange encrypted cooking files').click();
 await expect(button(a,'Choose encrypted cooking update')).toBeDisabled();
 expect(await rows(a)).toEqual(committedRows);
 await button(a,'Refresh selected household branch').click();
 await expect(button(a,'Reopen rotated household')).toBeVisible();
 await expect(a.getByLabel('Household document generation')).toHaveText('Household generation 3');
 const download=`Download rotation for ${existingId}`;
 const file=await downloadFile(a,download);
 expect(file.includes(Buffer.from('Rotation carrots'))).toBe(false);
 await expect(button(a,`Download rotation for ${thirdId}`)).toHaveCount(0);
 const parentAuthority={...beforeA[authoritySlot],authorityState:new Uint8Array(Object.values(beforeA[authoritySlot].authorityState))};
 const rotationAuthority=await changeWorkspaceRecord(a,authoritySlot,parentAuthority);
 try{
  await button(a,'Reopen rotated household').click();
  await expect(a.getByText(`Selected household branch ${parent}`,{exact:true})).toBeVisible();
  await expect(a.getByText('The selected household branch changed. Review the displayed branch before reopening.',{exact:true})).toBeVisible();
  await expect(button(a,'Reopen rotated household')).toHaveCount(0);
  await expect(button(a,`Close ${panel}`)).toBeVisible();
 }finally{
  await changeWorkspaceRecord(a,authoritySlot,rotationAuthority);
 }
 await button(a,`Close ${panel}`).click();
 await button(a,`Manage ${panel}`).click();
 await button(a,'Reopen rotated household').click();
 await expect(a.getByText('Invitation proof onion',{exact:true})).toBeVisible();
 await open(a);
 if(adultRemoval){
  await expect(a.getByText('POLICY_UNRESOLVED',{exact:true})).toBeVisible();
  await expect(button(a,'Review an external cooking request')).toBeDisabled();
 }
 expect(await downloadFile(a,download)).toEqual(file);
 await button(a,`Review retained branch ${parent}`).click();
 await expect(a.getByLabel('Retained branch cooking')).toContainText('Revocation market');
 if(!adultRemoval){
  await button(a,`Review archived incident ${parsed.manifest.reviewId}`).click();
  await expect(a.getByLabel('Archived signed incident')).toContainText('Original checkpoint verified.');
 }
 const advancedA=await rows(a);
 const oldRows=Object.entries(beforeA).filter(([key])=>['document','document-owner','object','compromise-review','compromise-frozen-original',
  'disclosure-active','disclosure-policy','disclosure-policy-archive','disclosure-review'].includes(JSON.parse(key)[0]));
 if(adultRemoval)expect(oldRows.some(([key])=>JSON.parse(key)[0]==='disclosure-policy')).toBe(true);
 for(const [key,value] of oldRows)expect(advancedA[key]).toEqual(value);
 expect(advancedA[JSON.stringify(['document-owner',scope.id,documentId])]).toBe(parsed.grant.eventHash);

 // A retained decision leaves an excluded device on the original branch.
 await open(c);
 const beforeC=await rows(c);
 await review(c,proposal);
 await button(c,'Keep my branch and retain this decision').click();
 await expect(c.getByText(`Retained ${decision} · branch kept separate ${parsed.grant.eventHash}`,{exact:true})).toBeVisible();
 await expect(button(c,'Install reviewed encrypted rotation')).toHaveCount(0);
 expect(await rows(c)).toEqual(beforeC);
 await c.reload();
 await open(c);
 await expect(c.getByText(`Retained ${decision} · branch kept separate ${parsed.grant.eventHash}`,{exact:true})).toBeVisible();
 await expect(c.getByLabel('Household document generation')).toHaveText('Household generation 3');
 await c.goto('./');
 await expect(c.getByText('Third device thyme',{exact:true})).toBeVisible();
 await c.goto('./settings');await openHouseholdTools(c);

 await fault(b,'recipient-admission','receive-revocation:');
 await uploadFile(b,'Install reviewed encrypted rotation',file);
 await expect(b.getByText('Local storage could not complete the change. You can retry.')).toBeVisible();
 expect(await rows(b)).toEqual(beforeB);
 await b.reload();
 await open(b);
 await review(b,proposal);
 const tampered=Buffer.from(file);
 tampered[tampered.length-1]^=1;
 await uploadFile(b,'Install reviewed encrypted rotation',tampered);
 await expect(b.getByText(/encrypted rotation file is unavailable/)).toBeVisible();
 expect(await rows(b)).toEqual(beforeB);
 await uploadFile(b,'Install reviewed encrypted rotation',file);
 await expect(button(b,'Reopen rotated household')).toBeVisible();
 await expect(b.getByLabel('Household document generation')).toHaveText('Household generation 3');
 await button(b,'Reopen rotated household').click();
 await expect(b.getByText('Invitation proof onion',{exact:true})).toBeVisible();
 await addPantry(b,'Fresh-epoch coriander');
 const advancedB=await rows(b);
 for(const [key,value] of Object.entries(beforeB)){
  if(['document','document-owner','object','inbox'].includes(JSON.parse(key)[0]))expect(advancedB[key]).toEqual(value);
 }
 await open(b);
 await review(b,proposal);
 await uploadFile(b,'Install reviewed encrypted rotation',file);
 await expect(b.getByText('This exact rotation was already saved.')).toBeVisible();
 expect(await rows(b)).toEqual(advancedB);
 await button(b,'Exchange encrypted cooking files').click();
 await uploadFile(b,'Choose encrypted cooking update',late);
 await expect(b.getByText(/Update not applied:/)).toBeVisible();
 expect(await rows(b)).toEqual(advancedB);
 await uploadFile(b,'Hold late update for review',late);
 await button(b,`Review held update ${lateId}`).click();
 await expect(b.getByText(/pantry-create .*Third device thyme/)).toBeVisible();
 await b.reload();
 await open(b);
 await button(b,`Review held update ${lateId}`).click();
 await expect(b.getByText(/pantry-create .*Third device thyme/)).toBeVisible();
 for(const page of [a,b]){
  await page.goto('./shopping');
  await expect(page.getByText('Rotation carrots',{exact:true})).toBeVisible();
  await expect(page.getByText('2.5 kg',{exact:true})).toBeVisible();
  await page.goto('./');
  await expect(page.getByText('Third device thyme',{exact:true})).toHaveCount(0);
 }
 await b.goto('./settings');await openHouseholdTools(b);
 await button(b,'Exchange encrypted cooking files').click();
 const fresh=b.getByRole('button',{name:/^Download encrypted update /});
 await expect(fresh).toHaveCount(1);
 const bytes=await downloadFile(b,await fresh.textContent());
 expect(JSON.parse(bytes.toString()).header.epochId).toBe(newEpochId);
 const unchangedC=await rows(c);
 await button(c,'Exchange encrypted cooking files').click();
 await uploadFile(c,'Choose encrypted cooking update',bytes);
 await expect(c.getByText(/Update not applied:/)).toBeVisible();
 expect(await rows(c)).toEqual(unchangedC);
 await a.goto('./');
 await expect(a.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 await a.getByRole('button',{name:'Open settings'}).click();await openHouseholdTools(a);
 await button(a,'Exchange encrypted cooking files').click();
 const imported=a.waitForEvent('load',{timeout:15000});
 await uploadFile(a,'Choose encrypted cooking update',bytes);
 await imported.catch(async error=>{
  console.error('FRESH EPOCH RECEIVE',await a.getByRole('alert').allTextContents());
  throw error;
 });
 await a.goto('./');
 await expect(a.getByText('Fresh-epoch coriander',{exact:true})).toBeVisible();
 await b.reload();
 await openHouseholdTools(b);
 await expect(b.getByLabel('Household document generation')).toHaveText('Household generation 4');
}

const recoveryButton=(page,name)=>page.getByRole('button',{name,exact:true});
const recoveryInput=page=>page.getByLabel('Incoming recovery message');
const recoveryOutput=page=>page.getByLabel('Outgoing recovery message',{exact:true});
const recoverSend=async(page,message,action)=>{
 await recoveryInput(page).fill(typeof message==='string'?message:JSON.stringify(message));
 await recoveryButton(page,action).click();
};
const personalRevision=page=>page.evaluate(async()=>{
 const req=request=>new Promise((resolve,reject)=>{
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
 const name=localStorage.getItem('creative-cooking-local-workspace-v1');
 const db=await req(indexedDB.open(`${name}-records`));
 try{
  const store=db.transaction('records','readonly').objectStore('records');
  const keys=await req(store.getAllKeys());
  const slot=keys.find(key=>key.startsWith('["pairing-authority","personal",'));
  const record=await req(store.get(slot)),state=JSON.parse(new TextDecoder().decode(record.authorityState));
  const root=state.root??state.rootState.root;
  return (await req(store.get(JSON.stringify(['document',root.scopeId,root.documentId]))))?.revision??-1;
 }finally{db.close()}
});
async function registerRecovery(a,b,c){
 await c.goto('./chef');
 await expect(c.getByText('Saved on this device',{exact:true})).toBeVisible();
 await c.getByLabel('Private cooking note').fill('Private continuity dinner');
 const before=await personalRevision(c);
 await c.getByLabel('Save note').click();
 await expect(c.getByText('Private continuity dinner',{exact:true}).last()).toBeVisible();
 await expect.poll(()=>personalRevision(c),{timeout:15_000}).toBeGreaterThan(before);
 await expect(c.getByText('Saved on this device',{exact:true})).toBeVisible();
 await c.reload();
 await expect(c.getByText('Private continuity dinner',{exact:true}).last()).toBeVisible();
 await c.goto('./settings');await openHouseholdTools(c);
 await recoveryButton(c,'Set up household recovery continuity').click();
 for(const page of [a,b]){
  await page.goto('./settings');await openHouseholdTools(page);
  await recoveryButton(page,'Authorize household readmission').click();
  await expect(recoveryInput(page)).toBeVisible();
 }
 const kits=[];
 for(const generation of [0,1]){
  await recoveryButton(c,'Create archive for continuity registration').click();
  const link=c.getByRole('link',{name:'Download encrypted archive'});
  await expect(link).toBeVisible().catch(async error=>{console.error('CONTINUITY EXPORT',await c.getByRole('alert').allTextContents());throw error;});
  const [download]=await Promise.all([c.waitForEvent('download'),link.click()]);
  const bytes=await readFile(await download.path()),code=await c.getByLabel('Recovery code',{exact:true}).inputValue();
  expect(bytes.includes(Buffer.from('Private continuity dinner'))).toBe(false);
  await c.getByLabel('Code for continuity registration').fill(code);
  await c.getByLabel('Choose encrypted archive file').last().setInputFiles({name:'personal.json',mimeType:'application/json',buffer:bytes});
  await recoveryButton(c,'Register this personal archive').click();
  await expect(c.getByText(/^Continuity registered locally/)).toBeVisible();
  const binding=JSON.parse(await recoveryOutput(c).textContent());
  expect(binding.binding.generation).toBe(generation);
  for(const page of [a,b]){
   await recoverSend(page,binding,'Retain signed continuity registration');
   await expect(page.getByText('Signed continuity generation retained on this device.')).toBeVisible();
  }
  kits.push({bytes,code,binding});
  // Remount to ensure the next export has a new link and uses durable registration.
  await recoveryButton(c,'Close recovery continuity').click();
  if(generation===0)await recoveryButton(c,'Set up household recovery continuity').click();
 }
 return kits;
}

async function routedReadmission(a,b,lost,context,setup,scope,kits){
 const fresh=await context.newPage();
 fresh.setDefaultTimeout(15000);
 await setup(fresh);
 await fresh.goto('./settings');await openHouseholdTools(fresh);
 for(const page of [a,b]){
  await page.goto('./settings');await openHouseholdTools(page);
  await recoveryButton(page,'Authorize household readmission').click();
 }
 await recoveryButton(fresh,'Recover personal data and request readmission').click();
 const restore=async({code,bytes})=>{
  await fresh.getByLabel('Recovery code',{exact:true}).fill(code);
  await fresh.getByLabel('Choose encrypted archive file').setInputFiles({name:'personal.json',mimeType:'application/json',buffer:bytes});
  await recoveryButton(fresh,'Restore personal archive').click();
  await expect(fresh.getByRole('heading',{name:'Recovered personal archive'})).toBeVisible({timeout:15_000})
   .catch(async error=>{console.error('ARCHIVE RESTORE',await fresh.getByRole('alert').allTextContents());throw error;});
  await expect(fresh.getByText('Private continuity dinner',{exact:true}).last()).toBeVisible();
  await expect(fresh.getByText(/Recoverable personal keys: 1. Available encrypted updates on this device: 0./)).toBeVisible();
 };
 await restore(kits[0]);
 await fresh.reload();
 await openHouseholdTools(fresh);
 await recoveryButton(fresh,'Recover personal data and request readmission').click();
 await expect(fresh.getByText('Private continuity dinner',{exact:true}).last()).toBeVisible();
 await fresh.getByLabel('Verified household ID').fill(scope.id);
 await recoveryButton(fresh,'Create signed recovery request').click();
 await expect(fresh.getByText(/^Independently verify the current household root/)).toBeVisible();
 await expect(recoveryOutput(fresh)).toHaveCount(0);
 for(const page of [a,fresh])await recoveryButton(page,'Show device identity').click();
 await recoveryButton(a,'Show public household authority').click();
 const bundle=await a.getByLabel('Public household authority',{exact:true}).textContent();
 const {rootPin,selectedHead}=JSON.parse(bundle);
 await fresh.getByLabel('Household authority bundle').fill(bundle);
 await fresh.getByLabel('Confirmed household root').fill(rootPin);
 await fresh.getByLabel('Confirmed household head').fill('0'.repeat(64));
 await recoveryButton(fresh,'Verify and accept public authority').click();
 await expect(fresh.getByText('CONFIRMATION_REQUIRED',{exact:true})).toBeVisible();
 await fresh.getByLabel('Confirmed household head').fill(selectedHead);
 await recoveryButton(fresh,'Verify and accept public authority').click();
 await expect(fresh.getByText('Public authority accepted. No access or keys have been granted.')).toBeVisible();
 await expect(recoveryButton(fresh,'Open this shared household')).toHaveCount(0);
 await recoveryButton(a,'Show signed readmission parent').click();
 const sponsorParent=await a.getByLabel('Signed readmission parent',{exact:true}).textContent();

 async function request(){
  await fresh.getByLabel('Sponsoring device parent proof').fill(sponsorParent);
  await recoveryButton(fresh,'Create signed recovery request').click();
  await expect(fresh.getByText(/^Send this signed request/)).toBeVisible();
  return JSON.parse(await recoveryOutput(fresh).textContent());
 }
 const old=await request();
 expect(old.claim.recoveryGeneration).toBe(0);
 await recoverSend(a,old,'Issue recovery challenge');
 await expect(a.getByText(/^The request does not match the current head/)).toBeVisible();
 await expect(recoveryOutput(a)).toHaveCount(0);
 await restore(kits[1]);
 const current=await request();
 expect(current.claim.recoveryGeneration).toBe(1);
 const wrongHead=structuredClone(current);
 wrongHead.claim.checkpoint=kits[1].binding.binding.checkpoint;
 await recoverSend(a,wrongHead,'Issue recovery challenge');
 await expect(a.getByText(/^The request does not match the current head/)).toBeVisible();
 await recoverSend(a,current,'Issue recovery challenge');
 await expect(a.getByText(/^Send the sealed challenge/)).toBeVisible();
 const challenge=JSON.parse(await recoveryOutput(a).textContent());
 await recoverSend(a,current,'Issue recovery challenge');
 await expect(recoveryOutput(a)).toHaveText(JSON.stringify(challenge));
 await recoverSend(fresh,{...challenge,sponsorDevice:kits[1].binding.binding.signerDevice},'Answer recovery challenge');
 await expect(fresh.getByText('INVALID_PROOF',{exact:true})).toBeVisible();
 await expect(recoveryOutput(fresh)).toHaveCount(0);
 await recoverSend(fresh,challenge,'Answer recovery challenge');
 await expect(fresh.getByText(/^Send this proof of the new device/)).toBeVisible();
 const response=JSON.parse(await recoveryOutput(fresh).textContent());
 await recoverSend(b,response,'Prepare readmission decision');
 await expect(b.getByText(/^Use the signed parent export from the sponsoring device/)).toBeVisible();
 await recoveryButton(b,'Show readmission recipient binding').click();
 await expect(recoveryOutput(b)).toBeVisible();
 const memberBinding=await recoveryOutput(b).textContent();
 await recoverSend(a,response,'Prepare readmission decision');
 await expect(a.getByText('RECIPIENT_BINDINGS_REQUIRED',{exact:true})).toBeVisible();
 await a.getByLabel('Other current device bindings').fill(memberBinding);
 await recoverSend(a,response,'Prepare readmission decision');
 await expect(a.getByText(/0 of 2 required adults/)).toBeVisible({timeout:15_000})
  .catch(async error=>{console.error('READMISSION PREPARATION',await a.getByRole('alert').allTextContents());throw error;});
 await expect(recoveryButton(a,'Publish readmission and rotate household key')).toBeDisabled();
 await recoveryButton(a,'Approve this readmission').click();
 await expect(a.getByText(/1 of 2 required adults/)).toBeVisible();
 await recoverSend(b,await recoveryOutput(a).textContent(),'Review readmission for approval');
 await expect(b.getByText(/1 of 2 required adults/)).toBeVisible();
 await recoveryButton(b,'Approve this readmission').click();
 await expect(b.getByText(/2 of 2 required adults/)).toBeVisible();
 const proposal=JSON.parse(await recoveryOutput(b).textContent());
 expect(proposal.item.event.kind).toBe('recoverDevice');
 expect(proposal.grant.recipients).toHaveLength(3);
 expect(proposal.grant.recipients).not.toContain(kits[1].binding.binding.signerDevice);
 expect(proposal.manifest.seedSchemaVersion).toBe(4);
 await recoverSend(a,proposal,'Review readmission for approval');
 await expect(a.getByText(/2 of 2 required adults/)).toBeVisible();
 await recoveryButton(a,'Publish readmission and rotate household key').click();
 await expect(recoveryButton(a,'Reopen household after readmission')).toBeVisible();
 await expect(a.getByLabel('Household document generation')).toHaveText('Household generation 4');
 const file=await downloadFile(a,`Download readmission for ${current.claim.deviceId}`);
 const bFile=await downloadFile(a,`Download readmission for ${JSON.parse(memberBinding).deviceId}`);
 expect(file.includes(Buffer.from('Fresh-epoch coriander'))).toBe(false);
 expect(file.includes(Buffer.from('Private continuity dinner'))).toBe(false);
 expect(file).not.toEqual(bFile);
 await recoveryButton(a,'Reopen household after readmission').click();
 await expect(a.getByText('Fresh-epoch coriander',{exact:true})).toBeVisible();
 await a.goto('./settings');await openHouseholdTools(a);
 await recoveryButton(a,'Authorize household readmission').click();
 expect(await downloadFile(a,`Download readmission for ${current.claim.deviceId}`)).toEqual(file);
 await recoverSend(a,current,'Issue recovery challenge');
 await expect(a.getByText(/^The request does not match the current head/)).toBeVisible();
 await recoverSend(b,proposal,'Review household access file decision');
 await expect(recoveryButton(b,'Install verified readmission file')).toBeVisible();
 await uploadFile(b,'Install verified readmission file',bFile);
 await recoveryButton(b,'Reopen household after readmission').click();
 await expect(b.getByText('Fresh-epoch coriander',{exact:true})).toBeVisible();

 await recoverSend(fresh,proposal,'Review household access file decision');
 await expect(recoveryButton(fresh,'Install verified readmission file')).toBeVisible();
 await uploadFile(fresh,'Install verified readmission file',bFile);
 await expect(fresh.getByText(/^This encrypted file could not be opened/)).toBeVisible();
 await expect(recoveryButton(fresh,'Open readmitted household')).toHaveCount(0);
 await uploadFile(fresh,'Install verified readmission file',file);
 await expect(recoveryButton(fresh,'Open readmitted household')).toBeVisible();
 await expect(fresh.getByLabel('Open household')).toContainText('Original local household');
 await uploadFile(fresh,'Install verified readmission file',file);
 await expect(fresh.getByText('This exact readmission is already installed.')).toBeVisible();
 await fresh.reload();
 await openHouseholdTools(fresh);
 await recoveryButton(fresh,'Recover personal data and request readmission').click();
 await expect(fresh.getByText('Private continuity dinner',{exact:true}).last()).toBeVisible();
 await recoveryButton(fresh,'Open readmitted household').click();
 await expect(fresh.getByText('Fresh-epoch coriander',{exact:true})).toBeVisible();
 await expect(fresh.getByText('Third device thyme',{exact:true})).toHaveCount(0);
 await addPantry(fresh,'Readmitted device sumac');
 await fresh.reload();
 await expect(fresh.getByText('Readmitted device sumac',{exact:true})).toBeVisible();
 await fresh.goto('./settings');await openHouseholdTools(fresh);
 await expect(fresh.getByLabel('Household document generation')).toHaveText('Household generation 5');
 await recoveryButton(fresh,'Exchange encrypted cooking files').click();
 const update=await downloadFile(fresh,await fresh.getByRole('button',{name:/^Download encrypted update /}).textContent());
 await recoveryButton(a,'Exchange encrypted cooking files').click();
 const importReopen=a.waitForEvent('load',{timeout:15000});
 await uploadFile(a,'Choose encrypted cooking update',update);
 await importReopen;
 await a.goto('./');
 await expect(a.getByText('Readmitted device sumac',{exact:true})).toBeVisible();
 await expect(lost.getByLabel('Household document generation')).toHaveText('Household generation 3');
}
