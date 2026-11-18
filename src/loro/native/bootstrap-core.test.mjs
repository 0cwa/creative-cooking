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
 let organizer, recipient, failEnrollment = false, afterReservation, beforeSelectionDecode, nativeDirect;
 const pairingPath = join(dir,`${recipientName}-pairing.sqlite`);
 const recipientPath = join(dir,`${recipientName}.sqlite`);
 const openRecipient = create => openNativeWorkspaceWith({
  ...args(recipientName,create),openDirect:nativeDirect,
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
  organizer = await openNativeWorkspaceWith({...args(organizerName,false),openDirect:organizerDirect});
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
