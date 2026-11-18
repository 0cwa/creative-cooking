import {createHash,randomUUID} from 'node:crypto';
// Host contract test only; native Android/Hermes proof must run separately.
import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';import {copyFileSync,existsSync,readdirSync,rmSync} from 'node:fs';import sodium from 'libsodium-wrappers';import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';import {openNativeWorkspaceWith,returnToOriginalNativeWorkspaceWith} from './bootstrap-core.mjs';import {executeAction} from '../app/action.mjs';
import {prepareInitialPolicy,acceptInitialPolicy} from '../disclosure/setup.mjs';
import {projectCooking} from '../domain/app-projection.mjs';
import {domain} from '../authority/validator.mjs';
import {cookingDirect} from '../transport/cooking-direct.mjs';
import {householdReceiverIds} from '../app/household-transfer.mjs';
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
