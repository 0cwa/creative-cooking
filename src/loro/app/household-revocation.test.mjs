import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import sodium from 'libsodium-wrappers';
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {checkoutPolicyHead, initializeAuthority,policyId,readAuthority,resolveRuntimeAuthority,rootPin} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {approveHouseholdAdmissionRule, proposeHouseholdAdmissionRule, retainHouseholdAdmissionRule, reviewHouseholdAdmissionRule} from './household-admission-rule.mjs';
import {householdCompromise} from './household-compromise.mjs';
import {householdRevocation} from './household-revocation.mjs';
import {projectCooking} from '../domain/app-projection.mjs';
import {localProvider} from './local-provider.mjs';
import {commitCookingBatchWithPolicy} from '../disclosure/cooking.mjs';
import {disclosureService} from '../disclosure/service.mjs';

await sodium.ready;
const scope={id:'rotation-home',kind:'household'};
const at='2026-01-01T00:00:00Z';
const pairedIds=['alpha','beta','gamma'];
const keyIdentity=(deviceId,epochId)=>({version:1,deviceId,epochId,scope,purpose:'data'});
const signerIdentity=deviceId=>({version:1,deviceId,epochId:'signer',scope:{id:deviceId,kind:'personal'},purpose:'device-signing'});
const wrapperIdentity=deviceId=>({...signerIdentity(deviceId),epochId:'wrapper',purpose:'device-wrapping'});
const rawKey=sodium.randombytes_buf(32);
const apply=(runtime,deviceSequence,kind,id,data,dependencyEffectIds=[])=>commitCookingBatchWithPolicy({
 runtime,service:runtime.disclosure,operationId:id,items:[{deviceSequence,
  command:{version:1,kind,commandId:id,effectId:id,data,dependencyEffectIds}}]
});
const withCurrent=use=>use(0);
const bind=state=>({
 transaction(fn){
  const records=new Map(state);
  const value=fn({get:k=>structuredClone(records.get(k)),put:(k,v)=>records.set(k,structuredClone(v))});
  for(const [k,v] of records)state.set(k,v);
  return value;
 }
});

test('SQLite revocation verifies source and votes, rolls back, reopens the bound key and preserves old evidence',async()=>{
 const base=join(homedir(),'agent-scratch','creative-cooking','routed-device-revocation');
 await mkdir(base,{recursive:true});
 const directory=await mkdtemp(join(base,'sqlite-'));
 const participants=[];
 try{
  for(const deviceId of pairedIds){
   const path=join(directory,deviceId+'.sqlite'), states=new Map();
   let database,storage,secret;
   const master={
    async provision(){secret=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);},
    async wrap(_id,value,additionalData){
     const iv=crypto.getRandomValues(new Uint8Array(12));
     return new Uint8Array([...iv,...new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},secret,value))]);
    },
    async unwrap(_id,value,additionalData){
     return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:value.slice(0,12),additionalData},secret,value.slice(12)));
    }
   };
   const participant={deviceId,fault:null,close:()=>database?.close(),rows:()=>database.prepare('SELECT * FROM loro_records ORDER BY key').all()};
   participant.replaceRow=(key,value)=>database.prepare('UPDATE loro_records SET value=? WHERE key=?').run(value,key);
   participants.push(participant);
   participant.open=()=>{
    database=new DatabaseSync(path);
    storage=openSQLiteStorage({executeSync(q,args=[]){
     const statement=database.prepare(q);
     return {rows:q.startsWith('SELECT')?statement.all(...args):(statement.run(...args),[])};
    }}, boundary=>participant.fault?.(boundary));
    participant.storage=storage;
   };
   participant.open();
   const keys=()=>storage.localKeys(master,sodium);
   await keys().provision('device-master');
   const signing={operationId:'signing',identity:signerIdentity(deviceId)};
   const wrapping={operationId:'wrapping',identity:wrapperIdentity(deviceId)};
   const signingKey=sodium.to_hex((await keys().generate(signing.operationId,signing.identity)).publicKey);
   const wrappingPublicKey=sodium.to_hex((await keys().generate(wrapping.operationId,wrapping.identity)).publicKey);
   const oldKey=await keys().preparePairedDataKey('initial-key',keyIdentity(deviceId,'old-epoch'),rawKey);
   // Initialize fixture keys through the same SQLite key transaction as runtime setup.
   const {installLocalKey}=await import('../storage/local-keys.ts');
   const {openSQLiteTransaction}=await import('../storage/sqlite.ts');
   const tx=openSQLiteTransaction({executeSync(q,args=[]){
    const statement=database.prepare(q);
    return {rows:q.startsWith('SELECT')?statement.all(...args):(statement.run(...args),[])};
   }});
   await tx(true,runner=>installLocalKey(runner,oldKey.record,oldKey.catalog));
   participant.signingKey=signingKey;
   participant.keys=keys;
   participant.provider=localProvider(sodium,{
    use:(...args)=>keys().use(...args)
   },{signing:{...signing,publicKey:signingKey},content:(epoch,use)=>keys().useIdentity(keyIdentity(deviceId,epoch),use)});
   participant.configure=async pin=>{
    const provider=participant.provider;
    const auth=await resolveRuntimeAuthority(storage,scope,pin,provider,deviceId);
    const runtime=new OfflineRuntime({storage,LoroDoc,decodeImportBlobMeta,scope:auth.scope,codec:candidateCodec(provider),
     keyRef:auth.scope.epochId,authority:{rootPin:pin,provider,selectionIndex:auth.selectionIndex}});
    const withSecrets=use=>keys().use(signing.operationId,signing.identity,signingSecret=>
     keys().use(wrapping.operationId,wrapping.identity,wrappingSecret=>use({signingSecret,wrappingSecret})));
    runtime.disclosure=disclosureService({storage,scope,rootPin:pin,provider,deviceId});
    Object.assign(participant,{runtime,service:householdRevocation({
     storage,scope,pin,provider,sodium,master,runtime,deviceId,adultId:deviceId,signingKey,wrappingPublicKey,store:bind(states),
     withSecrets,LoroDoc,randomUUID:()=>crypto.randomUUID()
    }),compromise:householdCompromise({runtime,withCurrent})});
   };
  }
  const [a,b,c]=participants, policy={kind:'fixed',fixedCount:2};
  const root={householdId:scope.id,head:'',generation:1,epochId:'old-epoch',roster:pairedIds,policy,policyHash:await policyId(a.provider,policy),
   devices:participants.map(({deviceId,signingKey})=>({adultId:deviceId,deviceId,signingKeyRef:signingKey,active:true})),
   runtime:{documentId:'old-cooking',authorPeers:{alpha:'1',beta:'2',gamma:'3'},acceptedRecipients:pairedIds}};
  const pin=root.head=await rootPin(a.provider,root);
  for(const participant of participants){
   await initializeAuthority(participant.storage,root,pin,participant.provider);
   await participant.configure(pin);
  }
  // Beta has a locally accepted inactive sibling and a different selection
  // prefix. Installing the rotation must keep that branch and its old work.
  const member=p=>({storage:p.storage,scope,pin,provider:p.provider,deviceId:p.deviceId,adultId:p.deviceId});
  const sibling=await proposeHouseholdAdmissionRule({...member(b),store:bind(new Map()),runtime:b.runtime,
   policy:{kind:'unanimous',fixedCount:null},expectedHead:pin,explicit:true,randomUUID:()=>crypto.randomUUID()});
  const {eventHash:siblingHead}=await reviewHouseholdAdmissionRule({...member(b),item:sibling});
  const vote=(p,item)=>approveHouseholdAdmissionRule({...member(p),item,confirmedEventHash:siblingHead,explicit:true});
  const signedSibling=await vote(b,(await vote(a,sibling)).item);
  await retainHouseholdAdmissionRule({...member(b),item:signedSibling.item,confirmedEventHash:siblingHead,explicit:true});
  const checkout=async targetHead=>{
   const current=await readAuthority(b.storage,scope,pin,b.provider);
   await checkoutPolicyHead({...member(b),LoroDoc,expectedHead:current.activeHead,expectedRevision:current.revision,targetHead,explicit:true});
   await b.configure(pin);
  };
  await checkout(siblingHead);
  await apply(b.runtime,1,'pantry-create','sibling-edit',{itemId:'s',name:'Sibling cardamom',preference:3,author:'beta',at});
  await checkout(pin);
  const siblingDocument=JSON.stringify(['document',scope.id,`policy-${siblingHead}`]);
  const siblingBefore=b.rows().find(row=>row.key===siblingDocument);
  assert.ok(siblingBefore);
  await apply(a.runtime,1,'shopping-list-create','market',{listId:'l',cycleId:'cycle',name:'Market',at});
  const item=await apply(a.runtime,2,'shopping-item-create','carrot',{listId:'l',cycleId:'cycle',itemId:'item',name:'Carrots',checked:false,
   recipeId:null,ingredientId:null,displayQuantity:'2.5',displayUnit:'kg',author:'alpha',at},['market']);
  assert.equal(item.outcome.state,'saved');
  const late=await apply(c.runtime,1,'pantry-create','suspect',{itemId:'p',name:'Late thyme',preference:3,author:'gamma',at});
  assert.equal(late.outcome.state,'saved');
  const oldObject=(await c.storage.listOutboundObjects(scope.id)).value[0];
  const {confirmation}=await a.compromise.open();
  const saveDraft=async()=>{
   const report=await a.compromise.prepare(confirmation,'gamma');
   const id=await a.compromise.sign(report,{kind:'checkpoint'});
   const view=await a.compromise.inspect(confirmation,id);
   await a.compromise.saveCleanDraft(view,view.rows.filter(v=>v.effectId!=='later').map(v=>v.effectId));
   return id;
  };
  let reviewId=await saveDraft();
  const remaining=await b.service.binding(), excluded=await c.service.binding();
  await assert.rejects(a.service.prepare({reviewId,bindings:[remaining,excluded],explicit:true}),/INVALID_RECIPIENT/);
  const prepare=()=>a.service.prepare({reviewId,bindings:[remaining],explicit:true});
  const approve=(participant,{proposal,confirmation})=>participant.service.approve({proposal:structuredClone(proposal),confirmed:confirmation,explicit:true});
  const confirm=({proposal,confirmation})=>({proposal,confirmed:confirmation,explicit:true});
  const firstVote=await approve(a,await prepare());
  await assert.rejects(a.service.publish(confirm(firstVote)),/QUORUM_REQUIRED/);
  await assert.rejects(approve(a,firstVote),/APPROVAL_UNAVAILABLE/);
  const stale=await approve(b,firstVote);
  await apply(a.runtime,3,'shopping-list-create','later',{listId:'later',cycleId:'later-cycle',name:'Later list in original only',at});
  const advancedSource=a.rows();
  await assert.rejects(a.service.publish(confirm(stale)),/SOURCE_CHANGED/);
  await assert.rejects(prepare(),/SOURCE_CHANGED/);
  assert.deepEqual(a.rows(),advancedSource);
  reviewId=await saveDraft();

  const approved=await approve(b,await approve(a,await prepare()));
  const {newEpochId, documentId}=approved.proposal.item.event.subject;
  const publication=approved.proposal.item.event.proposalId;
  const normalPublish=a.storage.publishProjection.bind(a.storage);
  const recordKey=JSON.stringify(['compromise-frozen-original',scope.id,reviewId]);
  const savedOriginal=a.rows().find(row=>row.key===recordKey);
  a.storage.publishProjection=async (...args)=>{
   const changed=JSON.parse(savedOriginal.value);
   changed.checkpoint.__storageBytes.push(99);
   a.replaceRow(recordKey,JSON.stringify(changed));
   return normalPublish(...args);
  };
  const beforeGuard=a.rows();
  await assert.rejects(a.service.publish(confirm(approved)),/CONFLICT/);
  a.replaceRow(recordKey,savedOriginal.value);
  assert.deepEqual(a.rows(),beforeGuard);
  a.storage.publishProjection=normalPublish;
  const beforeA=a.rows(), beforeB=b.rows();
  a.fault=()=>{
   if(a.rows().some(row=>JSON.parse(row.key)[0]==='projection-publication'))throw Error('injected publisher fault');
  };
  await assert.rejects(a.service.publish(confirm(approved)),/IO/);
  a.close();
  a.fault=null;
  a.open();
  await a.configure(pin);
  assert.deepEqual(a.rows(),beforeA);
  assert.equal((await a.service.publish(confirm(approved))).acceptedHead,approved.eventHash);
  const advanced=a.rows();
  assert.equal((await a.service.publish(confirm(approved))).replayed,true);
  assert.deepEqual(a.rows(),advanced);
  const file=await a.service.seal({operationId:publication,recipientDevice:'beta'});
  assert.deepEqual(await a.service.seal({operationId:publication,recipientDevice:'beta'}),file);
  await assert.rejects(a.service.seal({operationId:publication,recipientDevice:'gamma'}),/INVALID_RECIPIENT/);

  const beforeC=c.rows();
  await c.service.retain(confirm(approved));
  assert.equal((await c.service.status()).head,pin);
  assert.equal((await c.service.status()).branches[0].selected,false);
  await assert.rejects(c.service.install({...confirm(approved),bytes:file}),/INVALID_FILE/);
  assert.deepEqual(c.rows(),beforeC);
  await assert.rejects(c.keys().useIdentity(keyIdentity('gamma',newEpochId),()=>{}),/NOT_FOUND/);
  b.fault=()=>{
   if(b.rows().some(row=>JSON.parse(row.key)[0]==='recipient-admission'))throw Error('injected recipient fault');
  };
  const install=()=>b.service.install({...confirm(approved),bytes:file});
  await assert.rejects(install(),/IO/);
  b.close();
  b.fault=null;
  b.open();
  await b.configure(pin);
  assert.deepEqual(b.rows(),beforeB);
  assert.equal((await install()).acceptedHead,approved.eventHash);
  assert.equal((await b.service.status()).reopen,approved.eventHash);
  const installed=b.rows();
  assert.equal((await install()).replayed,true);
  const rollingFile=await b.keys().use('wrapping',wrapperIdentity('beta'),async secret=>{
   const publicKey=sodium.crypto_scalarmult_base(secret);
   const plain=sodium.crypto_box_seal_open(file,publicKey,secret);
   try{
    const transport=JSON.parse(new TextDecoder().decode(plain));
    const selection=transport.publication.selection;
    const {from,to,deviceId}=selection, index=selection.index+1;
    selection.index=index;
    selection.signature=sodium.to_hex(await a.provider.sign(a.signingKey,
     domain('select-head',{root:pin,householdId:scope.id,from,to,deviceId,index})));
    return sodium.crypto_box_seal(new TextEncoder().encode(JSON.stringify(transport)),publicKey);
   }finally{plain.fill(0);}
  });
  await assert.rejects(b.service.install({...confirm(approved),bytes:rollingFile}),/CONFLICT/);
  assert.deepEqual(b.rows(),installed);

  for(const p of [a,b]){
   p.close();p.open();
   await p.configure(pin);
   assert.equal(p.runtime.scope.documentId,documentId);
   assert.equal(p.runtime.scope.epochId,newEpochId);
   assert.equal(p.runtime.scope.acceptedAuthors.includes('gamma'),false);
   assert.deepEqual(projectCooking((await p.runtime.document()).doc).shopping.items.map(({name,displayQuantity,displayUnit})=>
    ({name,displayQuantity,displayUnit})),[{name:'Carrots',displayQuantity:'2.5',displayUnit:'kg'}]);
   assert.deepEqual((await readAuthority(p.storage,scope,pin,p.provider)).state.events.at(-1).rotation.grant.recipients,['alpha','beta']);
  }
  assert.deepEqual(b.rows().find(row=>row.key===siblingDocument),siblingBefore);
  assert.deepEqual((await b.service.inspectBranch(siblingHead)).pantry,['Sibling cardamom']);
  assert.ok((await readAuthority(b.storage,scope,pin,b.provider)).heads.includes(siblingHead));
  const keyA=await a.keys().useIdentity(keyIdentity('alpha',newEpochId),secret=>new Uint8Array(secret));
  const keyB=await b.keys().useIdentity(keyIdentity('beta',newEpochId),secret=>new Uint8Array(secret));
  assert.deepEqual(keyA,keyB);
  assert.notDeepEqual(keyA,rawKey);
  keyA.fill(0);keyB.fill(0);
  const held=await a.service.holdLateEvidence(oldObject.bytes);
  assert.equal((await a.service.holdLateEvidence(oldObject.bytes)).replayed,true);
  assert.equal((await a.service.inspectLate(held.objectId)).command.data.name,'Late thyme');
  const afterHold=a.rows();
  const attempted=await a.runtime.recoverInbox();
  assert.ok(attempted.find(result=>result.itemId===held.objectId)?.error);
  assert.deepEqual(a.rows(),afterHold);
  assert.equal(projectCooking((await a.runtime.document()).doc).pantry.length,0);
  const oldA=(await a.storage.reopenDocument(scope.id,root.runtime.documentId)).value;
  const doc=new LoroDoc();doc.import(oldA.bytes);
  assert.ok(projectCooking(doc).shopping.lists.some(({name})=>name==='Later list in original only'));

  // The frozen parent rule still applies on the next rotation. Only the last
  // eligible recipient receives the newly generated key, with no remote packet.
  const followup=await a.compromise.open();
  const nextReport=await a.compromise.prepare(followup.confirmation,'beta');
  const nextReview=await a.compromise.sign(nextReport,{kind:'checkpoint'});
  await a.compromise.saveCleanDraft(await a.compromise.inspect(followup.confirmation,nextReview),[]);
  const next=await approve(b,await approve(a,await a.service.prepare({reviewId:nextReview,bindings:[],explicit:true})));
  assert.deepEqual(next.proposal.grant.recipients,['alpha']);
  assert.deepEqual(next.proposal.grant.packageRefs,[]);
  const nextResult=await a.service.publish(confirm(next));
  assert.equal(nextResult.acceptedHead,next.eventHash);
  await a.configure(pin);
  assert.deepEqual(a.runtime.scope.acceptedAuthors,['alpha']);
  assert.equal((await a.service.status()).published.recipients.length,0);
  assert.equal(projectCooking((await a.runtime.document()).doc).shopping.items[0].displayQuantity,'2.5');
  await assert.rejects(c.keys().useIdentity(keyIdentity('gamma',a.runtime.scope.epochId),()=>{}),/NOT_FOUND/);
  await assert.rejects(b.keys().useIdentity(keyIdentity('beta',a.runtime.scope.epochId),()=>{}),/NOT_FOUND/);

 }finally{
  for(const p of participants)p.close();
  await rm(directory,{recursive:true,force:true});
 }
});
