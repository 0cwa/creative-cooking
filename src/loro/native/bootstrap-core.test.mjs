import {createHash,randomUUID} from 'node:crypto';
// Host contract test only; native Android/Hermes proof must run separately.
import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';import {copyFileSync,existsSync,readdirSync,rmSync} from 'node:fs';import sodium from 'libsodium-wrappers';import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';import {openNativeWorkspaceWith,returnToOriginalNativeWorkspaceWith} from './bootstrap-core.mjs';import {executeAction} from '../app/action.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {prepareInitialPolicy,acceptInitialPolicy} from '../disclosure/setup.mjs';
import {projectCooking} from '../domain/app-projection.mjs';
import {domain} from '../authority/validator.mjs';
import {cookingDirect} from '../transport/cooking-direct.mjs';
import {householdReceiverIds} from '../app/household-transfer.mjs';
import {resolveOriginalHousehold,openWorkspaceHouseholdRuntime,activateStagedPolicyDocumentSet,returnActivatedPolicyDocumentSet} from '../app/workspace-household-runtime.mjs';
import {observePolicyDocumentSet,verifyPolicyDocumentSet,policyDocumentSetSubject} from '../authority/policy-document-set.mjs';
import {stageVerifiedPolicyDocumentSet} from '../app/stage-policy-document-set.mjs';
import {openSQLiteStorage} from '../storage/sqlite.ts';
await sodium.ready;const dir=process.env.NATIVE_PROOF_DIR;if(!dir)throw Error('NATIVE_PROOF_DIR required');
const masters=new Map();const keyname=(n,id)=>`${n}/${id}`;
function openMaster(n){return {exists:async id=>masters.has(keyname(n,id)),ensure:async id=>{const k=keyname(n,id);if(!masters.has(k))masters.set(k,sodium.randombytes_buf(32))},provision:async id=>{const k=keyname(n,id);if(masters.has(k))throw Error('LOCKED');masters.set(k,sodium.randombytes_buf(32))},wrap:async(id,p,a)=>{const k=masters.get(keyname(n,id));if(!k)throw Error('LOCKED');const nonce=sodium.randombytes_buf(24);return new Uint8Array([...nonce,...sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(p,a,null,nonce,k)])},unwrap:async(id,p,a)=>{const k=masters.get(keyname(n,id));if(!k)throw Error('LOCKED');return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,p.slice(24),a,p.slice(0,24),k)},close(){}}}
function openDatabase(name){const db=new DatabaseSync(join(dir,`${name}.sqlite`));return {executeSync:(q,p=[])=>{const s=db.prepare(q);return {rows:q.startsWith('SELECT')?s.all(...p):(s.run(...p),[])}},close:()=>db.close()}}
const args=(name,create)=>({name,create,openDatabase,openMaster,sodium,LoroDoc,decodeImportBlobMeta});
function removeWorkspace(name) {
 for (const file of readdirSync(dir)) {
  if (file === `${name}.sqlite` || file.startsWith(`${name}-`)) rmSync(join(dir,file),{force:true});
 }
}

test('the initial admission rule is validated and pinned through native reopen', async () => {
 const name='native-admission-rule', options=args(name,true);
 let workspace;
 try {
  await assert.rejects(openNativeWorkspaceWith({...options,policy:{kind:'fixed',fixedCount:2}}),/between 1 and 1/);
  assert.equal(existsSync(join(dir,`${name}.sqlite`)),false);
  const policy={kind:'unanimous',fixedCount:null};
  await assert.rejects(openNativeWorkspaceWith({...options,policy,openMaster:id=>({
   ...openMaster(id),ensure:async()=>{throw Error('interrupted after reservation')}
  })}),/interrupted after reservation/);
  const alternate={kind:'fixed',fixedCount:1};
  workspace=await openNativeWorkspaceWith({...options,policy:alternate});
  const original=await workspace.householdPairing.exportParent();
  assert.deepEqual(original.state.root.policy,policy);
  workspace.close();
  workspace=await openNativeWorkspaceWith({...options,policy:alternate});
  assert.deepEqual(await workspace.householdPairing.exportParent(),original);
  workspace.close();workspace=undefined;
  const db=new DatabaseSync(join(dir,`${name}.sqlite`));
  try {
   const master=openMaster(name),enc=new TextEncoder(),aad=enc.encode('creative-cooking/native-bootstrap/v1');
   const {data}=db.prepare('SELECT data FROM loro_bootstrap WHERE id=1').get();
   const reservation=JSON.parse(new TextDecoder().decode(await master.unwrap('workspace-master',data,aad)));
   const mismatch=await master.wrap('workspace-master',enc.encode(JSON.stringify({...reservation,admissionPolicy:alternate})),aad);
   db.prepare('UPDATE loro_bootstrap SET data=? WHERE id=1').run(mismatch);
  } finally {db.close()}
  await assert.rejects(openNativeWorkspaceWith(options),/INVALID_ROOT/);
 } finally {workspace?.close();removeWorkspace(name)}
});

test('native bootstrap creates signed authorities and restores a real personal action',async()=>{const name='native-bootstrap-test';try {await assert.rejects(openNativeWorkspaceWith(args(name,false)),/MISSING_BOOTSTRAP/);let w=await openNativeWorkspaceWith(args(name,true));const device=w.deviceId;const c={version:1,kind:'personal-preference-put',commandId:'one',effectId:'one',dependencyEffectIds:[],data:{key:'systemPrompt',value:'Stockholm'}};await executeAction(w.personal,w.sequences,'action',[c]);assert.equal((await w.personal.document()).doc.getMap('personal-preferences').get('systemPrompt'),'Stockholm');w.close();
 // An upgraded installation has its established workspace but no pairing metadata database.
 rmSync(join(dir,`${name}-pairing.sqlite`));
 const priorLayout=new DatabaseSync(join(dir,`${name}.sqlite`));
 priorLayout.prepare('DELETE FROM loro_records WHERE key IN (?,?)').run('["native-household-selection"]','["native-household-selection-required"]');
 priorLayout.close();
 w=await openNativeWorkspaceWith({...args(name,false),openDirect:async()=>{throw Error('DIRECT_UNAVAILABLE')}});assert.equal(w.deviceId,device);assert.equal(w.direct,undefined);
 assert.equal(w.householdPairing.selectedHousehold,false);
 assert.deepEqual(await w.householdPairing.acceptedParents(),[]);assert.equal((await w.personal.document()).doc.getMap('personal-preferences').get('systemPrompt'),'Stockholm');assert.equal(await w.sequences.reserve(w.personal.scope.scopeId,JSON.stringify(['action','one'])),1);w.close();masters.delete(keyname(name,'workspace-master'));await assert.rejects(openNativeWorkspaceWith(args(name,true)),/LOCKED/);}finally{removeWorkspace(name)}});
test('established workspace refuses missing reservation, sequences and authority',async()=>{for(const target of ['reservation','sequence','authority']){const name='native-missing-'+target,path=join(dir,`${name}.sqlite`);try{const w=await openNativeWorkspaceWith(args(name,true));const scope=w.household.scope.scopeId;w.close();const db=new DatabaseSync(path);if(target==='reservation')db.exec('DELETE FROM loro_bootstrap');if(target==='sequence')db.exec('DELETE FROM loro_sequence_counters');if(target==='authority')db.prepare('DELETE FROM loro_records WHERE key=?').run(JSON.stringify(['pairing-authority','household',scope]));db.close();await assert.rejects(openNativeWorkspaceWith(args(name,true)),target==='sequence'?/MISSING_SEQUENCES/:target==='authority'?/MISSING_AUTHORITY/:/LOCKED/);}finally{removeWorkspace(name)}}});

test('forged initial reservation cannot replace an established identity',async()=>{const name='native-forged-reservation',path=join(dir,`${name}.sqlite`);try{const w=await openNativeWorkspaceWith(args(name,true));w.close();const db=new DatabaseSync(path);const r={version:1,device:'a',adult:'b',house:'c',personal:'d',houseDoc:'e',personalDoc:'f',houseEpoch:'g',personalEpoch:'h'};db.prepare('UPDATE loro_bootstrap SET stage=?,data=?').run('reserved',new TextEncoder().encode(JSON.stringify(r)));db.close();await assert.rejects(openNativeWorkspaceWith(args(name,true)),/LOCKED/)}finally{removeWorkspace(name)}});

test('master acquisition failure closes its database handle',async()=>{
 let closes=0;await assert.rejects(openNativeWorkspaceWith({...args('master-open-failure',true),openDatabase:()=>({close(){closes++}}),openMaster:()=>{throw Error('MASTER_UNAVAILABLE')}}),/MASTER_UNAVAILABLE/);assert.equal(closes,1);
});

const scopeOf = workspace => ({kind:'household',id:workspace.household.scope.scopeId});
async function acceptPolicy(workspace) {
 const service = workspace.disclosure;
 await acceptInitialPolicy({
  service, provider:workspace.disclosureProvider, deviceId:workspace.deviceId,
  policy:await prepareInitialPolicy({service}), explicit:true
 });
}
async function addPantry(workspace, id) {
 await workspace.executeHouseholdAction(id, [{
  version:1,kind:'pantry-create',commandId:id,effectId:id,dependencyEffectIds:[],
  data:{itemId:id,name:id,preference:3,at:'2026-11-18T00:00:00Z',author:workspace.deviceId}
 }]);
}
const pantry = async workspace => projectCooking((await workspace.household.document()).doc).pantry.map(item => item.name).sort();

test('native startup reopens an activated original household read-only',async()=>{
 const name='native-activated-original'; let workspace, captured;
 const options={...args(name,true),openDirect:async input=>{captured=input;return null}};
 try {
  workspace=await openNativeWorkspaceWith(options);
  await acceptPolicy(workspace);
  await addPantry(workspace,'leek');
  const recipe={id:'soup',title:'Soup',portions:2,ingredients:[],steps:[],stepIds:[],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
  await workspace.householdContent.createRecipe('create-soup',recipe);
  await executeAction(workspace.personal,workspace.sequences,'personal-one',[{version:1,kind:'personal-preference-put',commandId:'personal-one',effectId:'personal-one',dependencyEffectIds:[],data:{key:'systemPrompt',value:'Stockholm'}}]);
  const before=await workspace.householdContent.readCooking(), parentBundle=await workspace.householdPairing.exportParent();
  const db=new DatabaseSync(join(dir,`${name}.sqlite`));
  const master=openMaster(name), row=db.prepare('SELECT data FROM loro_bootstrap WHERE id=1').get();
  const reservation=JSON.parse(new TextDecoder().decode(await master.unwrap('workspace-master',row.data,new TextEncoder().encode('creative-cooking/native-bootstrap/v1'))));
  db.close();
  const {runtime,provider}=captured,storage=runtime.storage,scope=scopeOf(workspace),pin=parentBundle.rootPin;
  const originalRoot=await storage.reopenDocument(scope.id,runtime.scope.documentId);
  const personalScope=workspace.personal.scope;
  const originalPersonal=await storage.reopenDocument(personalScope.scopeId,personalScope.documentId);
  const keys=storage.localKeys(master,sodium);await keys.unlock();
  const signing={operationId:'device-signing',identity:{version:1,scope:{kind:'personal',id:reservation.personal},deviceId:reservation.device,purpose:'device-signing',epochId:reservation.personalEpoch},publicKey:workspace.householdPairing.identity.signingKey};
  const original=await resolveOriginalHousehold({storage,scope,pin,provider,deviceId:workspace.deviceId,sodium,LoroDoc,paired:{keys}});
  const source=await openWorkspaceHouseholdRuntime({storage,resolved:original.resolved,pin,provider,sodium,keys,signing,LoroDoc,decodeImportBlobMeta});
  const full=await observePolicyDocumentSet(source);
  const proof={storage,scope,pin,provider,LoroDoc,signed:full.signed,retained:full.sources.map(x=>({documentId:x.runtime.scope.documentId,revision:x.revision,bytes:x.bytes??new Uint8Array()}))};
  const subject=await policyDocumentSetSubject(proof),parent=(await verifyPolicyDocumentSet(proof)).selected;
  const event={version:6,kind:'changePolicy',authorDeviceId:workspace.deviceId,householdId:scope.id,parentHead:parent.head,epochId:parent.epochId,generation:parent.generation,subject,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',policyHash:parent.policyHash,proposalId:'native-policy',frozenAdultRoster:parent.roster,nextPolicy:parent.policy};
  const targetHead=sodium.to_hex(await provider.hash(domain('event',event))),author=parent.devices.find(d=>d.deviceId===workspace.deviceId);
  const sign=async(kind,value)=>sodium.to_hex(await provider.sign(author.signingKeyRef,domain(kind,value)));
  const vote={version:1,householdId:scope.id,eventHash:targetHead,parentHead:parent.head,policyHash:parent.policyHash,generation:parent.generation,epochId:parent.epochId,adultId:author.adultId,deviceId:workspace.deviceId};
  const item={event,authorSignature:await sign('event-signature',event),approvals:[{...vote,signature:await sign('approval-signature',vote)}]};
  await stageVerifiedPolicyDocumentSet({runtime:source,item,signed:full.signed});
  const expected=(await storage.readPairingAuthority(scope)).value;
  assert.deepEqual(await workspace.policyBranches.reviewStaged(targetHead),{sourceHead:expected.acceptedParent,sourceRevision:expected.revision,targetHead});
  const confirmation={expectedSourceHead:expected.acceptedParent,expectedSourceRevision:expected.revision,targetHead,explicit:true};
  await assert.rejects(()=>workspace.policyBranches.activate({...confirmation,expectedSourceHead:'wrong'}));
  await assert.rejects(()=>workspace.policyBranches.activate({...confirmation,explicit:false}),/INVALID_CONFIRMATION/);
  await workspace.policyBranches.activate(confirmation);
  workspace.close();workspace=undefined;
  workspace=await openNativeWorkspaceWith({...options,create:false});
  assert.equal(workspace.readOnly,true);
  assert.deepEqual(await workspace.householdContent.readCooking(),before);
  assert.equal((await workspace.householdContent.readRecipe('soup')).doc.getMap('recipe:soup').get('title'),'Soup');
  assert.equal((await workspace.personal.document()).doc.getMap('personal-preferences').get('systemPrompt'),'Stockholm');
  const checkDb=openDatabase(name),checkStorage=openSQLiteStorage(checkDb);
  try {
   assert.deepEqual(await checkStorage.reopenDocument(scope.id,runtime.scope.documentId),originalRoot);
   assert.deepEqual(await checkStorage.reopenDocument(personalScope.scopeId,personalScope.documentId),originalPersonal);
  } finally {checkDb.close()}
  await assert.rejects(()=>workspace.householdContent.readRecipe('unknown'),/INVALID_RECIPE_DOCUMENT/);
  assert.throws(()=>workspace.householdContent.execute('no',[]),/READ_ONLY_WORKSPACE/);
  await assert.rejects(()=>workspace.disclosure.active(),/READ_ONLY_WORKSPACE/);
  await assert.rejects(()=>workspace.cookingFiles.list(),/READ_ONLY_WORKSPACE/);
  const review=await workspace.policyBranches.reviewReturn();
  assert.equal(review.sourceHead,expected.acceptedParent);
  assert.equal(review.targetHead,targetHead);
  const confirmationReturn={expectedSourceHead:review.sourceHead,expectedTargetHead:review.targetHead,expectedTargetRevision:review.targetRevision,explicit:true};
  await assert.rejects(()=>workspace.policyBranches.returnToSource({...confirmationReturn,expectedSourceHead:'wrong'}));
  await assert.rejects(()=>workspace.policyBranches.returnToSource({...confirmationReturn,explicit:false}),/INVALID_CONFIRMATION/);
  assert.deepEqual(await workspace.policyBranches.returnToSource(confirmationReturn),{sourceHead:expected.acceptedParent});
  workspace.close();workspace=undefined;
  workspace=await openNativeWorkspaceWith({...options,create:false});
  assert.equal(workspace.readOnly,true);
  assert.deepEqual(await workspace.householdContent.readCooking(),before);
  assert.equal((await workspace.householdContent.readRecipe('soup')).doc.getMap('recipe:soup').get('title'),'Soup');
  assert.equal((await workspace.personal.document()).doc.getMap('personal-preferences').get('systemPrompt'),'Stockholm');
  assert.throws(()=>workspace.householdContent.execute('no',[]),/READ_ONLY_WORKSPACE/);
  workspace.close();workspace=undefined;
  const damaged=new DatabaseSync(join(dir,`${name}.sqlite`));
  try {damaged.prepare('DELETE FROM loro_records WHERE key=?').run(JSON.stringify(['policy-set-activation',scope.id,targetHead]));}
  finally {damaged.close()}
  await assert.rejects(()=>openNativeWorkspaceWith({...options,create:false}),/ACTIVATION_NOT_FOUND|INVALID_AUTHORITY|UNSUPPORTED_VERSION/);
 } finally {workspace?.close();removeWorkspace(name);masters.delete(keyname(name,'workspace-master'))}
});

function directPair() {
 const channels = [new EventTarget(), new EventTarget()];
 const sdp = type => [
  'v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  `a=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}`,
  `a=ice-ufrag:${type}`, 'a=ice-pwd:fixture', ''
 ].join('\r\n');
 return channels.map((channel,index) => {
  Object.assign(channel, {
   readyState:'open', bufferedAmount:0,
   send(bytes) {
    const wire = Uint8Array.from(bytes).buffer;
    channels[1-index].dispatchEvent(new MessageEvent('message',{data:wire}));
   },
   close() { this.readyState='closed'; }
  });
  return options => cookingDirect({...options,createPeerConnection:() => Object.assign(new EventTarget(), {
   signalingState:'stable',iceGatheringState:'complete',
   createDataChannel:() => channel, close() {},
   createOffer:() => ({type:'offer',sdp:sdp('offer')}),
   createAnswer:() => ({type:'answer',sdp:sdp('answer')}),
   setLocalDescription(value) { this.localDescription=this.currentLocalDescription=value; },
   setRemoteDescription(value) { this.currentRemoteDescription=value; }
  })});
 });
}

test('fresh native workspaces use signed admission, durable selection and guarded direct imports', {timeout:25_000}, async () => {
 const organizerName = 'native-invitation-organizer', recipientName = 'native-invitation-recipient';
 const nativeReportCrypto={randomUUID,sha256:async bytes=>createHash('sha256').update(bytes).digest('hex')};
 let organizer, recipient, failEnrollment = false, afterReservation, beforeSelectionDecode, nativeDirect;
 const pairingPath = join(dir,`${recipientName}-pairing.sqlite`);
 const recipientPath = join(dir,`${recipientName}.sqlite`);
 const openRecipient = create => openNativeWorkspaceWith({
  ...args(recipientName,create),...nativeReportCrypto,openDirect:nativeDirect,
  openDatabase(name) {
   if (failEnrollment && name.startsWith(`${recipientName}-receive-`)) throw Error('COUNTER_OPEN_FAILED');
   const db = openDatabase(name);
   return {...db,executeSync(sql, params) {
    const result = db.executeSync(sql,params);
    if (sql.startsWith('INSERT INTO loro_sequence_allocations')) afterReservation?.();
    return result;
   }};
  },
  openMaster(name) {
   const master = openMaster(name);
   return {...master, async unwrap(id, bytes, aad) {
    if (new TextDecoder().decode(aad) === 'creative-cooking/selected-household/v1') await beforeSelectionDecode?.();
    return master.unwrap(id,bytes,aad);
   }};
  }
 });
 try {
  organizer = await openNativeWorkspaceWith(args(organizerName,true));
  recipient = await openRecipient(true);
  await acceptPolicy(organizer);
  await acceptPolicy(recipient);
  const scope = scopeOf(organizer), originalScope = scopeOf(recipient);
  await addPantry(organizer, 'seed-leek');
  const sponsor = organizer.householdPairing;
  const identity = recipient.householdPairing.identity;
  const delegation = await sponsor.prepareDelegation({explicit:true});
  const {item,eventHash} = await sponsor.prepareInvite({recipient:identity,explicit:true});
  await sponsor.acceptDelegation({agreement:{...delegation.agreement,acceptances:[delegation.acceptance]},explicit:true});
  const {grant,manifest,seed,policyBundle} = await sponsor.prepareGrant({item,explicit:true});
  const ceremony = await sponsor.prepareCeremony({item,grant,manifest,seed,explicit:true});
  const parent = await sponsor.exportParent();
  const offer = {scope,item,grant,ceremony};
  await assert.rejects(recipient.householdPairing.verifyOffer({offer,confirmedHash:ceremony.oob.hash}));
  await recipient.householdPairing.acceptParent({bundle:parent,confirmedRootPin:parent.rootPin,confirmedSelectedHead:parent.selectedHead,explicit:true});
  const verified = await recipient.householdPairing.verifyOffer({offer,confirmedHash:ceremony.oob.hash});
  const initiator = sponsor.session({...ceremony,role:'initiator',confirmedHash:ceremony.oob.hash});
  let responder = recipient.householdPairing.session({...verified,role:'responder',confirmedHash:ceremony.oob.hash});
  const [offerA,offerB] = await Promise.all([initiator.initialize(),responder.initialize()]);
  const [responseA,responseB] = await Promise.all([initiator.respond(offerB,0),responder.respond(offerA,0)]);
  recipient.close();
  recipient = await openRecipient(false);
  responder = recipient.householdPairing.session({...verified,role:'responder',confirmedHash:ceremony.oob.hash});
  assert.deepEqual((await responder.outgoing()).response,responseB);
  const [ackA,ackB] = await Promise.all([initiator.acknowledge(responseB,1),responder.acknowledge(responseA,1)]);
  await Promise.all([initiator.finish(ackB,2),responder.finish(ackA,2)]);

  const selectionBody = {
   root:parent.rootPin,householdId:scope.id,from:item.event.parentHead,to:eventHash,
   deviceId:organizer.deviceId,index:parent.state.selections.length
  };
  const {root,householdId,...selection} = selectionBody;
  selection.signature = sodium.to_hex(await organizer.disclosureProvider.sign(sponsor.identity.signingKey,domain('select-head',selectionBody)));
  const evidence = await initiator.evidence();
  const {operationId} = await sponsor.transfer.publish({
   item,grant,manifest,seed,policyBundle,ceremonies:[{transcript:ceremony.transcript,guard:ceremony.guard,oob:ceremony.oob,context:ceremony.context,messages:evidence.messages}],
   existingCeremonies:[],selection
  });
  const bytes = await sponsor.transfer.seal({operationId,recipientDevice:recipient.deviceId});
  const beforeAdmissionPath = join(dir,`${recipientName}-before-admission.sqlite`);
  const beforeAdmission = new DatabaseSync(recipientPath);
  try { beforeAdmission.prepare('VACUUM INTO ?').run(beforeAdmissionPath); }
  finally { beforeAdmission.close(); }
  assert.ok(bytes.length > 48);
  const damaged = new Uint8Array(bytes);
  damaged[damaged.length-1] ^= 1;
  await assert.rejects(recipient.householdPairing.transfer.install({scope,bytes:damaged}),/INVALID_FILE/);
  assert.equal(await recipient.householdPairing.selection.available(scope),false);
  failEnrollment = true;
  await assert.rejects(recipient.householdPairing.transfer.install({scope,bytes}),/COUNTER_OPEN_FAILED/);
  await assert.rejects(recipient.householdPairing.selection.select(scope),/INCOMPLETE_ENROLLMENT/);
  assert.deepEqual(scopeOf(recipient),originalScope);

  recipient.close();
  failEnrollment = false;
  recipient = await openRecipient(false);
  let notified = false;
  recipient.householdPairing.onInstalled(() => { throw Error('STALE_LISTENER'); });
  recipient.householdPairing.onInstalled(() => { notified = true; });
  const result = await recipient.householdPairing.transfer.install({scope,bytes});
  assert.equal(result.replayed,true);
  assert.equal(notified,true);
  assert.equal(await recipient.householdPairing.selection.available(scope),true);
  await recipient.householdPairing.selection.select(scope);
  await assert.rejects(addPantry(recipient,'stale-original-write'),/HOUSEHOLD_SELECTION_CHANGED/);
  await assert.rejects(recipient.cookingFiles.list(),/HOUSEHOLD_SELECTION_CHANGED/);
  await assert.rejects(recipient.householdPairing.exportParent(),/HOUSEHOLD_SELECTION_CHANGED/);
  assert.throws(()=>recipient.sequences.reserve(originalScope.id,'unguarded-reservation'),/INVALID_AUTHORITY/);
  recipient.close();
  organizer.close();
  const [organizerDirect,recipientDirect] = directPair();
  nativeDirect = recipientDirect;
  recipient = await openRecipient(false);
  organizer = await openNativeWorkspaceWith({...args(organizerName,false),...nativeReportCrypto,openDirect:organizerDirect});
  assert.equal(recipient.household.scope.branchHead,organizer.household.scope.branchHead);
  assert.deepEqual(await pantry(recipient),['seed-leek']);
  assert.equal(recipient.needsDisclosureSetup,false);

  await Promise.all([addPantry(organizer,'offline-fennel'),addPantry(recipient,'offline-mint')]);
  const aReady = Promise.withResolvers(), bReady = Promise.withResolvers();
  let pendingSave = true;
  const initiatorConnection = organizer.direct.connect({notify:status=>{if(status.ready)aReady.resolve();}});
  const responderConnection = recipient.direct.connect({
   notify:status=>{if(status.ready)bReady.resolve();},
   async prepareImport() {
    if (pendingSave) throw Error('SAVING');
    await recipient.household.document(); // Acquires the same native selection lock.
    return {release(){},refresh:()=>recipient.household.document()};
   }
  });
  try {
   const directOffer = await initiatorConnection.createOffer(recipient.deviceId);
   const directAnswer = await responderConnection.createAnswer(directOffer);
   assert.equal(await initiatorConnection.acceptAnswer(directAnswer.text),directAnswer.code);
   await initiatorConnection.confirm(directAnswer.code);
   await responderConnection.confirm(directAnswer.code);
   await Promise.all([aReady.promise,bReady.promise]);
   assert.equal((await initiatorConnection.send()).retry,1);
   assert.equal((await recipient.cookingFiles.pending()).length,1);
   pendingSave = false;
   assert.equal((await initiatorConnection.send()).retry,0);
   assert.equal((await recipient.cookingFiles.pending()).length,0);
  } finally {
   initiatorConnection.close();
   responderConnection.close();
   nativeDirect = undefined;
  }
  for (const [sender,receiver] of [[organizer,recipient],[recipient,organizer]]) {
   const [{objectId}] = await sender.cookingFiles.list();
   await receiver.cookingFiles.receive(await sender.cookingFiles.download(objectId));
  }
  assert.deepEqual(await pantry(recipient),['offline-fennel','offline-mint','seed-leek']);
  assert.deepEqual(await pantry(organizer),await pantry(recipient));

  const signer=organizer.householdCompromise, verifier=recipient.householdCompromise;
  const sourceToken=(await signer.open()).confirmation, targetToken=(await verifier.open()).confirmation;
  const draft=await signer.prepare(sourceToken,recipient.deviceId);
  assert.equal(draft.checkpoint,'Verified household projection checkpoint');
  const reviewId=await signer.sign(draft,{kind:'checkpoint'});
  let reportFile;
  await signer.share(sourceToken,reviewId,async file=>{reportFile=file;});
  assert.deepEqual(await verifier.receive(targetToken,reportFile),{reviewId,replayed:false});
  const frozen=await verifier.inspect(targetToken,reviewId);
  assert.equal(frozen.checkpointLabel,'Verified household projection checkpoint');
  assert.equal(frozen.rows.filter(row=>row.category==='suspect').length,1);
  const kept=frozen.rows.filter(row=>row.category!=='suspect').map(row=>row.effectId);
  const clean=await verifier.saveCleanDraft(frozen,kept);
  assert.equal(clean.draft.included.length,1);
  assert.equal(clean.draft.excluded.length,1);
  assert.equal(clean.draft.held.length,0);
  assert.equal(clean.draft.pantry.length,2);
  assert.ok(clean.draft.pantry.includes('seed-leek'));
  assert.deepEqual(await pantry(organizer),await pantry(recipient));
  const deviceId = recipient.deviceId;
  const joined = houseCounterName(recipientName,scope,deviceId);

  // A concurrent switch cannot overtake an action after its sequence allocation.
  let clearing;
  afterReservation = () => {
   afterReservation = undefined;
   clearing = recipient.householdPairing.selection.clear().then(() => {
    const db = new DatabaseSync(recipientPath);
    try {
     return !!db.prepare('SELECT value FROM loro_records WHERE key=?').get(
      JSON.stringify(['local',scope.id,'finish-before-switch']));
    } finally { db.close(); }
   });
  };
  await addPantry(recipient,'finish-before-switch');
  assert.equal(await clearing,true);
  await assert.rejects(addPantry(recipient,'stale-joined-write'),/HOUSEHOLD_SELECTION_CHANGED/);
  recipient.close();
  recipient = await openRecipient(false);
  assert.deepEqual(scopeOf(recipient),originalScope);
  assert.deepEqual(await pantry(recipient),[]);
  assert.equal(recipient.deviceId,deviceId);
  const original = recipient.householdPairing.selection;
  await original.select(scope);

  // Opening the selection must finish authenticating it before a switch clears it.
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  beforeSelectionDecode = async () => { entered.resolve(); await release.promise; };
  const opening = openRecipient(false).then(
   workspace => workspace.close(),
   error => assert.match(error.message,/HOUSEHOLD_SELECTION_CHANGED/)
  );
  await entered.promise;
  let cleared = false;
  const switchBack = original.clear().then(() => { cleared = true; });
  try {
   await new Promise(resolve => setImmediate(resolve));
   assert.equal(cleared,false);
  } finally { release.resolve(); beforeSelectionDecode = undefined; }
  await opening;
  await switchBack;
  await original.select(scope);
  recipient.close();
  recipient = null;

  // Losing only the companion database must keep the workspace locked on reopen.
  const oldPairing = new DatabaseSync(pairingPath);
  const pairRows = oldPairing.prepare('SELECT key,value FROM loro_records').all();
  oldPairing.close();
  rmSync(pairingPath);
  await assert.rejects(openRecipient(false),/CONFIRMATION_REQUIRED/);
  await returnToOriginalNativeWorkspaceWith(args(recipientName,false));
  recipient = await openRecipient(false);
  assert.deepEqual(scopeOf(recipient),originalScope);
  assert.deepEqual(await pantry(recipient),[]);
  assert.equal(recipient.deviceId,deviceId);
  recipient.close();
  recipient = null;

  const restored = new DatabaseSync(pairingPath);
  const put = restored.prepare('INSERT INTO loro_records (key,value) VALUES (?,?)');
  for (const row of pairRows) put.run(row.key,row.value);
  const main = new DatabaseSync(recipientPath);
  const enrollmentKey = JSON.stringify(['native-household-enrollment',scope.id]);
  const {value} = main.prepare('SELECT value FROM loro_records WHERE key=?').get(enrollmentKey);
  assert.equal(JSON.parse(value).stage,'active');
  put.run(JSON.stringify(['enrollment',scope.id]),JSON.stringify({...JSON.parse(value),stage:'pending'}));
  main.prepare('DELETE FROM loro_records WHERE key IN (?,?,?)').run(
   enrollmentKey,'["native-household-selection"]','["native-household-selection-required"]');
  main.close();
  restored.close();
  await assert.rejects(openRecipient(false),/LEGACY_HOUSEHOLD_SELECTION/);
  await returnToOriginalNativeWorkspaceWith(args(recipientName,false));
  recipient = await openRecipient(false);
  await assert.rejects(recipient.householdPairing.selection.select(scope),/INCOMPLETE_ENROLLMENT/);
  const pendingOnly = new DatabaseSync(recipientPath);
  try {
   assert.equal(pendingOnly.prepare('SELECT value FROM loro_records WHERE key=?').get(enrollmentKey),undefined);
  } finally { pendingOnly.close(); }
  const legacyActive = new DatabaseSync(pairingPath);
  try {
   legacyActive.prepare('UPDATE loro_records SET value=? WHERE key=?').run(value,JSON.stringify(['enrollment',scope.id]));
  } finally { legacyActive.close(); }
  await recipient.householdPairing.selection.select(scope);
  recipient.close();
  recipient = await openRecipient(false);
  assert.deepEqual(await pantry(recipient),['finish-before-switch','offline-fennel','offline-mint','seed-leek']);
  recipient.close();
  recipient = null;

  // Restoring the old pending pairing row must not allow a used counter to restart.
  const counterPath = join(dir,`${joined}.sqlite`);
  rmSync(counterPath);
  await assert.rejects(openRecipient(false),/MISSING_SEQUENCES/);
  await returnToOriginalNativeWorkspaceWith(args(recipientName,false));
  recipient = await openRecipient(false);
  await assert.rejects(recipient.householdPairing.transfer.install({scope,bytes}),/MISSING_SEQUENCES/);
  const counter = new DatabaseSync(counterPath);
  assert.deepEqual(counter.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),[]);
  counter.close();

  // Roll back the main database past the receipt, retaining the legacy active marker.
  recipient.close();
  recipient = null;
  copyFileSync(beforeAdmissionPath,recipientPath);
  rmSync(counterPath);
  const legacy = new DatabaseSync(pairingPath);
  try {
   legacy.prepare('UPDATE loro_records SET value=? WHERE key=?').run(value,JSON.stringify(['enrollment',scope.id]));
  } finally { legacy.close(); }
  await returnToOriginalNativeWorkspaceWith(args(recipientName,false));
  recipient = await openRecipient(false);
  await assert.rejects(recipient.householdPairing.transfer.install({scope,bytes}),/MISSING_ADMISSION/);
  assert.equal(existsSync(counterPath),false);
  const rolledBack = new DatabaseSync(recipientPath);
  try { assert.equal(rolledBack.prepare('SELECT value FROM loro_records WHERE key=?').get(enrollmentKey),undefined); }
  finally { rolledBack.close(); }

 } finally {
  organizer?.close();
  recipient?.close();
  removeWorkspace(organizerName);
  removeWorkspace(recipientName);
 }
});

function houseCounterName(name, scope, deviceId) {
 return `${name}-${householdReceiverIds(sodium,scope,deviceId).operationId}`;
}

test('return to original requires an established workspace and creates no identity', async () => {
 const name = 'native-return-missing';
 try {
  await assert.rejects(returnToOriginalNativeWorkspaceWith(args(name,false)),/MISSING_BOOTSTRAP/);
  const db = new DatabaseSync(join(dir,`${name}.sqlite`));
  try {
   assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),[]);
   assert.equal(masters.has(keyname(name,'workspace-master')),false);
  } finally { db.close(); }
 } finally { removeWorkspace(name); }
});

test('native bootstrap reopens and saves the rotated personal generation in SQLite',async()=>{
 const name='native-personal-rotation';
 const options={...args(name,true),randomUUID};
 let workspace;
 const command=(id,city)=>({version:1,kind:'personal-preference-put',commandId:id,effectId:id,
  dependencyEffectIds:[],data:{key:'city',value:city}});
 try{
  workspace=await openNativeWorkspaceWith(options);
  const original=workspace.personal.scope;
  const house=workspace.household.scope;
  await executeAction(workspace.personal,workspace.sequences,'old-city',[command('old-city','Before rotation')]);
  const review=await workspace.personalRotation.review();
  const result=await workspace.personalRotation.publish(review,[]);
  await assert.rejects(()=>workspace.personal.authorize(),/INVALID_AUTHORITY/);
  workspace.close();workspace=null;
  workspace=await openNativeWorkspaceWith({...options,create:false});
  assert.equal(workspace.personal.scope.branchHead,result.head);
  assert.notEqual(workspace.personal.scope.epochId,original.epochId);
  assert.notEqual(workspace.personal.scope.documentId,original.documentId);
  assert.equal(workspace.household.scope.branchHead,house.branchHead);
  assert.equal((await workspace.personal.document()).doc.getMap('personal-preferences').get('city'),'Before rotation');
  await executeAction(workspace.personal,workspace.sequences,'new-city',[command('new-city','After rotation')]);
  workspace.close();workspace=null;
  workspace=await openNativeWorkspaceWith({...options,create:false});
  assert.equal((await workspace.personal.document()).doc.getMap('personal-preferences').get('city'),'After rotation');
 }finally{workspace?.close();removeWorkspace(name)}
});

test('native bootstrap pairs fresh personal devices across signed v1, v2 and v3 history in SQLite',async()=>{
 const {openSQLiteStorage}=await import('../storage/sqlite.ts');
 const {parsePairingText,pairingText,openPersonalCopy,sealPersonalCopy}=await import('../pairing/personal-copy.mjs');
 const {resolvePersonalAuthority}=await import('../authority/personal.mjs');
 const names=['native-personal-pair-source','native-personal-pair-target','native-personal-pair-third','native-personal-pair-fourth'];
 const workspaces=[], controllers=names.map(()=>({count:0,fail:0}));
 const boot=async(i,create=false)=>{
  const name=names[i],control=controllers[i];
  workspaces[i]?.close();workspaces[i]=null;
  workspaces[i]=await openNativeWorkspaceWith({...args(name,create),randomUUID,openDatabase:n=>{
   const db=openDatabase(n);
   if(n===name+'-pairing')return {...db,executeSync(sql,params){
    if(sql==='BEGIN IMMEDIATE')control.beforePairingWrite?.(db);
    return db.executeSync(sql,params);
   }};
   if(n!==name)return db;
   return {...db,executeSync(sql,params){
    if(sql.startsWith('INSERT INTO loro_records')){
     if(++control.count===control.fail)throw Error('injected SQLite write failure');
    }
    return db.executeSync(sql,params);
   }};
  }});
  return workspaces[i];
 };
 const database=(i,fn)=>{
  const db=openDatabase(names[i]);
  try{return fn(db)}finally{db.close()}
 };
 const rows=i=>database(i,db=>db.executeSync('SELECT key,value FROM loro_records ORDER BY key').rows);
 const preference=(id,value)=>({version:1,kind:'personal-preference-put',commandId:id,effectId:id,dependencyEffectIds:[],
  data:{key:'city',value}});
 const save=(workspace,id,value)=>executeAction(workspace.personal,workspace.sequences,id,[preference(id,value)]);
 const saved=async workspace=>(await workspace.personal.document()).doc.getMap('personal-preferences').get('city');
 const scopeOf=i=>({kind:'personal',id:workspaces[i].personal.scope.scopeId});
 const getAuthority=i=>workspaces[i].personal.storage.readPairingAuthority(scopeOf(i)).then(result=>result.value);
 const progress=async(i,j)=>{
  const a=workspaces[i].personalPairing,b=workspaces[j].personalPairing,request=await b.request();
  await assert.rejects(a.propose(request,'0'.repeat(64)),/OOB_REQUIRED/);
  const proposal=await a.propose(request,b.fingerprint),review=await b.inspect(proposal.text);
  assert.equal(review.code,proposal.code);
  await assert.rejects(b.confirm('responder',proposal.text,a.fingerprint,b.rootPin,review.code),/OOB_REQUIRED/);
  const offer=await a.confirm('initiator',proposal.text,b.fingerprint,a.rootPin,proposal.code);
  let message=await b.confirm('responder',proposal.text,a.fingerprint,a.rootPin,review.code);
  assert.equal(offer.complete,false);
  await assert.rejects(a.publish(proposal.code),/INCOMPLETE/);
  for(const [role,number] of [['initiator',i],['responder',j],['initiator',i],['responder',j],['initiator',i]]){
   message=await workspaces[number].personalPairing.accept(role,message.text);
  }
  assert.equal(message.complete,true);
  return proposal;
 };
 const deviceKeys=async(i,purpose,use)=>{
  const op='device-'+purpose,query='SELECT value FROM loro_records WHERE key=?';
  const stored=JSON.parse(database(i,db=>db.executeSync(query,[JSON.stringify(['local-key-operation',op])]).rows[0].value));
  return workspaces[i].personal.storage.localKeys(openMaster(names[i]),sodium).use(op,stored.identity,use);
 };
 try {
  for(let i=0;i<names.length;i++)await boot(i,true);
  const original=[workspaces[1].personal.scope.scopeId,workspaces[1].household.scope.scopeId];
  const first=workspaces[0].personal.scope;
  await save(workspaces[0],'before-pair','Source city');
  await save(workspaces[1],'original-receiver','Original city');
  const receiver=workspaces[1].personalPairing,sponsor=workspaces[0].personalPairing;
  const obsolete=await sponsor.propose(await receiver.request(true),receiver.fingerprint);
  const recipientStorage=workspaces[1].personal.storage;
  const readSelection=recipientStorage.readPersonalSelection.bind(recipientStorage);
  recipientStorage.readPersonalSelection=async (...params)=>{
   await receiver.request(true);
   return readSelection(...params);
  };
  try{
   await assert.rejects(()=>receiver.confirm('responder',obsolete.text,sponsor.fingerprint,sponsor.rootPin,obsolete.code),/CONFLICT/);
   assert.equal(await receiver.resume('responder'),null);
  }finally{recipientStorage.readPersonalSelection=readSelection;}
  const candidate=await sponsor.propose(await receiver.request(),receiver.fingerprint);
  await receiver.confirm('responder',candidate.text,sponsor.fingerprint,sponsor.rootPin,candidate.code);
  const candidateOffer=await sponsor.confirm('initiator',candidate.text,receiver.fingerprint,sponsor.rootPin,candidate.code);
  const pairingDb=openDatabase(names[1]+'-pairing'),ceremonyKey='["ceremony"]';
  const readCeremony=()=>JSON.parse(pairingDb.executeSync('SELECT value FROM loro_records WHERE key=?',[ceremonyKey]).rows[0].value);
  try{
   const responderSlot='personal-device-pairing/v1:responder',confirmed=readCeremony(),previous=confirmed[responderSlot];
   await receiver.request(true);
   const renewed=readCeremony();
   const writeCeremony=(db,state)=>db.executeSync('UPDATE loro_records SET value=? WHERE key=?',[JSON.stringify(state),ceremonyKey]);
   writeCeremony(pairingDb,confirmed);
   let writes=0;
   controllers[1].beforePairingWrite=db=>{
    // The competing renewal commits after initialization and before response.
    if(++writes===2)writeCeremony(db,renewed);
   };
   try{await assert.rejects(()=>receiver.accept('responder',candidateOffer.text),/CONFLICT|OOB_REQUIRED/);}
   finally{controllers[1].beforePairingWrite=null;}
   assert.equal(writes,2);
   const sessionKey='session:'+parsePairingText(sodium,candidate.text).transcript.sessionId;
   assert.equal(readCeremony()[sessionKey].revision,renewed[sessionKey].revision);
   assert.deepEqual(readCeremony(),renewed);
   // Model an older interrupted writer leaving a confirmation for a replaced request.
   const staleCeremony={...readCeremony(),[responderSlot]:previous};
   writeCeremony(pairingDb,staleCeremony);
   await assert.rejects(()=>receiver.resume('responder'),/CONFLICT/);
   assert.deepEqual(readCeremony(),staleCeremony);
   await receiver.request(true);
  }finally{pairingDb.close();}
  const firstPeer=await progress(0,1);
  await progress(0,2);
  const beforeObsoletePublish=rows(0);
  await assert.rejects(()=>sponsor.publish(firstPeer.code),/CONFLICT/);
  assert.deepEqual(rows(0),beforeObsoletePublish);
  await receiver.request(true);
  await workspaces[2].personalPairing.request(true);
  // The full settings service resumes against real SQLite after re-open.
  const proposal=await progress(0,1);
  await boot(0);await boot(1);
  assert.equal((await workspaces[0].personalPairing.resume('initiator')).progress.complete,true);
  const sponsorBefore=rows(0),receiverBefore=rows(1);
  const current=await getAuthority(0);
  const stale={...current,revision:current.revision+1};
  assert.equal((await workspaces[0].personal.storage.compareAndSwapPairingAuthority({expectedRevision:current.revision,record:stale})).ok,true);
  await assert.rejects(workspaces[0].personalPairing.publish(proposal.code),/CONFLICT/);
  const originalAuthority=sponsorBefore.find(row=>row.key===JSON.stringify(['pairing-authority','personal',first.scopeId]));
  database(0,db=>db.executeSync('UPDATE loro_records SET value=? WHERE key=?',[originalAuthority.value,originalAuthority.key]));
  // Change the durable document between reading it and entering publication.
  const update=await workspaces[0].personal.prepare({operationId:'racing-write',deviceSequence:42,command:preference('race','Later city')});
  const rawWrite=workspaces[0].personal.storage.commitPersonalAdmissionRelease.bind(workspaces[0].personal.storage);
  workspaces[0].personal.storage.commitPersonalAdmissionRelease=async(...values)=>{
   assert.equal((await workspaces[0].personal.storage.commitLocal(update.commit)).ok,true);
   return rawWrite(...values);
  };
  await assert.rejects(workspaces[0].personalPairing.publish(proposal.code),/CONFLICT/);
  workspaces[0].personal.storage.commitPersonalAdmissionRelease=rawWrite;
  const afterRace=rows(0);
  assert.equal(afterRace.some(row=>JSON.parse(row.key)[0]==='personal-pairing-file'),false);
  for(let fault=1;fault<=7;fault++){
   controllers[0].fail=fault;controllers[0].count=0;
   await assert.rejects(workspaces[0].personalPairing.publish(proposal.code),/IO/);
   assert.equal(controllers[0].count,fault);assert.deepEqual(rows(0),afterRace);
  }
  controllers[0].fail=0;
  const release=await workspaces[0].personalPairing.publish(proposal.code);
  await boot(0);
  assert.deepEqual((await workspaces[0].personalPairing.publish(proposal.code)).file,release.file);

  const installPairingDb=openDatabase(names[1]+'-pairing');
  const savedCeremony=()=>installPairingDb.executeSync('SELECT value FROM loro_records WHERE key=?',[ceremonyKey]).rows[0].value;
  const restoreCeremony=(db,state)=>db.executeSync('UPDATE loro_records SET value=? WHERE key=?',[state,ceremonyKey]);
  const completedCeremony=savedCeremony();
  try{
   await workspaces[1].personalPairing.request(true);
   const renewedCeremony=savedCeremony();
   restoreCeremony(installPairingDb,completedCeremony);
   controllers[1].beforePairingWrite=db=>restoreCeremony(db,renewedCeremony);
   await assert.rejects(()=>workspaces[1].personalPairing.install(release.file),/CONFLICT/);
   assert.equal(savedCeremony(),renewedCeremony);
   assert.deepEqual(rows(1),receiverBefore);
  }finally{
   controllers[1].beforePairingWrite=null;
   restoreCeremony(installPairingDb,completedCeremony);
   installPairingDb.close();
  }

  const publicProposal=parsePairingText(sodium,proposal.text);
  const {transcript}=publicProposal;
  const content=await deviceKeys(1,'wrapping',secret=>openPersonalCopy(sodium,release.file,proposal.code,transcript,secret));
  assert.equal(content.document.revision,1);
  assert.ok(content.document.frontier.length);
  const wrongRoot=await getAuthority(2);
  for(const mutate of [
   bad=>{bad.parent=wrongRoot},
   bad=>{bad.document.documentId=first.epochId},
   bad=>{bad.document.epochId=workspaces[2].personal.scope.epochId},
   bad=>{bad.document.revision=-1},
   bad=>{bad.document.frontier=[]},
   bad=>{bad.envelope.admission.admission.ownerId=workspaces[2].personal.scope.ownerId},
   bad=>{bad.envelope.admission.admission.recipientWrappingKey='1'.repeat(64)}
  ]){
   const bad=structuredClone(content);mutate(bad);
   const file=await deviceKeys(0,'signing',secret=>sealPersonalCopy(sodium,proposal.code,transcript.responder,secret,bad));
   await assert.rejects(workspaces[1].personalPairing.install(file));
   assert.deepEqual(rows(1),receiverBefore);
  }
  const wrongRecipient=parsePairingText(sodium,await workspaces[2].personalPairing.request()).request;
  const differentWrappingKey=await deviceKeys(0,'signing',secret=>sealPersonalCopy(sodium,proposal.code,
   {...transcript.responder,wrappingPublicKey:sodium.from_hex(wrongRecipient.wrappingKey)},secret,content));
  await assert.rejects(workspaces[1].personalPairing.install(differentWrappingKey));
  await assert.rejects(workspaces[2].personalPairing.inspect(pairingText(sodium,publicProposal)),/UNAUTHORIZED/);
  await assert.rejects(workspaces[2].personalPairing.install(release.file),/OOB_REQUIRED/);
  assert.deepEqual(rows(1),receiverBefore);

  // Two prior commands produce four semantic-index writes. Probe every record
  // write, including the final authority write, on the real SQLite adapter.
  for(let fault=1;fault<=17;fault++){
   controllers[1].fail=fault;controllers[1].count=0;
   await assert.rejects(workspaces[1].personalPairing.install(release.file),/IO/);
   assert.equal(controllers[1].count,fault);assert.deepEqual(rows(1),receiverBefore);
  }
  controllers[1].fail=0;
  assert.equal((await workspaces[1].personalPairing.install(release.file)).replayed,false);
  const wrappedMaster=openMaster(names[1]),storage=workspaces[1].personal.storage;
  await storage.localKeys(wrappedMaster,sodium).useIdentity({version:1,scope:scopeOf(0),deviceId:workspaces[1].deviceId,
   purpose:'data',epochId:first.epochId},key=>workspaces[0].personal.storage.localKeys(openMaster(names[0]),sodium)
    .useIdentity({version:1,scope:scopeOf(0),deviceId:workspaces[0].deviceId,purpose:'data',epochId:first.epochId},
     originalKey=>assert.deepEqual(key,originalKey)));
  await boot(1);
  assert.equal(workspaces[1].household.scope.scopeId,original[1]);
  assert.equal(workspaces[1].personal.scope.epochId,first.epochId);
  assert.equal(workspaces[1].personal.scope.documentId,first.documentId);
  assert.equal(await saved(workspaces[1]),'Later city');
  assert.deepEqual(workspaces[1].household.scope.acceptedAuthors,[workspaces[1].deviceId]);
  const resolved=await resolvePersonalAuthority(workspaces[1].personal.storage,scopeOf(1),
   workspaces[1].personalPairing.rootPin,workspaces[1].disclosureProvider,workspaces[1].deviceId);
  assert.equal(resolved.scope.ownerId,first.ownerId);
  await assert.rejects(save(workspaces[1],'before-pair','Duplicate'),/CONFLICT/);
  await save(workspaces[1],'paired-save','Recipient edit');
  const afterEdit=rows(1);
  assert.equal((await workspaces[1].personalPairing.install(release.file)).replayed,true);
  assert.deepEqual(rows(1),afterEdit);
  assert.equal(await saved(workspaces[1]),'Recipient edit');

  // A newer revision with unrelated bytes cannot satisfy contained replay.
  const documentKey=JSON.stringify(['document',first.scopeId,first.documentId]);
  const savedDocument=afterEdit.find(row=>row.key===documentKey);
  const replacementDoc=new LoroDoc();
  replacementDoc.setPeerId('99');
  replacementDoc.getMap('personal-preferences').set('city','Unrelated history');
  const unrelated=JSON.parse(savedDocument.value);
  unrelated.revision++;
  unrelated.bytes.__storageBytes=Array.from(replacementDoc.export({mode:'snapshot'}));
  database(1,db=>db.executeSync('UPDATE loro_records SET value=? WHERE key=?',[JSON.stringify(unrelated),documentKey]));
  const unrelatedState=rows(1);
  await assert.rejects(workspaces[1].personalPairing.install(release.file));
  assert.deepEqual(rows(1),unrelatedState);
  database(1,db=>db.executeSync('UPDATE loro_records SET value=? WHERE key=?',[savedDocument.value,documentKey]));

  const secondProposal=await progress(1,2);
  const second=await workspaces[1].personalPairing.publish(secondProposal.code);
  await workspaces[2].personalPairing.install(second.file);
  await boot(1);await boot(2);
  assert.equal(JSON.parse(new TextDecoder().decode((await getAuthority(2)).authorityState)).version,2);
  await assert.rejects(workspaces[1].personalPairing.install(release.file),/UNAUTHORIZED|CONFLICT/);
  assert.equal(await saved(workspaces[2]),'Recipient edit');
  const pairedStorage=workspaces[1].personal.storage;
  const readPairingFile=pairedStorage.readPersonalPairingFile.bind(pairedStorage);
  let switched;
  pairedStorage.readPersonalPairingFile=async (...params)=>{
   await workspaces[1].personalPairing.returnToOriginal();
   switched=rows(1);
   return readPairingFile(...params);
  };
  try{
   await assert.rejects(workspaces[1].personalPairing.publish(secondProposal.code),/CONFLICT/);
   assert.ok(switched);
   assert.deepEqual(rows(1),switched);
  }finally{pairedStorage.readPersonalPairingFile=readPairingFile;}
  await boot(1);
  assert.equal(workspaces[1].personal.scope.scopeId,original[0]);
  assert.equal(await saved(workspaces[1]),'Original city');

  const {personalRotation}=workspaces[2];
  const reviewed=await personalRotation.review();
  await personalRotation.publish(reviewed,reviewed.devices.filter(id=>id!==workspaces[2].deviceId));
  await boot(2);
  const rotation=await getAuthority(2);
  const rotatedEpoch=workspaces[2].personal.scope.epochId;
  await workspaces[3].personalPairing.request();
  const thirdProposal=await progress(2,3);
  const third=await workspaces[2].personalPairing.publish(thirdProposal.code);
  await workspaces[3].personalPairing.install(third.file);
  await boot(3);
  const state=record=>JSON.parse(new TextDecoder().decode(record.authorityState));
  const history=state(await getAuthority(3)),prior=state(rotation);
  assert.equal(history.version,3);
  assert.deepEqual(history.base,prior.base);
  assert.deepEqual(history.events.slice(0,-1),prior.events);
  assert.equal(history.events.at(-1).admission.recipientDeviceId,workspaces[3].deviceId);
  assert.equal(workspaces[3].personal.scope.epochId,rotatedEpoch);
  assert.equal(await saved(workspaces[3]),'Recipient edit');
  await save(workspaces[3],'after-v3','New private edit');
  await boot(3);
  assert.equal(await saved(workspaces[3]),'New private edit');

  await workspaces[3].personalPairing.returnToOriginal();
  await boot(3);
  assert.equal((await workspaces[3].personal.document()).revision,null);
  await workspaces[1].personalPairing.request(true);
  const emptyProposal=await progress(3,1);
  const empty=await workspaces[3].personalPairing.publish(emptyProposal.code);
  await workspaces[1].personalPairing.install(empty.file);
  await boot(1);
  assert.equal((await workspaces[1].personal.document()).revision,null);
  await save(workspaces[1],'first-after-empty-copy','First saved edit');
  assert.equal((await workspaces[1].personalPairing.install(empty.file)).replayed,true);
  assert.equal(await saved(workspaces[1]),'First saved edit');
 }finally{
  for(const workspace of workspaces)workspace?.close();
  for(const name of names)removeWorkspace(name);
 }
});

async function ownDeviceScenario(prepareOnly=false,publishPrepared=false) {
 const names=['own-device-sponsor','own-device-adult','own-device-fresh'].map(name=>name+(publishPrepared?'-published':prepareOnly?'-prepared':''));
 const [sponsorName,adultName,freshName]=names;
 let sponsor, adult, fresh;
 let faultName='',faultWrite=0,writes=0,failCounter=false;
 const rawOpen=openDatabase;
 const open=(name,create=false)=>openNativeWorkspaceWith({
  ...args(name,create),policy:{kind:'unanimous',fixedCount:null},
  openDatabase(dbName){
   if(failCounter&&dbName.startsWith(freshName+'-receive-'))throw Error('COUNTER_OPEN_FAILED');
   const db=rawOpen(dbName);
   return {...db,executeSync(sql,params){
    const result=db.executeSync(sql,params);
    if(dbName===faultName&&sql.startsWith('INSERT INTO loro_records')&&++writes===faultWrite)throw Error('INJECTED');
    return result;
   }};
  }
 });
 const rows=name=>{
  const db=new DatabaseSync(join(dir,name+'.sqlite'));
  try{return db.prepare('SELECT key,value FROM loro_records ORDER BY key').all()}finally{db.close()}
 };
 try{
  sponsor=await open(sponsorName,true);
  adult=await open(adultName,true);
  fresh=await open(freshName,true);
  await Promise.all([sponsor,adult,fresh].map(acceptPolicy));
  await addPantry(sponsor,'shared-basil');
  await addPantry(fresh,'original-thyme');
  const s=sponsor.householdPairing,a=adult.householdPairing,scope=scopeOf(sponsor),original=scopeOf(fresh);
  const agreement=await s.prepareDelegation({explicit:true});
  await s.acceptDelegation({agreement:{...agreement.agreement,acceptances:[agreement.acceptance]},explicit:true});
  const {item,eventHash}=await s.prepareInvite({recipient:a.identity,explicit:true});
  const {grant,manifest,seed,policyBundle}=await s.prepareGrant({item,explicit:true});
  const ceremony=await s.prepareCeremony({item,grant,manifest,seed,explicit:true});
  const parent=await s.exportParent();
  await a.acceptParent({bundle:parent,confirmedRootPin:parent.rootPin,confirmedSelectedHead:parent.selectedHead,explicit:true});
  const verified=await a.verifyOffer({offer:{scope,item,grant,ceremony},confirmedHash:ceremony.oob.hash});
  const sessionA=s.session({...ceremony,role:'initiator',confirmedHash:ceremony.oob.hash});
  const sessionB=a.session({...verified,role:'responder',confirmedHash:ceremony.oob.hash});
  const offers=await Promise.all([sessionA.initialize(),sessionB.initialize()]);
  const responses=await Promise.all([sessionA.respond(offers[1],0),sessionB.respond(offers[0],0)]);
  const acks=await Promise.all([sessionA.acknowledge(responses[1],1),sessionB.acknowledge(responses[0],1)]);
  await Promise.all([sessionA.finish(acks[1],2),sessionB.finish(acks[0],2)]);
  const selection={from:parent.selectedHead,to:eventHash,deviceId:sponsor.deviceId,index:parent.state.selections.length};
  selection.signature=sodium.to_hex(await sponsor.disclosureProvider.sign(s.identity.signingKey,
   domain('select-head',{root:parent.rootPin,householdId:scope.id,...selection})));
  const {operationId}=await s.transfer.publish({item,grant,manifest,seed,policyBundle,
   ceremonies:[{transcript:ceremony.transcript,guard:ceremony.guard,oob:ceremony.oob,context:ceremony.context,messages:(await sessionA.evidence()).messages}],existingCeremonies:[],selection});
  const admission=await s.transfer.seal({operationId,recipientDevice:adult.deviceId});
  await a.transfer.install({scope,bytes:admission});
  await a.selection.select(scope);
  sponsor.close();adult.close();
  sponsor=await open(sponsorName);adult=await open(adultName);

  const rootPin=parent.rootPin, sponsorId=sponsor.deviceId;
  const provider={hash:async bytes=>sodium.crypto_generichash(32,bytes),
   verify:async (key,bytes,signature)=>sodium.crypto_sign_verify_detached(signature,bytes,sodium.from_hex(key))};
  const {openSQLiteStorage}=await import('../storage/sqlite.ts');
  const readStore=async(name,use)=>{
   const db=rawOpen(name);
   try{return await use(openSQLiteStorage(db))}finally{db.close()}
  };
  const {verifyAuthority,readAuthority}=await import('../authority/chain.mjs');
  const {validateSuccessor}=await import('../authority/validator.mjs');
  const getNode=name=>readStore(name,async storage=>{
   const view=await readAuthority(storage,scope,rootPin,provider);
   return (await verifyAuthority(view.state,rootPin,provider)).nodes.get(view.activeHead);
  });
  const before=await getNode(sponsorName);
  assert.equal(before.roster.length,2);
  assert.deepEqual(before.policy,{kind:'unanimous',fixedCount:null});
  const signApproval=async(node,eventId,workspace)=>{
   const identity=workspace.householdPairing.identity,body={version:1,householdId:scope.id,eventHash:eventId,parentHead:node.head,
    policyHash:node.policyHash,generation:node.generation,epochId:node.epochId,adultId:identity.adultId,deviceId:identity.deviceId};
   return {...body,signature:sodium.to_hex(await workspace.disclosureProvider.sign(identity.signingKey,domain('approval-signature',body)))};
  };
  async function vote(node,devices,expected){
   const event={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',householdId:scope.id,parentHead:node.head,
    policyHash:node.policyHash,generation:node.generation,epochId:node.epochId,proposalId:'vote-check',kind:'changePolicy',
    authorDeviceId:sponsorId,frozenAdultRoster:node.roster,subject:null,nextPolicy:{kind:'fixed',fixedCount:2}};
   const eventId=sodium.to_hex(await provider.hash(domain('event',event)));
   const signature=sodium.to_hex(await sponsor.disclosureProvider.sign(sponsor.householdPairing.identity.signingKey,domain('event-signature',event)));
   const approvals=await Promise.all(devices.map(device=>signApproval(node,eventId,device)));
   const result=await validateSuccessor(node,event,signature,approvals,provider);
   assert.equal(result.status,expected);
   assert.equal(result.required,2);
   assert.equal(result.approvals,expected==='validated'?2:1);
  }
  await vote(before,[sponsor],'pending');
  await vote(before,[sponsor,adult],'validated');

  const initiator=sponsor.householdPairing.ownDevice,responder=fresh.householdPairing.ownDevice;
  const request=await responder.request();
  const selectedDraft=await adult.householdPairing.ownDevice.propose(request,responder.fingerprint);
  await adult.householdPairing.selection.clear();
  adult.close();adult=await open(adultName);
  assert.equal(await adult.householdPairing.ownDevice.resume('initiator'),null);
  await adult.householdPairing.selection.select(scope);
  adult.close();adult=await open(adultName);
  assert.equal((await adult.householdPairing.ownDevice.resume('initiator')).code,selectedDraft.code);

  const previous=await initiator.propose(request,responder.fingerprint);
  const authoritySlot=JSON.stringify(['pairing-authority','household',scope.id]);
  const proposalDb=new DatabaseSync(join(dir,sponsorName+'.sqlite'));
  try{
   const write=proposalDb.prepare('UPDATE loro_records SET value=? WHERE key=?');
   const {value}=proposalDb.prepare('SELECT value FROM loro_records WHERE key=?').get(authoritySlot);
   const record=JSON.parse(value);
   write.run(JSON.stringify({...record,revision:record.revision+1}),authoritySlot);
   assert.equal(await initiator.resume('initiator'),null);
   assert.notEqual((await initiator.propose(request,responder.fingerprint)).code,previous.code);
   write.run(value,authoritySlot);
  }finally{proposalDb.close()}
  const proposal=await initiator.propose(request,responder.fingerprint);
  assert.deepEqual((await responder.inspect(proposal.text)).code,proposal.code);
  await assert.rejects(responder.confirm('responder',proposal.text,initiator.fingerprint,rootPin,'0'.repeat(64),proposal.code),/OOB_REQUIRED/);
  const start=(service,role,peer)=>service.confirm(role,proposal.text,peer.fingerprint,rootPin,before.head,proposal.code);
  let x=await start(initiator,'initiator',responder),y=await start(responder,'responder',initiator);
  await assert.rejects(initiator.publish(proposal.code),/INCOMPLETE/);
  for(let round=0;round<3;round++){
   const outgoing=x.text;
   x=await initiator.accept('initiator',y.text);
   y=await responder.accept('responder',outgoing);
  }
  assert.ok(x.complete&&y.complete);
  if(prepareOnly){
   await assert.rejects(initiator.prepareSet('wrong'),/OOB_REQUIRED/);
   const prepared=await initiator.prepareSet(proposal.code);
   const exact=structuredClone(prepared);
   assert.deepEqual(await initiator.prepareSet(proposal.code),exact);
   assert.deepEqual(prepared.requiredRecipientIds,[adult.householdPairing.identity.deviceId]);
   const established=adult.householdPairing.ownDevice,recipient=adult.householdPairing.identity;
   const offer=await initiator.prepareEstablishedOffer(proposal.code,recipient);
   assert.deepEqual(await initiator.prepareEstablishedOffer(proposal.code,recipient),offer);
   const verifiedOffer=await established.verifyEstablishedOffer(offer.text,offer.oob.hash);
   assert.deepEqual(verifiedOffer,{context:offer.context,transcript:offer.transcript,guard:offer.guard,oob:offer.oob});
   await assert.rejects(established.verifyEstablishedOffer(offer.text,'0'.repeat(64)),/CONFIRMATION_REQUIRED/);
   await assert.rejects(initiator.prepareEstablishedOffer(proposal.code,{...recipient,signingKey:'0'.repeat(64)}));
   await assert.rejects(initiator.prepareEstablishedOffer(proposal.code,{...recipient,deviceId:fresh.householdPairing.identity.deviceId}));
   const tampered=JSON.parse(offer.text);tampered.context.newEpochId='wrong';
   await assert.rejects(established.verifyEstablishedOffer(JSON.stringify(tampered),offer.oob.hash));
   const wrongWrap=await initiator.prepareEstablishedOffer(proposal.code,{...recipient,wrappingKey:'0'.repeat(64)});
   await assert.rejects(established.verifyEstablishedOffer(wrongWrap.text,wrongWrap.oob.hash));
   const wrongTransition=JSON.parse(offer.text);wrongTransition.publisherNext.acceptedParent='0'.repeat(64);
   await assert.rejects(established.verifyEstablishedOffer(JSON.stringify(wrongTransition),offer.oob.hash));
   await assert.rejects(sponsor.householdPairing.ownDevice.verifyEstablishedOffer(offer.text,offer.oob.hash));
   assert.equal(prepared.transition.item.event.version,5);
   assert.equal(prepared.parent.head,before.head);
   assert.equal(prepared.code,proposal.code);
   const event=prepared.transition.item.event;
   assert.ok(await provider.verify(sponsor.householdPairing.identity.signingKey,domain('event-signature',event),sodium.from_hex(prepared.transition.item.authorSignature)));
   assert.equal(sodium.to_hex(await provider.hash(domain('event',event))),prepared.transition.head);
   const {signature,...selection}=prepared.transition.selection;
   assert.ok(await provider.verify(sponsor.householdPairing.identity.signingKey,domain('select-head',{root:rootPin,householdId:scope.id,...selection}),sodium.from_hex(signature)));
   const authorityDb=new DatabaseSync(join(dir,sponsorName+'.sqlite'));
   try{
    const original=authorityDb.prepare('SELECT value FROM loro_records WHERE key=?').get(authoritySlot).value;
    try{
     const record=JSON.parse(original);
     authorityDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify({...record,revision:record.revision+1}),authoritySlot);
     await assert.rejects(initiator.prepareSet(proposal.code),/SOURCE_CHANGED/);
    }finally{authorityDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(original,authoritySlot);}
   }finally{authorityDb.close();}
   const containsCopy=value=>value&&typeof value==='object'&&Object.entries(value).some(([key,child])=>
    ['snapshot','seedSnapshot','sources','policies'].includes(key)||containsCopy(child));
   assert.equal(!!containsCopy(prepared),false);
   prepared.transition.head='tampered';
   assert.deepEqual(await initiator.prepareSet(proposal.code),exact);
   const sessionA=sponsor.householdPairing.session({...offer,role:'initiator',confirmedHash:offer.oob.hash});
   const sessionB=adult.householdPairing.session({...verifiedOffer,role:'responder',confirmedHash:offer.oob.hash});
   const offers=await Promise.all([sessionA.initialize(),sessionB.initialize()]);
   const responses=await Promise.all([sessionA.respond(offers[1],0),sessionB.respond(offers[0],0)]);
   const acks=await Promise.all([sessionA.acknowledge(responses[1],1),sessionB.acknowledge(responses[0],1)]);
   await Promise.all([sessionA.finish(acks[1],2),sessionB.finish(acks[0],2)]);
   const proof={context:offer.context,transcript:offer.transcript,guard:offer.guard,oob:offer.oob,messages:(await sessionA.evidence()).messages};
   await assert.rejects(initiator.publishPreparedSet(proposal.code,[]));
   const bad=structuredClone(proof);bad.context.recipientDeviceId='wrong';
   await assert.rejects(initiator.publishPreparedSet(proposal.code,[bad]));
   if(publishPrepared){
    const published=await initiator.publishPreparedSet(proposal.code,[proof]);
    assert.equal(published.replayed,false);
    assert.equal(published.establishedRecipients.length,1);
    await assert.rejects(initiator.publishPreparedSet(proposal.code,[]));
    const replay=await initiator.publishPreparedSet(proposal.code,[proof]);
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.file,published.file);
    assert.deepEqual(replay.establishedRecipients,published.establishedRecipients);
    await assert.rejects(initiator.recoverPreparedSet('wrong'),/OOB_REQUIRED/);
    assert.deepEqual(await initiator.recoverPreparedSet(proposal.code),replay);
    sponsor.close();sponsor=await open(sponsorName);
    assert.deepEqual(await sponsor.householdPairing.ownDevice.recoverPreparedSet(proposal.code),replay);
    const recipientFile=published.establishedRecipients[0].ciphertext;
    const installed=await established.installEstablished(recipientFile,proof);
    assert.equal(installed.head,published.head);
    assert.equal(installed.replayed,false);
    assert.equal((await established.installEstablished(recipientFile,proof)).replayed,true);
    const changedFile=new Uint8Array(recipientFile);changedFile[changedFile.length-1]^=1;
    await assert.rejects(established.installEstablished(changedFile,proof));
    const changedProof=structuredClone(proof);changedProof.messages.acks.responder.signature='0'.repeat(128);
    await assert.rejects(established.installEstablished(recipientFile,changedProof));
    const counterName=adultName+'-'+(await import('../app/household-transfer.mjs')).householdReceiverIds(sodium,scope,adult.deviceId).operationId;
    const counterRows=()=>{const db=new DatabaseSync(join(dir,counterName+'.sqlite'));try{return db.prepare('SELECT * FROM loro_sequence_counters').all()}finally{db.close()}};
    const counterBefore=counterRows();
    adult.close();adult=await open(adultName);
    const adopted=await readStore(adultName,storage=>storage.readPairingAuthority(scope));
    assert.equal(adopted.value.acceptedParent,published.head);
    assert.deepEqual(counterRows(),counterBefore);
    assert.ok((await pantry(adult)).includes('shared-basil'));
    await addPantry(adult,'reopened-adult');
    assert.ok((await pantry(adult)).includes('reopened-adult'));
    assert.ok(counterRows()[0].value>counterBefore[0].value);
    adult.close();adult=null;
    const counterPath=join(dir,counterName+'.sqlite'),counterBackup=counterPath+'.backup';
    copyFileSync(counterPath,counterBackup);rmSync(counterPath);
    try { await assert.rejects(open(adultName),/MISSING_SEQUENCES/); }
    finally { rmSync(counterPath,{force:true});copyFileSync(counterBackup,counterPath);rmSync(counterBackup); }
    return;
   }
   await addPantry(sponsor,'changed-after-preparation');
   await assert.rejects(initiator.prepareSet(proposal.code),/SOURCE_CHANGED/);
   await assert.rejects(initiator.prepareEstablishedOffer(proposal.code,recipient),/SOURCE_CHANGED/);
   await assert.rejects(initiator.publishPreparedSet(proposal.code,[proof]),/SOURCE_CHANGED/);
   return;
  }
  const sponsorRows=rows(sponsorName),freshRows=rows(freshName);
  const row=sponsorRows.find(row=>row.key===authoritySlot);
  const staleDb=new DatabaseSync(join(dir,sponsorName+'.sqlite'));
  try{
   const record=JSON.parse(row.value);
   staleDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify({...record,revision:record.revision+1}),authoritySlot);
   await assert.rejects(initiator.publish(proposal.code),/STALE_AUTHORITY/);
  }finally{
   staleDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(row.value,authoritySlot);
   staleDb.close();
  }
  for(let boundary=1;boundary<=9;boundary++){
   writes=0;faultName=sponsorName;faultWrite=boundary;
   await assert.rejects(sponsor.householdPairing.ownDevice.publish(proposal.code),/IO/);
   assert.equal(writes,boundary);
   faultName='';
   sponsor.close();sponsor=await open(sponsorName);
   assert.deepEqual(rows(sponsorName),sponsorRows);
   assert.deepEqual(await getNode(sponsorName),before);
  }
  const {file,head,update}=await sponsor.householdPairing.ownDevice.publish(proposal.code);
  assert.equal((await getNode(adultName)).head,before.head);
  const transition=JSON.parse(update).item;
  const retired={...before,devices:before.devices.map(device=>device.deviceId===sponsorId?{...device,active:false}:device),
   runtime:{...before.runtime,authorPeers:Object.fromEntries(Object.entries(before.runtime.authorPeers).filter(([id])=>id!==sponsorId)),
    acceptedRecipients:before.runtime.acceptedRecipients.filter(id=>id!==sponsorId)}};
  assert.equal((await validateSuccessor(retired,transition.event,transition.authorSignature,[],provider)).reason,'UNAUTHORIZED_DEVICE');
  const wrongAdult=structuredClone(transition.event);
  wrongAdult.subject.adultId=adult.householdPairing.identity.adultId;
  assert.equal((await validateSuccessor(before,wrongAdult,transition.authorSignature,[],provider)).status,'deny');
  const wrongScope=JSON.parse(update);
  wrongScope.item.event.householdId='unrelated-household';
  await assert.rejects(adult.householdPairing.ownDevice.acceptExisting(JSON.stringify(wrongScope),true),/INVALID/);
  assert.equal((await getNode(adultName)).head,before.head);
  // A recipient can write after the sponsor captured the signed copy.
  // Adoption must leave that write and the old authority accessible after reopen.
  adult.close();
  const adultPath=join(dir,adultName+'.sqlite'), backupPath=join(dir,adultName+'-before-divergence.sqlite');
  copyFileSync(adultPath,backupPath);
  adult=await open(adultName);
  await addPantry(adult,'recipient-late-edit');
  await assert.rejects(adult.householdPairing.ownDevice.acceptExisting(update,true),/LOCAL_EDITS_CONFLICT/);
  adult.close();adult=await open(adultName);
  assert.equal((await getNode(adultName)).head,before.head);
  assert.ok((await pantry(adult)).includes('recipient-late-edit'));
  adult.close();copyFileSync(backupPath,adultPath);rmSync(backupPath);
  adult=await open(adultName);
  await adult.householdPairing.ownDevice.acceptExisting(update,true);
  const adopted=rows(adultName);
  assert.deepEqual(await adult.householdPairing.ownDevice.acceptExisting(update,true),{scope,head,replayed:true});
  const changed=JSON.parse(update);
  changed.selection.index++;
  await assert.rejects(adult.householdPairing.ownDevice.acceptExisting(JSON.stringify(changed),true),/STALE_AUTHORITY/);
  assert.deepEqual(rows(adultName),adopted);
  assert.equal((await sponsor.householdPairing.ownDevice.resume('initiator')).code,proposal.code);
  assert.deepEqual((await sponsor.householdPairing.ownDevice.publish(proposal.code)).file,file);
  const documentSlot=JSON.stringify(['document',scope.id,transition.event.subject.documentId]);
  async function withPairedDocument(name,change,check){
   const db=new DatabaseSync(join(dir,name+'.sqlite'));
   try{
    const read=db.prepare('SELECT value FROM loro_records WHERE key=?');
    const write=db.prepare('UPDATE loro_records SET value=? WHERE key=?');
    const {value}=read.get(documentSlot);
    write.run(JSON.stringify(change(JSON.parse(value))),documentSlot);
    try{await check()}finally{write.run(value,documentSlot)}
   }finally{db.close()}
  }
  const empty={__storageBytes:Array.from(new LoroDoc().export({mode:'snapshot'}))};
  for(const name of [sponsorName,adultName]){
   await withPairedDocument(name,record=>({...record,bytes:empty}),async()=>{
    await assert.rejects(getNode(name),/INVALID_AUTHORITY/);
   });
   await withPairedDocument(name,record=>({...record,revision:1,bytes:empty}),async()=>{
    await assert.rejects(getNode(name),/INVALID_AUTHORITY/);
   });
  }
  fresh.close();fresh=await open(freshName);
  const damaged=new Uint8Array(file);damaged[damaged.length-1]^=1;
  await assert.rejects(fresh.householdPairing.ownDevice.install(damaged),/INVALID_FILE/);
  writes=0;faultName=freshName;faultWrite=2;
  await assert.rejects(fresh.householdPairing.ownDevice.install(file),/INJECTED/);
  assert.equal(writes,2);
  assert.deepEqual(rows(freshName),freshRows);
  writes=0;faultWrite=3;
  await assert.rejects(fresh.householdPairing.ownDevice.install(file),/IO/);
  assert.equal(writes,3);
  faultName='';
  for(let boundary=1;boundary<=16;boundary++){
   writes=0;faultName=freshName;faultWrite=boundary;
   await assert.rejects(fresh.householdPairing.ownDevice.install(file),/IO/);
   assert.equal(writes,boundary);
   faultName='';
   fresh.close();fresh=await open(freshName);
   // Counter preparation is durable but has never enabled a cooking write.
   const stable=rows(freshName).filter(row=>!['native-household-enrollment','native-household-activation'].includes(JSON.parse(row.key)[0]));
   assert.deepEqual(stable,freshRows);
   assert.equal((await readStore(freshName,storage=>storage.readPairingAuthority(scope))).value,null);
  }
  failCounter=true;writes=0;faultName=freshName;faultWrite=0;
  await assert.rejects(fresh.householdPairing.ownDevice.install(file),/COUNTER_OPEN_FAILED/);
  assert.equal(writes,16);
  faultName='';
  await assert.rejects(fresh.householdPairing.selection.select(scope),/INCOMPLETE_ENROLLMENT/);
  assert.deepEqual(scopeOf(fresh),original);
  fresh.close();fresh=await open(freshName);
  failCounter=false;
  assert.equal((await fresh.householdPairing.ownDevice.resume('responder')).installed.head,head);
  assert.equal((await fresh.householdPairing.ownDevice.install(file)).replayed,true);
  await fresh.householdPairing.selection.select(scope,head);
  [sponsor,adult,fresh].forEach(w=>w.close());
  sponsor=await open(sponsorName);adult=await open(adultName);fresh=await open(freshName);
  const after=await getNode(freshName);
  for(const [index,workspace] of [sponsor,adult,fresh].entries()){
   assert.deepEqual(await getNode(names[index]),after);
   assert.deepEqual(await pantry(workspace),['shared-basil']);
  }
  assert.deepEqual(after.roster,before.roster);
  assert.deepEqual(after.policy,before.policy);
  assert.equal(after.generation,before.generation);
  assert.equal(after.epochId,before.epochId);
  assert.equal(after.devices.length,before.devices.length+1);
  assert.equal(fresh.householdPairing.identity.adultId,sponsor.householdPairing.identity.adultId);
  await vote(after,[sponsor,fresh],'pending');
  await vote(after,[fresh,adult],'validated');
  const {doc}=await fresh.household.document();
  const itemId=Object.keys(doc.getMap('pantry-index').toJSON())[0],dep=doc.getMap('pantry-index').get(itemId);
  await fresh.executeHouseholdAction('paired-edit',[{version:1,kind:'pantry-field',commandId:'paired-edit',
   effectId:'paired-edit',dependencyEffectIds:[dep],data:{itemId,field:'name',value:'edited-basil',at:'2026-11-18T00:00:00Z',author:fresh.deviceId}}]);
  const cooking=await fresh.cookingFiles.list();
  assert.equal(cooking.length,1);
  const bytes=await fresh.cookingFiles.download(cooking[0].objectId);
  await sponsor.cookingFiles.receive(bytes);
  assert.deepEqual(await pantry(sponsor),['edited-basil']);
  await adult.cookingFiles.receive(bytes);
  assert.deepEqual(await pantry(adult),['edited-basil']);
  for(const name of [sponsorName,adultName]){
   for(const revision of ['0',undefined,-1]){
    await withPairedDocument(name,record=>({...record,revision}),async()=>{
     const saved=await readStore(name,storage=>storage.readHouseholdOwnDeviceRelease(scope,transition.event.proposalId,false));
     assert.equal(saved.ok,false);
     assert.equal(saved.error.code,'CORRUPT');
     await assert.rejects(getNode(name),/INVALID_AUTHORITY/);
    });
   }
  }
  await withPairedDocument(sponsorName,record=>({...record,revision:0}),async()=>{
   await assert.rejects(getNode(sponsorName),/INVALID_AUTHORITY/);
  });
  sponsor.close();sponsor=await open(sponsorName);
  assert.deepEqual(await pantry(sponsor),['edited-basil']);
  await addPantry(fresh,'second-edit');
  assert.deepEqual(await pantry(fresh),['edited-basil','second-edit']);
  assert.deepEqual((await fresh.household.listOutboundObjects()).value.map(x=>
   JSON.parse(new TextDecoder().decode(x.bytes)).header.deviceSequence).sort(),[1,2]);
 }finally{
  for(const workspace of [sponsor,adult,fresh])workspace?.close();
  names.forEach(removeWorkspace);
 }
}
test('own-device prepared set publishes all recipients', {timeout:40_000}, () => ownDeviceScenario(true,true));
test('own-device set preparation binds the exact source', {timeout:40_000}, () => ownDeviceScenario(true));
test('own-device household release and install roll back, reopen and preserve distinct-adult votes', {timeout:40_000}, () => ownDeviceScenario());

test('joined legacy admission reopens activated policy with its existing counter', {timeout:120_000}, async()=>{
 const organizerName='native-activated-joined-sponsor', recipientName='native-activated-joined-recipient';
 let organizer,recipient,captured;
 const openRecipient=create=>openNativeWorkspaceWith({...args(recipientName,create),openDirect:async input=>{captured=input;return null}});
 try {
  organizer=await openNativeWorkspaceWith(args(organizerName,true));
  recipient=await openRecipient(true);
  await acceptPolicy(organizer);
  await addPantry(organizer,'joined-leek');
  const sponsor=organizer.householdPairing, joining=recipient.householdPairing, scope=scopeOf(organizer);
  const delegation=await sponsor.prepareDelegation({explicit:true});
  const {item,eventHash}=await sponsor.prepareInvite({recipient:joining.identity,explicit:true});
  await sponsor.acceptDelegation({agreement:{...delegation.agreement,acceptances:[delegation.acceptance]},explicit:true});
  const {grant,manifest,seed,policyBundle}=await sponsor.prepareGrant({item,explicit:true});
  assert.equal(manifest.version,4);
  const ceremony=await sponsor.prepareCeremony({item,grant,manifest,seed,explicit:true});
  const parent=await sponsor.exportParent();
  await joining.acceptParent({bundle:parent,confirmedRootPin:parent.rootPin,confirmedSelectedHead:parent.selectedHead,explicit:true});
  const verified=await joining.verifyOffer({offer:{scope,item,grant,ceremony},confirmedHash:ceremony.oob.hash});
  const initiator=sponsor.session({...ceremony,role:'initiator',confirmedHash:ceremony.oob.hash});
  const responder=joining.session({...verified,role:'responder',confirmedHash:ceremony.oob.hash});
  const [oa,ob]=await Promise.all([initiator.initialize(),responder.initialize()]);
  const [ra,rb]=await Promise.all([initiator.respond(ob,0),responder.respond(oa,0)]);
  const [aa,ab]=await Promise.all([initiator.acknowledge(rb,1),responder.acknowledge(ra,1)]);
  await Promise.all([initiator.finish(ab,2),responder.finish(aa,2)]);
  const selection={from:item.event.parentHead,to:eventHash,deviceId:organizer.deviceId,index:parent.state.selections.length};
  selection.signature=sodium.to_hex(await organizer.disclosureProvider.sign(sponsor.identity.signingKey,domain('select-head',{root:parent.rootPin,householdId:scope.id,...selection})));
  const published=await sponsor.transfer.publish({item,grant,manifest,seed,policyBundle,ceremonies:[{transcript:ceremony.transcript,guard:ceremony.guard,oob:ceremony.oob,context:ceremony.context,messages:(await initiator.evidence()).messages}],existingCeremonies:[],selection});
  const bytes=await sponsor.transfer.seal({operationId:published.operationId,recipientDevice:recipient.deviceId});
  await joining.transfer.install({scope,bytes});
  await joining.selection.select(scope);
  recipient.close();recipient=await openRecipient(false);
  await addPantry(recipient,'joined-mint');
  const recipe={id:'joined-soup',title:'Joined soup',portions:2,ingredients:[],steps:[],stepIds:[],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
  const {runtime:capturedRuntime,provider}=captured,storage=capturedRuntime.storage,pin=parent.rootPin;
  const master=openMaster(recipientName),keys=storage.localKeys(master,sodium);await keys.unlock();
  const bootstrapDb=new DatabaseSync(join(dir,`${recipientName}.sqlite`));
  const bootstrapRow=bootstrapDb.prepare('SELECT data FROM loro_bootstrap WHERE id=1').get();bootstrapDb.close();
  const reservation=JSON.parse(new TextDecoder().decode(await master.unwrap('workspace-master',bootstrapRow.data,new TextEncoder().encode('creative-cooking/native-bootstrap/v1'))));
  const signing={operationId:'device-signing',identity:{version:1,scope:{kind:'personal',id:reservation.personal},deviceId:reservation.device,purpose:'device-signing',epochId:reservation.personalEpoch},publicKey:joining.identity.signingKey};
  const {resolveRuntimeAuthority}=await import('../authority/chain.mjs');
  const resolved=await resolveRuntimeAuthority(storage,scope,pin,provider,recipient.deviceId);
  const runtime=await openWorkspaceHouseholdRuntime({storage,resolved,pin,provider,sodium,keys,signing,LoroDoc,decodeImportBlobMeta});
  const counterName=houseCounterName(recipientName,scope,recipient.deviceId);
  const counterConnection=openDatabase(counterName);
  const {openNativeSequences}=await import('./sequences.mjs');
  const sequences=openNativeSequences(counterConnection,[scope.id],false);
  const {bindHouseholdContent}=await import('../app/household-content.mjs');
  const content=bindHouseholdContent({runtime,sequences,disclosure:recipient.disclosure,originalRecipeDocuments:true});
  try {await content.createRecipe('joined-recipe',recipe);} finally {counterConnection.close();}
  const before=await content.readCooking();
  const full=await observePolicyDocumentSet(runtime);
  const proof={storage,scope,pin,provider,LoroDoc,signed:full.signed,retained:full.sources.map(x=>({documentId:x.runtime.scope.documentId,revision:x.revision,bytes:x.bytes??new Uint8Array()}))};
  const subject=await policyDocumentSetSubject(proof),source=(await verifyPolicyDocumentSet(proof)).selected;
  const event={version:6,kind:'changePolicy',authorDeviceId:recipient.deviceId,householdId:scope.id,parentHead:source.head,epochId:source.epochId,generation:source.generation,subject,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',policyHash:source.policyHash,proposalId:'joined-policy',frozenAdultRoster:source.roster,nextPolicy:source.policy};
  const targetHead=sodium.to_hex(await provider.hash(domain('event',event)));
  const signers=[organizer,recipient];
  const approvals=[];
  for(const member of signers){
   const device=source.devices.find(d=>d.deviceId===member.deviceId);
   const vote={version:1,householdId:scope.id,eventHash:targetHead,parentHead:source.head,policyHash:source.policyHash,generation:source.generation,epochId:source.epochId,adultId:device.adultId,deviceId:member.deviceId};
   approvals.push({...vote,signature:sodium.to_hex(await member.disclosureProvider.sign(device.signingKeyRef,domain('approval-signature',vote)))});
  }
  const author=source.devices.find(d=>d.deviceId===recipient.deviceId);
  const signed={event,authorSignature:sodium.to_hex(await provider.sign(author.signingKeyRef,domain('event-signature',event))),approvals};
  await stageVerifiedPolicyDocumentSet({runtime,item:signed,signed:full.signed});
  const expected=(await storage.readPairingAuthority(scope)).value;
  await activateStagedPolicyDocumentSet({runtime,expectedSourceHead:expected.acceptedParent,expectedSourceRevision:expected.revision,targetHead,service:recipient.disclosure,sodium,keys});
  const counterPath=join(dir,`${houseCounterName(recipientName,scope,recipient.deviceId)}.sqlite`);
  recipient.close();recipient=undefined;
  const counter=new DatabaseSync(counterPath), prior=counter.prepare('SELECT value FROM loro_sequence_counters WHERE scope=?').get(scope.id).value;counter.close();
  recipient=await openRecipient(false);
  assert.equal(recipient.readOnly,true);
  assert.deepEqual(await recipient.householdContent.readCooking(),before);
  assert.equal((await recipient.householdContent.readRecipe('joined-soup')).doc.getMap('recipe:joined-soup').get('title'),'Joined soup');
  assert.throws(()=>recipient.householdContent.execute('no',[]),/READ_ONLY_WORKSPACE/);
  recipient.close();recipient=undefined;
  const counterCheck=openDatabase(houseCounterName(recipientName,scope,author.deviceId));
  try {const sequences=openNativeSequences(counterCheck,[scope.id],false);assert.equal(await sequences.reserve(scope.id,'after-activation'),prior+1);}
  finally {counterCheck.close();}
  // The independently stored original parent cannot be replaced after activation.
  const {openSQLiteTransaction}=await import('../storage/sqlite.ts');
  const pinDb=openDatabase(`${recipientName}-pairing`),pinTx=openSQLiteTransaction(pinDb);
  const pinSlot=JSON.stringify(['pin',scope.id]),pinAad=new TextEncoder().encode(`creative-cooking/household-pin/v1/${scope.id}`);
  const savedPin=await pinTx(false,tx=>tx.get(pinSlot));
  const pinValue=JSON.parse(new TextDecoder().decode(await master.unwrap('workspace-master',savedPin,pinAad)));
  assert.equal(pinValue.head,parent.selectedHead);
  const wrong=await master.wrap('workspace-master',new TextEncoder().encode(JSON.stringify({...pinValue,head:'0'.repeat(64)})),pinAad);
  await pinTx(true,tx=>tx.put(pinSlot,wrong));pinDb.close();
  await assert.rejects(openRecipient(false),/INVALID_ADMISSION/);
  const restoreDb=openDatabase(`${recipientName}-pairing`),restoreTx=openSQLiteTransaction(restoreDb);
  await restoreTx(true,tx=>tx.put(pinSlot,savedPin));restoreDb.close();
  const mainDb=openDatabase(recipientName),mainTx=openSQLiteTransaction(mainDb);
  const activationSlot=JSON.stringify(['native-household-activation',scope.id]);
  const savedActivation=await mainTx(false,tx=>tx.get(activationSlot));
  await mainTx(true,tx=>tx.put(activationSlot,{...savedActivation,stage:'pending'}));mainDb.close();
  await assert.rejects(openRecipient(false),/ENROLLMENT_CONFLICT|MISSING_ENROLLMENT/);
  const restoreMain=openDatabase(recipientName),restoreMainTx=openSQLiteTransaction(restoreMain);
  await restoreMainTx(true,tx=>tx.put(activationSlot,savedActivation));restoreMain.close();
  rmSync(counterPath);
  await assert.rejects(openRecipient(false),/MISSING_SEQUENCES/);
 } finally {organizer?.close();recipient?.close();removeWorkspace(organizerName);removeWorkspace(recipientName);}
});
