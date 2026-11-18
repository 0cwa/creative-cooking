// Host contract test only; native Android/Hermes proof must run separately.
import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';import {readdirSync,rmSync} from 'node:fs';import sodium from 'libsodium-wrappers';import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';import {openNativeWorkspaceWith,returnToOriginalNativeWorkspaceWith} from './bootstrap-core.mjs';import {executeAction} from '../app/action.mjs';
import {prepareInitialPolicy,acceptInitialPolicy} from '../disclosure/setup.mjs';
import {projectCooking} from '../domain/app-projection.mjs';
import {domain} from '../authority/validator.mjs';
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
 await executeAction(workspace.household, workspace.sequences, id, [{
  version:1,kind:'pantry-create',commandId:id,effectId:id,dependencyEffectIds:[],
  data:{itemId:id,name:id,preference:3,at:'2026-11-18T00:00:00Z',author:workspace.deviceId}
 }], workspace.disclosure);
}
const pantry = async workspace => projectCooking((await workspace.household.document()).doc).pantry.map(item => item.name).sort();

test('fresh native workspaces use the signed invitation and recover interrupted selection enrollment', async () => {
 const organizerName = 'native-invitation-organizer', recipientName = 'native-invitation-recipient';
 let organizer, recipient, failEnrollment = false;
 const openRecipient = create => openNativeWorkspaceWith({
  ...args(recipientName,create),
  openDatabase(name) {
   if (failEnrollment && name.startsWith(`${recipientName}-receive-`)) throw Error('COUNTER_OPEN_FAILED');
   return openDatabase(name);
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
  assert.ok(bytes.length > 48);
  const damaged = new Uint8Array(bytes);
  damaged[damaged.length-1] ^= 1;
  await assert.rejects(recipient.householdPairing.transfer.install({scope,bytes:damaged}),/INVALID_FILE/);
  assert.equal(await recipient.householdPairing.selection.available(scope),false);
  failEnrollment = true;
  await assert.rejects(recipient.householdPairing.transfer.install({scope,bytes}),/COUNTER_OPEN_FAILED/);
  await assert.rejects(recipient.householdPairing.selection.select(scope),/INCOMPLETE_ENROLLMENT/);
  assert.equal(await recipient.householdPairing.selection.openSelected(),null);

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
  await assert.rejects(recipient.householdPairing.selection.assertCurrent(null),/HOUSEHOLD_SELECTION_CHANGED/);
  recipient.close();
  organizer.close();
  recipient = await openRecipient(false);
  organizer = await openNativeWorkspaceWith(args(organizerName,false));
  assert.equal(recipient.household.scope.branchHead,organizer.household.scope.branchHead);
  assert.deepEqual(await pantry(recipient),['seed-leek']);
  assert.equal(recipient.needsDisclosureSetup,false);

  await Promise.all([addPantry(organizer,'offline-fennel'),addPantry(recipient,'offline-mint')]);
  for (const [sender,receiver] of [[organizer,recipient],[recipient,organizer]]) {
   const [{objectId}] = await sender.cookingFiles.list();
   await receiver.cookingFiles.receive(await sender.cookingFiles.download(objectId));
  }
  assert.deepEqual(await pantry(recipient),['offline-fennel','offline-mint','seed-leek']);
  assert.deepEqual(await pantry(organizer),await pantry(recipient));
  const deviceId = recipient.deviceId;
  await recipient.householdPairing.selection.clear();
  recipient.close();
  recipient = await openRecipient(false);
  assert.deepEqual(scopeOf(recipient),originalScope);
  assert.deepEqual(await pantry(recipient),[]);
  assert.equal(recipient.deviceId,deviceId);
  await recipient.householdPairing.selection.select(scope);
  recipient.close();
  recipient = await openRecipient(false);
  assert.deepEqual(await pantry(recipient),await pantry(organizer));
  recipient.close();
  recipient = null;

  const joined = houseCounterName(recipientName,scope,deviceId);
  const counter = new DatabaseSync(join(dir,`${joined}.sqlite`));
  counter.exec('DROP TABLE loro_sequence_counters');
  counter.close();
  await assert.rejects(openRecipient(false),/MISSING_SEQUENCES/);
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
