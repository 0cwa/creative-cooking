import {test,expect} from './browser-fixture.mjs';
import {readFile} from 'node:fs/promises';
import sodium from 'libsodium-wrappers';
import {domain} from '../src/loro/authority/validator.mjs';
import {ceremonyBytes} from '../src/loro/pairing/candidate-v2.mjs';
test('three independent devices publish admissions and explicitly open the new household generation',async({browser,baseURL})=>{
 test.setTimeout(180000);const aCtx=await browser.newContext({baseURL,acceptDownloads:true}),bCtx=await browser.newContext({baseURL,acceptDownloads:true}),cCtx=await browser.newContext({baseURL,acceptDownloads:true});const a=await aCtx.newPage(),b=await bCtx.newPage(),c=await cCtx.newPage(),errors=[];a.setDefaultTimeout(12000);b.setDefaultTimeout(12000);for(const p of [a,b,c]){p.on('pageerror',e=>errors.push(String(e)));p.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text())});p.on('requestfailed',r=>console.error('REQUEST',r.url(),r.failure()))}try{
 const setup=async p=>{await p.goto('./');await p.getByRole('button',{name:'Start fresh local preview'}).click().catch(async e=>{console.error('SETUP PAGE',p.url(),(await p.locator('body').innerText()).slice(0,2500),errors);throw e});await p.getByRole('button',{name:'Review household policy'}).click();await p.getByRole('button',{name:'Accept this household policy'}).click();await expect(p.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally')};
 await setup(a);await setup(b);await setup(c);await addPantry(b,'Original household bay leaf');await addPantry(c,'Newcomer local basil');await c.getByRole('button',{name:'Open settings'}).click();await c.getByRole('button',{name:'Show device identity'}).click();const thirdIdentity=await c.getByLabel('Public device identity',{exact:true}).textContent();await a.getByLabel('Ingredient and details').fill('Invitation proof onion');await a.getByLabel('Add ingredient').click();await expect(a.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');
 for(const p of [a,b]){await p.getByRole('button',{name:'Open settings'}).click();await p.getByRole('button',{name:'Show device identity'}).click();await p.getByRole('button',{name:'Invite or join a household'}).click()}
 const identity=await b.getByLabel('Public device identity',{exact:true}).textContent();await a.getByLabel('Recipient public identity').fill(identity);await a.getByRole('button',{name:'Prepare current-cooking invitation'}).click();await expect(a.getByLabel('Public invitation message',{exact:true})).toBeVisible();const offer=await a.getByLabel('Public invitation message',{exact:true}).textContent(),code=await a.getByLabel('Invitation verification code').textContent();expect(offer).not.toContain('Invitation proof onion');
 await a.getByRole('button',{name:'Show public household authority'}).click();const authority=await a.getByLabel('Public household authority',{exact:true}).textContent(),root=await a.getByLabel('Household root to compare').textContent(),head=await a.getByLabel('Household head to compare').textContent();await b.getByLabel('Household authority bundle').fill(authority);await b.getByLabel('Confirmed household root').fill(root);await b.getByLabel('Confirmed household head').fill(head);await b.getByRole('button',{name:'Verify and accept public authority'}).click();await expect(b.getByText('Public authority accepted. No access or keys have been granted.')).toBeVisible();await b.getByRole('button',{name:'Join invitation'}).click();await b.getByLabel('Public invitation message input').fill(offer);await b.getByLabel('Confirmed invitation code').fill('0'.repeat(64));await b.getByRole('button',{name:'Start or resume device verification'}).click();await expect(b.locator('[role=alert]').last()).toBeVisible();await b.getByLabel('Confirmed invitation code').fill(code);await b.getByRole('button',{name:'Start or resume device verification'}).click();await a.getByLabel('Confirmed invitation code').fill(code);await a.getByRole('button',{name:'Start or resume device verification'}).click();
 for(let i=0;i<3;i++){const am=await a.getByLabel('Your verification message').textContent(),bm=await b.getByLabel('Your verification message').textContent();await a.getByLabel('Other device verification message').fill(bm);await b.getByLabel('Other device verification message').fill(am);await a.getByRole('button',{name:'Continue device verification'}).click();await b.getByRole('button',{name:'Continue device verification'}).click();const expected=['Exchange your response with the other device.','Exchange your acknowledgement with the other device.','Both devices have completed verification.'][i];for(const p of [a,b])await expect(p.getByText(expected)).toBeVisible().catch(async e=>{console.error('CEREMONY',i,await p.locator('[role=alert]').allTextContents());throw e});if(i===0){await a.reload();await a.getByRole('button',{name:'Invite or join a household'}).click();await a.getByLabel('Recipient public identity').fill(identity);await a.getByRole('button',{name:'Prepare current-cooking invitation'}).click();await expect(a.getByLabel('Public invitation message',{exact:true})).toHaveText(offer);await a.getByLabel('Confirmed invitation code').fill(code);await a.getByRole('button',{name:'Start or resume device verification'}).click();await expect(a.getByText('Exchange your response with the other device.')).toBeVisible()}}
 await expect(a.getByText('Both devices have completed verification.')).toBeVisible();await expect(b.getByText('Both devices have completed verification.')).toBeVisible();const different=JSON.parse(offer);different.scope.id=crypto.randomUUID();await b.getByLabel('Public invitation message input').fill(JSON.stringify(different));await expect(b.getByRole('button',{name:'Choose encrypted household file'})).toHaveCount(0);await b.getByLabel('Confirmed invitation code').fill('0'.repeat(64));await b.getByRole('button',{name:'Start or resume device verification'}).click();await expect(b.getByRole('button',{name:'Choose encrypted household file'})).toHaveCount(0);await b.getByLabel('Public invitation message input').fill(offer);await b.getByLabel('Confirmed invitation code').fill(code);await b.getByRole('button',{name:'Start or resume device verification'}).click();await expect(b.getByText('Both devices have completed verification.')).toBeVisible();const pending=a.waitForEvent('download');await a.getByRole('button',{name:'Admit and download encrypted household file'}).click();const download=await pending.catch(async e=>{console.error('PUBLISH',await a.locator('[role=alert]').allTextContents());throw e}),bytes=await readFile(await download.path());expect(bytes.includes(Buffer.from('Invitation proof onion'))).toBe(false);await a.reload();await a.getByRole('button',{name:'Invite or join a household'}).click();await a.getByLabel('Previously prepared invitation message').fill(offer);const retryDownload=a.waitForEvent('download');await a.getByRole('button',{name:'Download an already admitted household file'}).click();expect(await readFile(await (await retryDownload).path())).toEqual(bytes);const chooserPromise=b.waitForEvent('filechooser');await b.getByRole('button',{name:'Choose encrypted household file'}).click();const chooser=await chooserPromise;await chooser.setFiles({name:'household.bin',mimeType:'application/octet-stream',buffer:bytes});await expect(b.getByText(/Household installed/)).toBeVisible();await expect(b.getByRole('button',{name:'Open this shared household'})).toBeVisible();await b.getByRole('button',{name:'Open this shared household'}).click();await expect(b.getByText('Invitation proof onion',{exact:true})).toBeVisible();await b.getByLabel('Ingredient and details').fill('Invitation proof mint');await b.getByLabel('Add ingredient').click();await expect(b.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await b.reload();await expect(b.getByText('Invitation proof mint',{exact:true})).toBeVisible();await b.getByLabel('Remove Invitation proof mint').click();await expect(b.getByTestId('pantry-local-persistence-status')).toHaveText('Saved locally');await b.getByRole('button',{name:'Open settings'}).click();await b.getByRole('button',{name:'Exchange encrypted cooking files'}).click();const outbound=b.getByRole('button',{name:/Download encrypted update /});await expect(outbound).toHaveCount(2);const files=[];for(let i=0;i<2;i++){const transfer=b.waitForEvent('download');await outbound.nth(i).click();files.push(await readFile(await (await transfer).path()))}const dependencies=file=>JSON.parse(file.toString()).header.sourceEffectIds.length,update=files.find(x=>dependencies(x)===0),dependent=files.find(x=>dependencies(x)>0);expect(update).toBeTruthy();expect(dependent).toBeTruthy();expect(update.includes(Buffer.from('Invitation proof mint'))).toBe(false);await a.getByRole('button',{name:'Exchange encrypted cooking files'}).click();const badFile=Buffer.from(update);badFile[badFile.length-2]^=1;const badUpload=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();await (await badUpload).setFiles({name:'damaged.bin',mimeType:'application/octet-stream',buffer:badFile});await expect(a.getByText(/Update not applied:/)).toBeVisible();await a.getByRole('button',{name:'Refresh retained cooking updates'}).click();await expect(a.getByText(/Retained update awaiting application/)).toHaveCount(0);await a.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(typeof key==='string'&&key.startsWith('[\"inbox\",')){IDBObjectStore.prototype.put=put;throw Error('injected staging failure')}return put.call(this,value,key)}});const fault=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();await (await fault).setFiles({name:'fault.bin',mimeType:'application/octet-stream',buffer:update});await expect(a.getByText(/Update not applied:/)).toBeVisible();await a.getByRole('button',{name:'Refresh retained cooking updates'}).click();await expect(a.getByText(/Retained update awaiting application/)).toHaveCount(0);const early=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();await (await early).setFiles({name:'dependent.bin',mimeType:'application/octet-stream',buffer:dependent});await expect(a.getByText(/MISSING_DEPENDENCY/)).toBeVisible();await a.getByRole('button',{name:'Refresh retained cooking updates'}).click();await expect(a.getByText(/Retained update awaiting application/)).toBeVisible();const upload=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();const applied=a.waitForEvent('load',{timeout:15000});await (await upload).setFiles({name:'update.bin',mimeType:'application/octet-stream',buffer:update});await applied;await a.goto('./');await expect(a.getByText('Invitation proof mint',{exact:true})).toBeVisible();await a.getByRole('button',{name:'Open settings'}).click();await a.getByRole('button',{name:'Exchange encrypted cooking files'}).click();const retry=a.getByRole('button',{name:/Retry retained update /});await expect(retry).toHaveCount(1);const retried=a.waitForEvent('load');await retry.click();await retried;await a.goto('./');await expect(a.getByText('Invitation proof mint',{exact:true})).toHaveCount(0);await a.getByRole('button',{name:'Open settings'}).click();await a.getByRole('button',{name:'Exchange encrypted cooking files'}).click();const duplicate=a.waitForEvent('filechooser');await a.getByRole('button',{name:'Choose encrypted cooking update'}).click();await (await duplicate).setFiles({name:'dependent-again.bin',mimeType:'application/octet-stream',buffer:dependent});await expect(a.getByText('This exact update was already applied. No new changes were made.',{exact:true})).toBeVisible();await a.goto('./');await expect(a.getByText('Invitation proof mint',{exact:true})).toHaveCount(0);await a.getByRole('button',{name:'Open settings'}).click();await a.getByRole('button',{name:'Review an adult invitation'}).click();await a.getByLabel('New invitee public identity').fill(thirdIdentity);await a.getByRole('button',{name:'Create public invitation proposal'}).click();const proposalText=await a.getByLabel('Invitation proposal',{exact:true}).textContent();await b.getByRole('button',{name:'Review an adult invitation'}).click();await b.getByLabel('Invitation proposal input').fill(proposalText);await b.getByRole('button',{name:'Review invitation proposal'}).click();await expect(b.getByText('Approvals: 1 of 1 required from 2 adults.')).toBeVisible();await b.getByRole('button',{name:'Approve reviewed invitation'}).click();const approvalText=await b.getByLabel('Signed invitation approval').textContent();await a.getByLabel('Invitation proposal input').fill(proposalText);await a.getByLabel('Invitation approval input').fill(approvalText);await a.getByRole('button',{name:'Verify and collect approval'}).click();await expect(a.getByText('Verified 2 of 1 required adult approvals. Further admission and device verification are still required.')).toBeVisible();await a.getByRole('button',{name:'Agree to share current cooking'}).click();await b.getByRole('button',{name:'Agree to share current cooking'}).click();await a.getByRole('button',{name:'Sign current-cooking agreement'}).click();await b.getByRole('button',{name:'Sign current-cooking agreement'}).click();const signedA=JSON.parse(await a.getByLabel('Signed current-cooking agreement',{exact:true}).textContent()),signedB=JSON.parse(await b.getByLabel('Signed current-cooking agreement',{exact:true}).textContent());await a.getByLabel('Signed current-cooking agreement input').fill(JSON.stringify(signedA));await a.getByRole('button',{name:'Add signed agreement'}).click();await a.getByRole('button',{name:'Verify and retain all agreements'}).click();await expect(a.getByText('INVALID_INPUT',{exact:true})).toBeVisible();await a.getByLabel('Signed current-cooking agreement input').fill(JSON.stringify(signedB));await a.getByRole('button',{name:'Add signed agreement'}).click();await a.getByRole('button',{name:'Verify and retain all agreements'}).click();await expect(a.getByText('All required signatures were verified and the current-cooking sharing agreement was retained. Admission and device key exchange are still required.')).toBeVisible();for(const entry of [signedB,signedA]){await b.getByLabel('Signed current-cooking agreement input').fill(JSON.stringify(entry));await b.getByRole('button',{name:'Add signed agreement'}).click()}await b.getByRole('button',{name:'Verify and retain all agreements'}).click();await expect(b.getByText('All required signatures were verified and the current-cooking sharing agreement was retained. Admission and device key exchange are still required.')).toBeVisible();await a.getByRole('button',{name:'Review current-cooking grant'}).click();await a.getByLabel('Approved invitation for grant').fill(proposalText);await a.getByRole('button',{name:'Prepare current-cooking grant'}).click();const grantText=await a.getByLabel('Prepared cooking grant',{exact:true}).textContent();await b.getByRole('button',{name:'Review current-cooking grant'}).click();await b.getByLabel('Cooking grant to review').fill(grantText);await b.getByRole('button',{name:'Inspect proposed cooking grant'}).click();await expect(b.getByLabel('Proposed current cooking')).toContainText('Invitation proof onion');await b.getByRole('button',{name:'Sign reviewed cooking grant'}).click();const grantApproval=await b.getByLabel('Signed cooking grant approval').textContent();await a.getByLabel('Cooking grant to review').fill(grantText);await a.getByLabel('Cooking grant approval input').fill(grantApproval);await a.getByRole('button',{name:'Verify and collect grant approval'}).click();await expect(a.getByText('Verified 2 of 1 required adult signatures. Admission still requires device verification.')).toBeVisible();const collectedText=await a.getByLabel('Cooking grant with collected approvals').textContent();await a.getByRole('button',{name:'Verify an existing device'}).click();await b.getByRole('button',{name:'Verify an existing device'}).click();await a.getByLabel('Collected grant for existing device').fill(collectedText);const staleIdentity={...JSON.parse(identity),wrappingKey:'0'.repeat(64)};
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
 await sodium.ready;
 const sourceDigest=sodium.to_hex(sodium.crypto_generichash(32,domain('projection-source-snapshot',Buffer.from(beforePublish.document.bytes).toString('hex'))));
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
  await a.getByRole('button',{name:'Open existing workspace',exact:true}).click();
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
 await a.getByRole('button',{name:'Open settings'}).click();
 await a.getByRole('button',{name:'Invite or join a household'}).click();
 await expect(a.getByRole('button',{name:'Reopen household after admission'})).toBeVisible();
 const newcomerLabel=`Download encrypted file for new device ${thirdId}`;
 const existingLabel=`Download encrypted file for existing device ${existingId}`;
 const newcomerFile=await downloadFile(a,newcomerLabel),existingFile=await downloadFile(a,existingLabel);
 expect(newcomerFile).not.toEqual(existingFile);
 for(const file of [newcomerFile,existingFile])expect(file.includes(Buffer.from('Invitation proof onion'))).toBe(false);
 await a.getByRole('button',{name:'Reopen household after admission'}).click();
 await expect(a.getByText('Invitation proof onion',{exact:true})).toBeVisible();
 await a.getByRole('button',{name:'Open settings'}).click();
 await expect(a.getByLabel('Household document generation')).toHaveText('Household generation 3');
 await a.getByRole('button',{name:'Invite or join a household'}).click();
 expect(await downloadFile(a,newcomerLabel)).toEqual(newcomerFile);
 expect(await downloadFile(a,existingLabel)).toEqual(existingFile);

 await b.goto('./');
 await expect(b.getByText('Invitation proof onion',{exact:true})).toBeVisible();
 await addPantry(b,'Old generation rosemary');
 await b.reload();
 await expect(b.getByText('Old generation rosemary',{exact:true})).toBeVisible();
 await b.getByRole('button',{name:'Open settings'}).click();
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
 await b.getByRole('button',{name:'Open settings'}).click();
 await expect(b.getByLabel('Household document generation')).toHaveText('Household generation 3');
 await b.getByRole('button',{name:'Verify an existing device'}).click();
 await b.getByRole('button',{name:'Verify this existing device'}).click();
 await uploadFile(b,existingAction,existingFile);
 await expect(b.getByText('Household generation 3 is already open on this device.')).toBeVisible();
 expect(await readRetained(b,scope.id,oldDocument,oldHead)).toEqual(nextMember);
 await b.getByRole('button',{name:'Show device identity'}).click();
 await b.getByRole('button',{name:'Return to original local household'}).click();
 await expect(b.getByText('Original household bay leaf',{exact:true})).toBeVisible();
 await b.getByRole('button',{name:'Open settings'}).click();
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
 await expect(c.getByLabel('Household document generation')).toHaveText('Household generation 1');
 await c.getByRole('button',{name:'Show device identity'}).click();
 await c.getByRole('button',{name:'Invite or join a household'}).click();
 await c.getByRole('button',{name:'Join invitation'}).click();
 const changedOffer=JSON.parse(laterOffer);
 changedOffer.ceremony.transcript.responder.nonce.__bytes[0]^=1;
 const parsedCeremony=JSON.parse(JSON.stringify(changedOffer.ceremony),(_key,value)=>
  value?.__bytes?Uint8Array.from(value.__bytes):value);
 const changedCode=sodium.to_hex(sodium.crypto_generichash(32,ceremonyBytes(parsedCeremony.transcript,parsedCeremony.guard)));
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
 await c.getByRole('button',{name:'Open settings'}).click();
 await expect(c.getByLabel('Household document generation')).toHaveText('Household generation 3');
 await c.getByRole('button',{name:'Show device identity'}).click();
 await c.getByRole('button',{name:'Return to original local household'}).click();
 await expect(c.getByText('Newcomer local basil',{exact:true})).toBeVisible();
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
 await expect(b.getByText('MISSING_SEQUENCES',{exact:true})).toBeVisible();
 expect(await readRetained(b,scope.id,oldDocument,oldHead)).toEqual({...nextMember,counter:null});
 expect(errors).toEqual([]);
 }finally{await aCtx.close();await bCtx.close();await cCtx.close()}
});

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
