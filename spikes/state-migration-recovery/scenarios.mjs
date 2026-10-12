import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeBackupEnvelope, parseBackupEnvelope } from '../../src/storage/backupFormat.ts';
import { DEFAULT_STATE } from '../../src/domain/defaults.ts';
import * as E from './engines.mjs';
import { SCHEMA_VERSION, SECRET_MARKERS, SHA, fingerprint, importV1, applyImport, projectView,
  validateDocument, namespace, docId } from './schema.mjs';
import { DiskStore, makeEnvelope, verifyEnvelope, inspectDirectory, dispose } from './durable.mjs';

const output=path.join(path.dirname(fileURLToPath(import.meta.url)),'artifacts');
mkdirSync(output,{recursive:true});
const when='2026-10-01T12:00:00.000Z';
const personal=namespace('personal','fixture-alice');
const household=namespace('household','fixture-kitchen');
const secret=SECRET_MARKERS;
function exampleState() {
  return {
    ...structuredClone(DEFAULT_STATE),
    pantry:[
      {id:'old-carrot-a',name:' Carrots ',preference:5,createdAt:when,updatedAt:when},
      {id:'old-carrot-b',name:'carrots',preference:2,createdAt:when,updatedAt:when},
      {id:'old-herbs',name:'mint (dried)',preference:3,createdAt:when,updatedAt:when}
    ],
    recipes:[{id:'old-recipe',title:'Tomato toast',description:'A fast supper',portions:2,
      ingredients:[{name:'tomatoes',amount:'2'},{name:'bread',amount:'4 slices',needsShopping:true}],
      steps:['Heat oil, then add tomatoes.','Serve on toast.'],
      notes:['My secret family tip is to toast first'],
      createdAt:when,updatedAt:when}],
    chatMessages:[
      {id:'msg-live',role:'user',content:'Can we make toast tonight?',createdAt:when,
        proposals:[{id:'proposal-1',toolName:'recipe_save',
          arguments:'{"providerApiKey":"'+secret[0]+'"}',status:'pending'}]}
    ],
    chatHistory:[{id:'old-chat',title:'Dinner ideas',
      messages:[{id:'msg-archived',role:'assistant',content:'Try a tomato soup.',createdAt:when}],
      createdAt:when,updatedAt:when}],
    activeConversationId:'old-active',
    mealContext:{willingToShop:false,portions:2,cooks:['medium']},
    settings:{...structuredClone(DEFAULT_STATE.settings),
      systemPrompt:secret[1],allergies:['peanuts'],city:'Stockholm',
      providerId:'openrouter',model:'openrouter/free',dictationEngine:'whisper',
      apiKey:secret[0],oauthRefreshToken:secret[1]},
    deviceSigningKey:secret[2],
    privateGroupKey:secret[3]
  };
}
function legacyRaw(state=exampleState(),exportedAt=when){
  return serializeBackupEnvelope(state,exportedAt);
}
const legacy=legacyRaw(), example=exampleState();
const results=[];
const storageResults=[];
const scanRecords=[];
const migrationResults=[];
const rollback=[];
function scenario(engine,name,run){
  const start=performance.now();
  try{
    const detail=run();
    results.push({engine,name,status:'PASS',durationMs:+(performance.now()-start).toFixed(2),detail});
    console.log(engine+' PASS '+name);
  }catch(error){
    results.push({engine,name,status:'FAIL',durationMs:+(performance.now()-start).toFixed(2),
      error:String(error?.stack??error)});
    console.error(engine+' FAIL '+name+': '+error?.message);
  }
}
function docs(space=personal,selection=null){return importV1(legacy,space,selection);}
function ids(doc) {
  const recipeId=Object.keys(doc.recipes)[0];
  const stepIds=doc.recipes[recipeId].stepOrder;
  return {recipeId,stepId:stepIds[1],firstStepId:stepIds[0]};
}
function comparable(a,b){assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));}
function createConflict(engine,field='portions',left=4,right=6){
  const src=docs().document, seed=E.seed(engine,src), identity=ids(src);
  const phone=E.edit(engine,E.fork(engine,seed,'phone'),'phone',field,identity,left);
  const tablet=E.edit(engine,E.fork(engine,seed,'tablet'),'tablet',field,identity,right);
  const combined=E.merge(engine,phone,tablet);
  return {src,seed,identity,phone,tablet,combined};
}
function reviewEvent(engine,doc,recipeId,field) {
  const evidence=E.actualAlternatives(engine,doc,recipeId,field);
  assert.deepEqual(evidence.values.slice().sort(),[4,6]);
  assert.equal(evidence.operationIds.length,2);
  const id='merge:v1:'+fingerprint({engine,recipeId,field,operations:[...evidence.operationIds].sort()});
  return {id,kind:'scalar-disagreement',entityId:recipeId,engine,
    alternatives:evidence.values.map((value,i)=>({
      value,operationId:evidence.operationIds[i]
    })),status:'unresolved',frontier:evidence.frontier};
}
function temporary(tag){return mkdtempSync(path.join(tmpdir(),'cc-state-recovery-'+tag+'-'));}
function safeJson(obj){return JSON.stringify(obj,null,2)+'\n';}
function rawContainsMarker(data) {
  const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);
  return secret.filter(m=>bytes.includes(Buffer.from(m)));
}
function scan(name,parts,expectedDetected=false) {
  const found=[];
  for(const part of parts)for(const marker of rawContainsMarker(part.bytes))
    found.push({source:part.name,markerCode:secret.indexOf(marker)});
  scanRecords.push({name,scanned:parts.map(x=>({source:x.name,bytes:x.bytes.length})),
    leakedMarkerCodes:[...new Set(found.map(x=>x.markerCode))],pass:expectedDetected?found.length>0:found.length===0,
    negativeControl:expectedDetected});
  assert.equal(found.length>0,expectedDetected,name+' leak scan failed');
}
scenario('policy','legacy-v1-parser-and-exporter-unchanged',()=>{
  const parsed=parseBackupEnvelope(legacy,DEFAULT_STATE);
  assert.equal(parsed.pantry.length,3);assert.equal(parsed.settings.providerId,'openrouter');
  assert.equal(parsed.chatMessages[0].proposals.length,1);
  assert.equal(JSON.parse(legacy).version,1);
  scan('legacy-unsafe-backup-negative-control',[{name:'existing-v1-injected-backup',bytes:Buffer.from(legacy)}],true);
  const clean=exampleState();
  delete clean.deviceSigningKey;delete clean.privateGroupKey;
  clean.settings.systemPrompt='Ordinary cooking directions';
  delete clean.settings.apiKey;delete clean.settings.oauthRefreshToken;
  delete clean.chatMessages[0].proposals;
  const cleanV1=legacyRaw(clean);
  assert.deepEqual(parseBackupEnvelope(cleanV1,DEFAULT_STATE),clean);
  scan('clean-legacy-v1-export',[{name:'unmodified-v1-format',bytes:Buffer.from(cleanV1)}]);
  return {existingVersion:1,legacyCount:parsed.pantry.length,
    negativeControl:'polluted v1 backup leaks because production serializer copies raw state; DO NOT claim credential-safe v1 when polluted'};
});
scenario('policy','deterministic-fail-closed-allowlist-and-duplicate-migration',()=>{
  const original=docs(),second=importV1(legacyRaw(example,'2026-10-12T12:00:00.000Z'),personal);
  comparable(original.document,second.document);
  assert.equal(original.diagnostics.receiptId,second.diagnostics.receiptId);
  assert.equal(original.diagnostics.counts.pantry,3);
  assert.equal(original.diagnostics.counts.recipes,1);
  assert.equal(original.diagnostics.counts.conversations,2);
  assert.ok(original.diagnostics.droppedPaths.some(x=>x.includes('settings')));
  assert.ok(original.diagnostics.droppedPaths.some(x=>x.includes('proposals')));
  const a=original.document;
  assert.deepEqual(new Set(Object.values(a.pantry).filter(x=>x.name.trim().toLowerCase()==='carrots')
    .map(x=>x.preference)),new Set([2,5]));
  const same=applyImport(a,second.document);
  assert.equal(same.status,'duplicate');
  assert.equal(same.additions.length,0);
  comparable(same.document,a);
  const changed=exampleState();changed.pantry[0].preference=1;
  const unsafe=importV1(legacyRaw(changed),personal);
  const quarantined=applyImport(a,unsafe.document);
  assert.equal(quarantined.status,'quarantined');
  assert.ok(quarantined.conflicts.some(x=>x.startsWith('pantry:')));
  comparable(quarantined.document,a);
  migrationResults.push({engine:'policy',receiptId:original.diagnostics.receiptId,
    deterministicExportTimeIndependent:true,repeatedNoOp:true,
    changedLegacyIdQuarantined:true,counts:original.diagnostics.counts,
    droppedPaths:original.diagnostics.droppedPaths});
  return {stableReceipt:true,duplicateNamesRetained:true,quarantine:quarantined.conflicts.length};
});
scenario('policy','colliding-and-anonymous-legacy-ids-not-silently-lost',()=>{
  const data=exampleState();data.pantry.push({...data.pantry[0],name:'carrots (roasted)',preference:1});
  data.pantry.push({...data.pantry[0]});
  data.pantry.push({name:'parsley',preference:3,createdAt:when,updatedAt:when});
  data.pantry.push({name:'parsley',preference:3,createdAt:when,updatedAt:when});
  const migrated=importV1(legacyRaw(data),personal);
  assert.equal(Object.keys(migrated.document.pantry).length,6); // exact-ID duplicate coalesced with diagnostic
  assert.ok(migrated.diagnostics.droppedPaths.some(x=>x.includes('colliding-legacy-identifier')));
  assert.ok(migrated.diagnostics.droppedPaths.some(x=>x.includes('duplicate-exact-id-and-content')));
  comparable(migrated.document,importV1(legacyRaw(data),personal).document);
  return {rows:7,preserved:6,explicitExactDuplicateDiagnostic:true,anonymousRecordsPreserved:2};
});
scenario('policy','personal-household-selection-and-wrong-space-rejection',()=>{
  assert.throws(()=>docs(household),/confirmed ID selection/);
  const selected=docs(household,{confirmed:true,pantryIds:['old-herbs'],recipeIds:['old-recipe']}).document;
  assert.equal(Object.keys(selected.pantry).length,1);
  assert.equal(Object.keys(selected.recipes).length,1);
  assert.deepEqual(selected.conversations,{});
  assert.equal(selected.activeConversationId,null);
  assert.equal(selected.recipes[Object.keys(selected.recipes)[0]].notes,undefined);
  assert.notEqual(docId(personal),docId(household));
  assert.throws(()=>validateDocument(selected,personal),/wrong-space/);
  assert.throws(()=>validateDocument({...selected,rogueField:secret[4]},household),/unknown field/);
  const tampered=structuredClone(selected);
  tampered.recipes[Object.keys(tampered.recipes)[0]].ingredientsById[
    Object.keys(tampered.recipes[Object.keys(tampered.recipes)[0]].ingredientsById)[0]].providerApiKey=secret[4];
  assert.throws(()=>validateDocument(tampered,household),/unknown field/);
  return {householdPantry:1,householdRecipes:1,householdChats:0,selectionRequired:true};
});
scenario('policy','allowed-free-text-secret-injection-fails',()=>{
  const state=exampleState();
  state.chatMessages[0].content=secret[0];
  assert.throws(()=>importV1(legacyRaw(state),personal),/credential sentinel/);
  const future=exampleState();
  future.recipes[0].title='-----BEGIN PRIVATE KEY-----';
  assert.throws(()=>importV1(legacyRaw(future),personal),/private signing key/);
  return {unknownFieldsOmitted:true,secretLookingAllowedFieldsRejected:true,
    limitation:'not an exhaustive credential detector'};
});

for(const engine of Object.keys(E.ENGINE_VERSIONS)) {
  scenario(engine,'v1-to-real-binary-snapshot-restart-and-projection',()=>{
    const src=docs().document;
    const before=E.seed(engine,src),binary=E.snapshot(engine,before);
    assert.ok(binary.byteLength>50);
    const after=E.load(engine,binary);
    comparable(E.read(engine,after,personal),src);
    const view=projectView(E.read(engine,after,personal));
    assert.equal(view.recipes[0].ingredients[0].amount,'2');
    assert.equal(view.recipes[0].steps.length,2);
    assert.equal(view.pantry.length,3);
    assert.equal(E.frontier(engine,after).length>0,true);
    scan(engine+'-initial-binary-and-view',[
      {name:'real-'+engine+'-snapshot.bin',bytes:Buffer.from(binary)},
      {name:'reconstructed-view.json',bytes:Buffer.from(JSON.stringify(view))}
    ]);
    migrationResults.push({engine,snapshotBytes:binary.byteLength,
      snapshotSha256:SHA(Buffer.from(binary)),restored:true,
      documentId:src.documentId,receiptId:Object.keys(src.migrationReceipts)[0]});
    return {binaryBytes:binary.length,realEngine:true,recipes:view.recipes.length};
  });
  scenario(engine,'repeated-real-binary-update-import-idempotent',()=>{
    const src=docs().document,seed=E.seed(engine,src),target=E.init(engine);
    const updates=engine==='automerge'?E.incremental(engine,E.init(engine,'seed'),seed):
      [Uint8Array.from(seed.export({mode:'update'}))];
    assert.ok(updates.length>0);
    let received=target;
    for(const bytes of updates)received=E.apply(engine,received,bytes);
    const first=projectView(E.read(engine,received,personal));
    for(const bytes of updates)received=E.apply(engine,received,bytes);
    comparable(projectView(E.read(engine,received,personal)),first);
    assert.equal(first.pantry.length,3);
    return {realBinaryUpdates:updates.map(x=>x.length),pantryAfterDuplicate:first.pantry.length};
  });
  scenario(engine,'compatible-concurrent-recipe-edits-silent',()=>{
    const {src,seed,identity}=createConflict(engine);
    const a=E.edit(engine,E.fork(engine,seed,'phone'),'phone','title',identity,'Roasted tomato toast');
    const b=E.edit(engine,E.fork(engine,seed,'tablet'),'tablet','portions',identity,4);
    const joined=E.merge(engine,a,b);
    const recipe=E.read(engine,joined,personal).recipes[identity.recipeId];
    assert.equal(recipe.title,'Roasted tomato toast');
    assert.equal(recipe.portions,4);
    assert.equal(E.actualAlternatives(engine,joined,identity.recipeId,'portions').values.length,1);
    return {title:recipe.title,portions:recipe.portions,reviewEvents:0};
  });
  scenario(engine,'real-scalar-disagreement-binary-survives-restart',()=>{
    const {src,identity,combined}=createConflict(engine);
    const event=reviewEvent(engine,combined,identity.recipeId,'portions');
    const restarted=E.load(engine,E.snapshot(engine,combined));
    const again=reviewEvent(engine,restarted,identity.recipeId,'portions');
    assert.equal(event.id,again.id);
    const r=E.read(engine,restarted,personal).recipes[identity.recipeId];
    assert.ok([4,6].includes(r.portions));
    return {eventId:event.id,alternativeValues:[4,6],rendered:r.portions,
      durableBinaryEvidence:true,frontier:event.frontier};
  });
  scenario(engine,'real-title-disagreement-persists',()=>{
    const {identity,combined}=createConflict(engine,'title','Basil tomato toast','Garlicky tomato toast');
    const evidence=E.actualAlternatives(engine,combined,identity.recipeId,'title');
    assert.deepEqual(evidence.values.slice().sort(),['Basil tomato toast','Garlicky tomato toast']);
    return {values:evidence.values,operations:evidence.operationIds};
  });
  scenario(engine,'step-reorder-plus-content-edit-by-identity',()=>{
    const {seed,identity}=createConflict(engine);
    const moved=E.edit(engine,E.fork(engine,seed,'phone'),'phone','reorder',identity);
    const edited=E.edit(engine,E.fork(engine,seed,'tablet'),'tablet','stepEdit',
      {...identity,stepId:identity.firstStepId},'Simmer 10 minutes then serve.');
    const merged=E.merge(engine,moved,edited);
    const recipe=E.read(engine,merged,personal).recipes[identity.recipeId];
    assert.equal(recipe.stepOrder[0],identity.stepId);
    assert.equal(recipe.stepsById[identity.firstStepId].text,'Simmer 10 minutes then serve.');
    return {order:recipe.stepOrder,editedStableId:identity.firstStepId};
  });
  scenario(engine,'tombstone-survives-concurrent-edit',()=>{
    const {seed,identity}=createConflict(engine);
    const deleted=E.edit(engine,E.fork(engine,seed,'phone'),'phone','delete',identity);
    const edit=E.edit(engine,E.fork(engine,seed,'tablet'),'tablet','title',identity,'Edited offline');
    const combined=E.merge(engine,deleted,edit);
    const recipe=E.read(engine,combined,personal).recipes[identity.recipeId];
    assert.equal(recipe.deleted,true);
    assert.equal(recipe.title,'Edited offline');
    assert.equal(projectView(E.read(engine,combined,personal)).recipes.length,0);
    return {retainedTombstone:true,editStillAvailable:true,visibleRecipes:0};
  });
  scenario(engine,'same-name-independent-pantry-preferences',()=>{
    const {src,seed,identity}=createConflict(engine);
    const carA={id:'pantry_extra_1',name:'carrots',preference:1,
      createdAt:when,updatedAt:when,deleted:false};
    const carB={...carA,id:'pantry_extra_2',preference:4};
    const a=E.edit(engine,E.fork(engine,seed,'phone'),'phone','addPantry',identity,carA);
    const b=E.edit(engine,E.fork(engine,seed,'tablet'),'tablet','addPantry',identity,carB);
    const merged=E.merge(engine,a,b);
    const matching=Object.values(E.read(engine,merged,personal).pantry).filter(x=>
      x.name.trim().toLowerCase()==='carrots');
    assert.equal(matching.length,4);
    assert.deepEqual(new Set(matching.map(x=>x.preference)),new Set([1,2,4,5]));
    return {idCount:matching.length,preferences:matching.map(x=>x.preference).sort()};
  });
  scenario(engine,'causal-resolution-retains-prior-review-evidence',()=>{
    const {identity,combined}=createConflict(engine);
    const before=reviewEvent(engine,combined,identity.recipeId,'portions');
    const resolved=E.edit(engine,E.fork(engine,combined,'resolver'),'resolver','portions',identity,5);
    const after=E.actualAlternatives(engine,resolved,identity.recipeId,'portions');
    assert.deepEqual(after.values,[5]);
    const priorSnapshot=E.load(engine,E.snapshot(engine,combined));
    assert.deepEqual(E.actualAlternatives(engine,priorSnapshot,identity.recipeId,'portions').values.slice().sort(),[4,6]);
    return {oldEventId:before.id,resolvedPortions:5,
      previousAlternatives:[4,6],oldEvidenceNeedsDurableReviewCheckpoint:true};
  });
  scenario(engine,'four-precise-interrupted-wal-transactions',()=>{
    const {src,seed,identity}=createConflict(engine);
    const changed=E.edit(engine,E.fork(engine,seed,'phone'),'phone','portions',identity,4);
    const updates=E.incremental(engine,seed,changed);
    assert.equal(updates.length,1);
    const event={id:'review:'+fingerprint([engine,identity.recipeId,'portable-test']),
      kind:'semantic-review',alternatives:[{value:4,operationId:'fixture-1'}],
      status:'unresolved',engine,entityId:identity.recipeId,frontier:['fixture-1']};
    const stages=['before-update-persistence','after-bytes-before-import',
      'after-import-before-ack','after-review-checkpoint'];
    const report=[];
    for(const stage of stages) {
      const dir=temporary(engine);
      try{
        const store=new DiskStore(dir,engine,personal);
        store.startMigration(src);
        const env=makeEnvelope(engine,personal,updates[0]);
        assert.throws(()=>store.receive(env,{crashAt:stage,reviewEvents:[event]}),/INJECTED/);
        const cold=new DiskStore(dir,engine,personal).recover();
        assert.equal(cold.document.recipes[identity.recipeId].portions,
          stage==='before-update-persistence'?2:4);
        assert.equal(cold.updates,stage==='before-update-persistence'?0:1);
        const retry=store.receive(env,{reviewEvents:[event]});
        assert.equal(retry.acknowledged,true);
        const recovered=new DiskStore(dir,engine,personal).recover();
        assert.equal(recovered.document.recipes[identity.recipeId].portions,4);
        assert.equal(recovered.updates,1);
        assert.equal(recovered.checkpoint.events.length,1);
        assert.equal(recovered.checkpoint.events[0].status,'unresolved');
        assert.throws(()=>store.assertNoDestructiveCompaction(),/compaction blocked/);
        const full=store.saveFullHistorySnapshot();
        assert.equal(full.historyRetained,true);
        report.push({stage,beforeRetry:stage==='before-update-persistence'?2:4,
          afterRetry:4,walRecords:1,checkpointed:true,fullHistoryBytes:full.bytes});
      }finally {dispose(dir);}
    }
    storageResults.push({engine,kind:'interrupted-writes',stages:report});
    return {stageCount:report.length,checks:report};
  });
  scenario(engine,'migration-interruption-leaves-no-active-document',()=>{
    const d=docs().document,dir=temporary(engine);
    try{
      const store=new DiskStore(dir,engine,personal);
      assert.throws(()=>store.startMigration(d,{interrupt:true}),/INJECTED/);
      assert.equal(store.recover(),null);
      store.startMigration(d);
      const restarted=new DiskStore(dir,engine,personal).recover();
      comparable(restarted.document,d);
      storageResults.push({engine,kind:'migration',atomicActivation:true,orphanedSnapshotSafe:true});
      return {atomicActivation:true,orphanedSnapshotNotActive:true};
    }finally{dispose(dir);}
  });
  scenario(engine,'portable-history-loss-key-mismatch-rollback-and-restore',()=>{
    const {src,seed,identity,combined}=createConflict(engine);
    const dir=temporary(engine);
    const target=temporary(engine);
    const groupTarget=temporary(engine);
    try{
      const store=new DiskStore(dir,engine,personal);
      store.startMigration(src);
      const left=E.incremental(engine,seed,E.edit(engine,E.fork(engine,seed,'phone'),'phone','portions',identity,4));
      const right=E.incremental(engine,seed,E.edit(engine,E.fork(engine,seed,'tablet'),'tablet','portions',identity,6));
      for(const bytes of [...left,...right])store.receive(makeEnvelope(engine,personal,bytes));
      const current=store.recover();
      const event=reviewEvent(engine,current.doc,identity.recipeId,'portions');
      // Record review checkpoint without a new semantic engine change: replay last valid envelope.
      store.receive(makeEnvelope(engine,personal,right[0]),{reviewEvents:[event]});
      store.saveFullHistorySnapshot();
      const bundle=store.exportResearchBundle();
      assert.deepEqual(bundle.reviewCheckpoint.events.map(e=>e.id),[event.id]);
      assert.equal(bundle.schemaVersion,SCHEMA_VERSION);
      assert.equal(bundle.keyMetadata.keyRequirement,'none');
      const restored=DiskStore.restoreResearchBundle(target,bundle,{engine,space:personal});
      const onNew=restored.recover();
      comparable(onNew.view,bundle.appView);
      assert.deepEqual(E.actualAlternatives(engine,onNew.doc,identity.recipeId,'portions').values.slice().sort(),[4,6]);
      assert.equal(onNew.checkpoint.events[0].status,'unresolved');
      const corrupt={...bundle,fullSnapshotBase64:bundle.fullSnapshotBase64.slice(0,20)};
      assert.throws(()=>DiskStore.restoreResearchBundle(temporary(engine),corrupt,{engine,space:personal}),/snapshot/);
      const future={...bundle,schemaVersion:99};
      assert.throws(()=>DiskStore.restoreResearchBundle(temporary(engine),future,{engine,space:personal}),/schema/);
      assert.throws(()=>DiskStore.restoreResearchBundle(temporary(engine),bundle,{engine,space:household}),/wrong restore space/);
      const locked={...bundle,namespace:household,documentId:docId(household),
        keyMetadata:{keyRequirement:'external',publicEpochReference:'epoch-ref-test-v1'}};
      assert.throws(()=>DiskStore.restoreResearchBundle(groupTarget,locked,{engine,space:household}),/MISSING_GROUP_KEY/);
      assert.equal(new DiskStore(groupTarget,engine,household).recover(),null);
      const restoreAbort=temporary(engine);
      assert.throws(()=>DiskStore.restoreResearchBundle(restoreAbort,bundle,
        {engine,space:personal,crashBeforeActivation:true}),/INJECTED/);
      assert.equal(new DiskStore(restoreAbort,engine,personal).recover(),null);
      const report={engine,lossRecovery:true,fullBinaryBytes:Buffer.from(bundle.fullSnapshotBase64,'base64').length,
        updateWalCount:bundle.updateWalBase64.length,portableGroupPrivateKey:false,
        missingKeysRequireExternalPairing:true,partialSnapshotRejected:true,
        futureSchemaRejected:true,preActivationRollback:true,
        legacyDowngrade:'v1 view only; CRDT history/tombstones/review omitted; keep sidecar binary'};
      rollback.push(report);
      scan(engine+'-portable-history',[{name:'portable-research-bundle',
        bytes:Buffer.from(JSON.stringify(bundle))}]);
      return report;
    }finally{dispose(dir);dispose(target);dispose(groupTarget);}
  });
  scenario(engine,'wire-space-replay-and-unknown-engine-field-fail-closed',()=>{
    const src=docs().document,seed=E.seed(engine,src),identity=ids(src);
    const changed=E.edit(engine,E.fork(engine,seed,'phone'),'phone','title',identity,'Herby toast');
    const payload=E.incremental(engine,seed,changed)[0];
    const env=makeEnvelope(engine,personal,payload);
    verifyEnvelope(env,engine,personal);
    assert.throws(()=>verifyEnvelope(env,engine,household),/wrong-space replay/);
    assert.throws(()=>verifyEnvelope({...env,schemaVersion:4},engine,personal),/unsupported wire schema/);
    assert.throws(()=>verifyEnvelope({...env,payloadSha256:'0'.repeat(64)},engine,personal),/tampered update/);
    const rogue=E.edit(engine,E.fork(engine,seed,'phone'),'phone','rogueField',identity,{
      key:'providerApiKey',secret:secret[4]});
    const binary=E.snapshot(engine,rogue);
    assert.throws(()=>E.read(engine,E.load(engine,binary),personal),/unknown|rogue|credential|provider/i);
    // Receiver must check imported projection before committing an untrusted network write.
    const bytes=E.incremental(engine,seed,rogue)[0];
    const candidate=E.apply(engine,seed,bytes);
    assert.throws(()=>E.read(engine,candidate,personal),/unknown|rogue|credential|provider/i);
    scan(engine+'-validated-opaque-network',[{name:'verified-update-envelope',
      bytes:Buffer.from(JSON.stringify({...env,payloadBase64:Buffer.from(payload).toString('base64'),payload:undefined}))}]);
    return {wrongSpaceDenied:true,schemaMismatchDenied:true,wireDigestChecked:true,
      rogueEngineUpdateRejectedOnProjection:true,authenticatedTransport:false};
  });
  scenario(engine,'real-local-disk-and-network-leak-scan',()=>{
    const src=docs().document,dir=temporary(engine);
    try{
      const store=new DiskStore(dir,engine,personal);
      store.startMigration(src);
      const recovered=store.recover();
      const id=ids(src);
      const changed=E.edit(engine,E.fork(engine,recovered.doc,'phone'),'phone',
        'portions',id,4);
      const update=E.incremental(engine,recovered.doc,changed)[0];
      const env=makeEnvelope(engine,personal,update);
      store.receive(env);
      store.saveFullHistorySnapshot();
      const parts=inspectDirectory(dir).map(x=>({name:x.path,bytes:x.bytes}));
      parts.push({name:'network-envelope',bytes:Buffer.from(JSON.stringify({
        ...env,payload:Buffer.from(env.payload).toString('base64')
      }))});
      scan(engine+'-disk-binary-manifest-envelope',parts);
      const record={engine,files:parts.map(x=>({name:x.name,bytes:x.bytes.byteLength})),
        credentialSentinelsFound:0,untrustedTransportStillUnproven:true};
      storageResults.push({engine,kind:'bytes-and-leaks',...record});
      return {fileCount:parts.length,credentialSentinelsFound:0};
    }finally{dispose(dir);}
  });
  scenario(engine,'ordinary-v1-backup-remains-readable-after-sidecar-recovery',()=>{
    const original=parseBackupEnvelope(legacy,DEFAULT_STATE);
    assert.equal(original.recipes[0].title,'Tomato toast');
    const doc=docs().document,recovered=E.read(engine,E.load(engine,E.snapshot(engine,E.seed(engine,doc))),personal);
    const projection=projectView(recovered);
    assert.equal(projection.recipes[0].title,original.recipes[0].title);
    assert.equal(projection.pantry.length,original.pantry.length);
    assert.equal(projection.chatHistory.length,1);
    assert.equal(projection.chatMessages.length,1);
    // The ordinary v1 format cannot round-trip v2 causal histories.
    // Retain original legacy export independently (this fixture intentionally has injected secrets).
    return {v1StillParseable:true,sidecarIndependent:true,
      rollbackConsequence:'restoring v1 loses CRDT history, tombstones, review ledger and linked IDs'};
  });
}
const counts=Object.fromEntries([...new Set(results.map(r=>r.engine))].map(engine=>{
  const rows=results.filter(x=>x.engine===engine);
  return [engine,{pass:rows.filter(x=>x.status==='PASS').length,
    fail:rows.filter(x=>x.status==='FAIL').length}];
}));
const files={
  'scenario-results.json':{schemaVersion:1,engineVersions:E.ENGINE_VERSIONS,counts,results},
  'migration-results.json':{schemaVersion:2,source:'unmodified production v1 parser read-only',results:migrationResults},
  'recovery-results.json':{schemaVersion:1,storage:storageResults,rollback},
  'leak-scan-results.json':{schemaVersion:1,knownSentinels:secret.length,
    markerValuesExcludedFromReport:true,
    negativeControl:'Existing raw v1 backup includes injected secrets when state is polluted; unchanged production exporter',
    scans:scanRecords},
  'storage-invariants.json':{schemaVersion:1,conditions:[
    'manifest activation last and atomic; no active incomplete migration',
    'durable binary WAL before semantic import and acknowledgment; duplicate update IDs idempotent',
    'full history binary snapshots + unresolved review checkpoint; no destructive compaction qualified',
    'engine document + wire envelope namespace/engine/document/schema validated',
    'portable backup contains no live private keys; external household key recovery required',
    'future schema and partial/corrupt snapshots fail closed; existing state not overwritten',
    'portable v1 JSON rollback loses history/review; ordinary v1 parser stays untouched'
  ],limitations:[
    'Node/V8 and actual WASM binary formats, NOT iOS or Android runtime proof',
    'filesystem/fsync/rename simulation is not IndexedDB or AsyncStorage transaction integration',
    'synthetic secret scans are bounded and do not prove E2EE, ACL, authenticated transport or all free-text privacy',
    'no local full-history destructive engine compaction approved'
  ]}
};
for(const [filename,value] of Object.entries(files))writeFileSync(path.join(output,filename),safeJson(value));
console.log(JSON.stringify({counts,artifacts:Object.keys(files)}));
if(results.some(r=>r.status==='FAIL')||scanRecords.some(s=>!s.pass))process.exitCode=1;
