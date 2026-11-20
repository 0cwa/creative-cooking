import {readVerifiedActivatedPolicyDocumentSet,readHistoricalPolicyActivationEvidence} from './read-activated-policy-document-set.mjs';
import {preparePolicyDocumentKeys} from './prepare-policy-document-keys.mjs';
import {stageVerifiedPolicyDocumentSet,readVerifiedPolicyDocumentSet} from './stage-policy-document-set.mjs';
import {observePolicyDocumentSet,verifyPolicyDocumentSet,policyDocumentSetSubject,matchPolicyDocumentSetEvent} from '../authority/policy-document-set.mjs';
import {householdPairing} from './household-pairing.mjs';
import {policyBaseline} from '../authority/policy-baseline.mjs';
import {installEstablishedOwnDeviceSet,commitVerifiedEstablishedOwnDeviceSet,publishOwnDeviceSet,captureOwnDeviceCopySet,installOwnDeviceSetFile,reopenOwnDeviceSet,sealOwnDeviceSetFile,verifyOwnDeviceCopySet,verifyOwnDeviceSetSuccessor,withOpenedOwnDeviceSetFile} from '../pairing/household-own-device-set.mjs';
import {openDeviceCopy,pairingDigest,sealDeviceCopy} from '../pairing/personal-copy.mjs';
import {verifyOwnDeviceSuccessor} from '../pairing/household-own-device.mjs';
import {ownDeviceSignal} from '../authority/own-device.mjs';
import {ownDeviceRecipientSignal,verifyOwnDeviceRecipients} from '../pairing/household-own-device-recipients.mjs';
import {withOpenedEstablishedOwnDeviceTransition} from '../pairing/household-own-device-established-file.mjs';
import {householdCompromise} from './household-compromise.mjs';
import {CompromiseReviews,REVIEW_LIMITS} from '../compromise/review.mjs';
import {decodeReportFile,encodeReportFile,REPORT_FILE_LIMIT} from '../compromise/report-file.mjs';
import {evidenceSha256,manifestDigest,reportMessage} from '../compromise/report.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {cookingFiles} from './cooking-file.mjs';
import {MAX_OBJECT} from '../transport/adapter.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';
import sodium from 'libsodium-wrappers';
import {acceptAdmissionAgreement,initializeAuthority,readAuthority,observeSuccessor,policyId,resolveRuntimeAuthority,resolveInstalledSetAuthority,rootPin,authorityBytes,snapshotId,verifyAuthority,encodeEvidence} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {writeFixtureSelection} from '../authority/chain-test-fixture.mjs';
import {candidateCodec,SUITE,LIMIT as CANDIDATE_LIMIT} from '../crypto/candidate.mjs';
import {localProvider} from './local-provider.mjs';
import {testProvider} from '../crypto/test-provider.mjs';
import {commitCookingWithPolicy} from '../disclosure/cooking.mjs';
import {createSourceVerifier} from '../disclosure/source-proof.mjs';
import {verifiedSeedSources} from '../disclosure/seed-source.mjs';
import {acceptInitialPolicy,prepareInitialPolicy} from '../disclosure/setup.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {hash as disclosureHash} from '../disclosure/policy.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {openSQLiteStorage,openSQLiteTransaction} from '../storage/sqlite.ts';
import {openNativeHouseholdPersistence} from '../native/household-persistence.mjs';
import {householdReceiverIds} from './household-transfer.mjs';
import {householdLocalTrust} from './household-local-trust.mjs';
import {executeAction} from './action.mjs';
import {bindHouseholdContent} from './household-content.mjs';
import {activateStagedPolicyDocumentSet,prepareWorkspacePolicyDocumentKeys,openWorkspaceHouseholdRuntime,resolveOriginalHousehold} from './workspace-household-runtime.mjs';
import {planShoppingAction} from './shopping-actions.mjs';
import {planRecipeAction} from './recipe-actions.mjs';
import {planRecipeRestore,readRecipeHistory} from '../domain/recipe-history.mjs';
import {projectCooking} from '../domain/app-projection.mjs';
import {projectCurrentSeed} from '../compromise/current-seed.mjs';
import {recipeDocumentId} from '../domain/recipe-document.mjs';
import {replayAuthenticated} from '../domain/replay.mjs';
import {apply} from '../domain/registry.mjs';
import {openSelectedRecipeCatalog,projectSelectedRecipes} from './selected-recipe-catalog.mjs';
import {observeSelectedSourceSet,selectedSourceHash,verifySelectedSourceSet} from '../projection/selected-sources.mjs';
import {exportHouseholdParent} from './household-parent.mjs';
import {prepareAdultRemovalProjection,prepareCurrentDocumentSet,requirePublicRecipeHistory,verifyCurrentDocumentSet,verifyCurrentDocumentSetSource} from '../projection/current-document-set.mjs';
import {householdDocumentSetRelease,publishHouseholdDocumentSet,readInstalledHouseholdDocumentSet,installedDocumentSetContent} from '../pairing/household-document-set.mjs';
import {encodeHouseholdDocumentSetFile,installHouseholdFile,sealHouseholdFile} from '../pairing/household-file.mjs';
import {durableSession,householdSessionContextBytes} from '../pairing/durable-session.mjs';
import {ceremonyBytes} from '../pairing/candidate-v2.mjs';
import {existingRecipientContextBytes} from '../authority/ceremony.mjs';
test('retained updates distinguish policy evidence and other retry reasons',async()=>{
 const ok=value=>({ok:true,value});
 const header=(branchHead,epochId='epoch')=>new TextEncoder().encode(JSON.stringify({header:{branchHead,epochId,authorDevice:'peer'}}));
 const storage={compromise:{isQuarantined:async()=>false},listCursors:async()=>ok([{source:'file:one',cursor:'one'},{source:'file:two',cursor:'two'},{source:'relay',cursor:'three'},{source:'file:inactive',cursor:'inactive'}]),
  listStagedInbox:async()=>ok([{itemId:'one',bytes:header('head')},{itemId:'two',bytes:header('head')},{itemId:'three',bytes:header('head')},{itemId:'inactive',bytes:header('sibling')}]),
  listDisclosurePending:async()=>ok([{objectId:'one',reason:'POLICY_GOVERNANCE_UNPROVEN'}]),getInboxApplication:async()=>ok(null)};
 const runtime={scope:{scopeId:'s',branchHead:'head',epochId:'epoch'},storage,authorize:async()=>{}};
 const api=cookingFiles({runtime,service:{}});
 assert.deepEqual(await api.pending(),[{itemId:'one',reason:'POLICY_GOVERNANCE_UNPROVEN'},{itemId:'two',reason:null}]);
 const sibling=cookingFiles({runtime:{...runtime,scope:{...runtime.scope,branchHead:'sibling'}},service:{}});
 assert.deepEqual(await sibling.pending(),[{itemId:'inactive',reason:null}]);
});
test('oversized input is rejected before authorization or copying',async()=>{
 let calls=0;const api=cookingFiles({runtime:{scope:{scopeId:'s'},authorization:async()=>{calls++;throw Error('unexpected') }},service:{}});await assert.rejects(()=>api.receive(new Uint8Array(MAX_OBJECT+1)),/TOO_LARGE/);assert.equal(calls,0);
});

const scope = {kind:'household',id:'house'};
const must = result => {
  assert.equal(result.ok,true,JSON.stringify(result.error));
  return result.value;
};
async function household(t,{onDisk=false,third=false}={}) {
  await sodium.ready;
  const dataKey = sodium.randombytes_buf(32);
  const signing = Array.from({length:third?3:2},()=>sodium.crypto_sign_keypair());
  t.after(() => {dataKey.fill(0); for (const pair of signing) pair.privateKey.fill(0);});
  const refs = signing.map(pair => sodium.to_hex(pair.publicKey));
  const provider = testProvider(sodium,{initialKey:dataKey});
  provider.sign = async (ref,bytes) => sodium.crypto_sign_detached(bytes,signing[refs.indexOf(ref)].privateKey);
  provider.verify = async (ref,bytes,signature) => refs.includes(ref) &&
    sodium.crypto_sign_verify_detached(signature,bytes,signing[refs.indexOf(ref)].publicKey);
  const policy = {kind:'allMinusOne',fixedCount:null};
  const root = {
    householdId:scope.id,head:'',policyHash:await policyId(provider,policy),generation:1,epochId:'epoch',
    roster:['adult'],policy,devices:refs.map((signingKeyRef,index) => ({adultId:'adult',deviceId:`device-${index}`,signingKeyRef,active:true})),
    runtime:{documentId:'cooking',authorPeers:Object.fromEntries(refs.map((_,i)=>[`device-${i}`,String(i+1)])),acceptedRecipients:refs.map((_,i)=>`device-${i}`)}
  };
  root.head = await rootPin(provider,root);
  const directory=onDisk ? mkdtempSync(join(tmpdir(),'recipe-catalog-')) : null;
  const connections=new Set();
  t.after(()=>{
    for(const db of connections)db.close();
    if(directory)rmSync(directory,{recursive:true});
  });
  return Promise.all(signing.map(async (_pair,index) => {
    const path=directory?join(directory,`peer-${index}.sqlite`):':memory:';
    let db = new DatabaseSync(path);
    connections.add(db);
    let fault;
    const connection={executeSync(sql,params = []) {
      const statement = db.prepare(sql);
      return {rows:sql.startsWith('SELECT') ? statement.all(...params) : (statement.run(...params),[])};
    }};
    const storage=openSQLiteStorage(connection,boundary=>{if(boundary===fault)throw Error('injected failure');});
    const deviceId = `device-${index}`;
    await initializeAuthority(storage,root,root.head,provider);
    const resolved = await resolveRuntimeAuthority(storage,scope,root.head,provider,deviceId);
    const runtime = new OfflineRuntime({storage,codec:candidateCodec(provider),LoroDoc,decodeImportBlobMeta,
      scope:resolved.scope,keyRef:root.epochId,authority:{rootPin:root.head,provider}});
    const service = disclosureService({storage,scope,rootPin:root.head,provider,deviceId});
    const cooking = cookingFiles({runtime,service});
    const trust = householdLocalTrust({runtime,withCurrent:use => use(0)});
    return {
      deviceId,storage,runtime,trust,cooking,service,root,provider,connection,signingTestKey:signing[index],dataKey,
      faultAt: boundary => {fault=boundary;},
      rows:() => db.prepare('SELECT key,value FROM loro_records ORDER BY key').all(),
      replaceRow:(key,value)=>db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(value,key),
      reopen() {
        assert.ok(directory);
        db.close();
        connections.delete(db);
        db=new DatabaseSync(path);
        connections.add(db);
      },
      async edit(name,sequence,{legacy = false,preview = false} = {}) {
        const input = {operationId:name,deviceSequence:sequence,command:{
          version:1,kind:'pantry-create',commandId:name,effectId:name,dependencyEffectIds:[],
          data:{itemId:name,name,preference:3,author:deviceId,at:'2026-01-01T00:00:00Z'}
        }};
        if (preview) {
          // Seal a competing update from the existing frontier without advancing it.
          const commit = storage.commitLocalWithDisclosurePolicy;
          let object;
          storage.commitLocalWithDisclosurePolicy = async prepared => {
            object = prepared.outbound[0].object;
            return {ok:true,value:null};
          };
          try { await commitCookingWithPolicy({runtime,service,input}); }
          finally { storage.commitLocalWithDisclosurePolicy = commit; }
          return {itemId:object.id,bytes:object.bytes};
        }
        await (legacy ? runtime.execute(input) : commitCookingWithPolicy({runtime,service,input}));
        const rows = must(await storage.listOutboundObjects(scope.id));
        const object = rows.find(row => JSON.parse(new TextDecoder().decode(row.bytes)).header.deviceSequence === sequence);
        return {itemId:object.objectId,bytes:object.bytes};
      }
    };
  }));
}

function testMaster(){
 let key;
 return {
  async provision(){key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);},
  async wrap(_id,bytes,additionalData){
   const iv=crypto.getRandomValues(new Uint8Array(12));
   const result=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},key,bytes);
   return new Uint8Array([...iv,...new Uint8Array(result)]);
  },
  async unwrap(_id,bytes,additionalData){
   return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData},key,bytes.slice(12)));
  },
 };
}

function fixtureSessionStore(connection){
 connection.executeSync('CREATE TABLE IF NOT EXISTS pairing_sessions (key TEXT PRIMARY KEY,value TEXT)');
 return {transaction(use){
  connection.executeSync('BEGIN IMMEDIATE');
  try{
   const result=use({
    get:key=>{const row=connection.executeSync('SELECT value FROM pairing_sessions WHERE key=?',[key]).rows[0];return row&&JSON.parse(row.value);},
    put:(key,value)=>connection.executeSync('INSERT OR REPLACE INTO pairing_sessions VALUES (?,?)',[key,JSON.stringify(value)]),
   });
   connection.executeSync('COMMIT');
   return result;
  }catch(error){connection.executeSync('ROLLBACK');throw error;}
 }};
}

test('frozen selected retention holds a shopping copy when its recipe field is excluded',async t=>{
 const [a,b,c]=await household(t,{onDisk:true,third:true}),master=testMaster(),keys=a.storage.localKeys(master,sodium);
 await keys.provision('retention-master');
 const policy=await prepareInitialPolicy({service:a.service,enforcement:'block'});
 const acceptedPolicy=await acceptInitialPolicy({service:a.service,provider:a.provider,deviceId:a.deviceId,policy,explicit:true});
 const at='2026-01-01T00:00:00Z',child=await a.runtime.forRecipe('retention-recipe');let seq=0;
 const sequences={reserve:async()=>++seq},save=(runtime,id,commands)=>executeAction(runtime,sequences,id,commands,a.service);
 const beforeRecipe={id:'retention-recipe',title:'Soup',portions:2,ingredients:[{id:'carrot',name:'Carrot',amount:'1 cup',needsShopping:true}],steps:[],stepIds:[],createdAt:at,updatedAt:at};
 const creation=planRecipeAction({doc:(await child.document()).doc,before:null,after:beforeRecipe,actionId:'retention-create',author:a.deviceId,at});
 await save(child,'retention-create',creation);
 const intermediateRecipe={...beforeRecipe,ingredients:[{...beforeRecipe.ingredients[0],amount:'3 cups'}]};
 const intermediate=planRecipeAction({doc:(await child.document()).doc,before:beforeRecipe,after:intermediateRecipe,actionId:'retention-intermediate',author:a.deviceId,at});
 await save(child,'retention-intermediate',intermediate);
 const changedRecipe={...beforeRecipe,ingredients:[{...beforeRecipe.ingredients[0],amount:'2 cups'}]};
 const field=planRecipeAction({doc:(await child.document()).doc,before:intermediateRecipe,after:changedRecipe,actionId:'retention-field',author:a.deviceId,at});
 await save(child,'retention-field',field);
 const selected=await openSelectedRecipeCatalog(a.runtime),before=projectCooking(selected.parent.doc);
 const list={id:'retention-list',name:'Market',currentCycleId:'retention-cycle',createdAt:at,updatedAt:at};
 const cycle={id:'retention-cycle',listId:list.id,startedAt:at};
 const copied={id:'retention-item',listId:list.id,name:'Carrot',recipeId:beforeRecipe.id,ingredientId:'carrot',displayQuantity:'2 cups',purchaseCycleId:cycle.id,checked:false,createdAt:at,updatedAt:at};
 const shopping=planShoppingAction({doc:selected.parent.doc,recipeCatalog:selected,before:before.shopping,after:{lists:[list],cycles:[cycle],items:[copied],purchases:[]},pantryBefore:before.pantry,pantryAfter:before.pantry,actionId:'retention-copy',author:a.deviceId,at});
 await save(a.runtime,'retention-copy',shopping);
 const pantry={version:1,kind:'pantry-create',commandId:'retention-pantry',effectId:'retention-pantry',dependencyEffectIds:[],data:{itemId:'retention-pantry',name:'Beans',preference:3,author:a.deviceId,at}};
 await save(a.runtime,'retention-pantry',[pantry]);
 const identity={version:1,scope,deviceId:a.deviceId,purpose:'data',epochId:a.root.epochId};
 const sourceKey=await keys.preparePairedDataKey('retention-source',identity,a.dataKey),{installLocalKey}=await import('../storage/local-keys.ts');
 await openSQLiteTransaction(a.connection)(true,tx=>installLocalKey(tx,sourceKey.record,sourceKey.catalog));
 const signingKeys=Object.assign(Object.create(keys),{use:(op,identity,fn)=>op==='retention-signing'?fn(a.signingTestKey.privateKey):keys.use(op,identity,fn)});
 const runtime=await openWorkspaceHouseholdRuntime({storage:a.storage,resolved:await resolveRuntimeAuthority(a.storage,scope,a.root.head,a.provider,a.deviceId),pin:a.root.head,provider:a.provider,sodium,keys:signingKeys,signing:{publicKey:sodium.to_hex(a.signingTestKey.publicKey),operationId:'retention-signing'},LoroDoc,decodeImportBlobMeta});
 const suspectEdit=await b.edit('retention-suspect',1,{legacy:true});
 must(await stage(a,suspectEdit,'direct'));
 await a.runtime.importItem(suspectEdit);
 let selectionRevision=0;
 const reports=householdCompromise({runtime,withCurrent:use=>use(selectionRevision)}).selected;
 const {confirmation}=await reports.open();
 await assert.rejects(()=>reports.prepare(confirmation,a.deviceId),/INVALID_REPORT_DEVICE/);
 const prepared=await reports.prepare(confirmation,b.deviceId);
 assert.deepEqual(new Set(prepared.operations.map(op=>op.documentId)),new Set([runtime.scope.documentId,child.scope.documentId]));
 const boundary={suspectDevice:b.deviceId,documentId:runtime.scope.documentId,objectId:suspectEdit.itemId};
 assert.ok(prepared.operations.some(op=>op.objectId===boundary.objectId&&op.authorDevice===b.deviceId));
 const beforeReport=a.rows();
 await assert.rejects(()=>reports.sign(prepared,{...boundary,documentId:child.scope.documentId}),/INVALID_BOUNDARY/);
 await assert.rejects(()=>reports.sign(prepared,{...boundary,suspectDevice:a.deviceId}),/INVALID_BOUNDARY/);
 selectionRevision++;
 await assert.rejects(()=>reports.sign(prepared,boundary),/STALE_REPORT_SELECTION/);
 assert.deepEqual(a.rows(),beforeReport);
 const currentConfirmation=(await reports.open()).confirmation;
 const currentPlan=await reports.prepare(currentConfirmation,b.deviceId);
 const {reportHash}=await reports.sign(currentPlan,boundary);
 assert.deepEqual((await reports.open()).reportHashes,[reportHash]);
 const inspected=await reports.inspect(currentConfirmation,reportHash);
 assert.deepEqual(inspected.boundary,{documentId:boundary.documentId,objectId:boundary.objectId});
 assert.equal(inspected.suspectDevice,b.deviceId);
 assert.deepEqual(inspected.operations,currentPlan.operations);
 const copy=shopping.find(command=>command.data.itemId===copied.id),prerequisite=field.find(command=>command.data.field==='amount');
 assert.ok(copy.data.recipeSource.effectIds.includes(prerequisite.effectId));
 const {selectedOperationReportService}=await import('../compromise/selected-report-service.mjs');
 const {planSelectedRetention}=await import('../compromise/selected-retention.mjs');
 const report=await selectedOperationReportService(runtime).reopen(reportHash);
 const earlier=intermediate.find(command=>command.data.field==='amount');
 assert.ok(prerequisite.dependencyEffectIds.includes(earlier.effectId));
 assert.ok(!copy.data.recipeSource.effectIds.includes(earlier.effectId));
 const all=report.evidence.map(row=>row.evidence.command.effectId);
 const selectedIds=all.filter(id=>id!==prerequisite.effectId&&id!=='retention-suspect'),beforeRows=a.rows();
 const {resolveSelectedReportStart}=await import('../compromise/selected-report-start.mjs');
 const start=await resolveSelectedReportStart(runtime,reportHash);
 assert.deepEqual(start.documents.map(({recipeId,snapshot,seedId,identities})=>[recipeId,snapshot.length,seedId,identities]),[
  [null,0,null,[]],['retention-recipe',0,null,[]],
 ]);
 const plan=await planSelectedRetention(runtime,{reportHash,selectedEffectIds:selectedIds});
 const row=id=>plan.rows.find(row=>row.effectId===id);
 assert.equal(row(prerequisite.effectId).status,'excluded');
 assert.equal(row(copy.effectId).status,'held');
 assert.equal(row(copy.effectId).reason,'EXCLUDED_DEPENDENCY');
 assert.equal(row('retention-pantry').status,'retained');
 assert.equal(row(copy.effectId).documentId,runtime.scope.documentId);
 assert.equal(row(prerequisite.effectId).recipeId,beforeRecipe.id);
 assert.deepEqual(a.rows(),beforeRows);
 assert.deepEqual(await planSelectedRetention(runtime,{reportHash,selectedEffectIds:[...selectedIds].reverse()}),plan);
 const {reconstructSelectedRetention}=await import('../compromise/selected-reconstruction.mjs');
 const draft=await reconstructSelectedRetention(runtime,{reportHash,selectedEffectIds:selectedIds});
 assert.equal(draft.complete,false);
 const rootDoc=new LoroDoc(),recipeDoc=new LoroDoc();
 rootDoc.import(draft.documents.find(d=>d.recipeId===null).snapshot);
 recipeDoc.import(draft.documents.find(d=>d.recipeId===beforeRecipe.id).snapshot);
 assert.equal(rootDoc.getMap('pantry:retention-pantry').get('name'),'Beans');
 assert.equal(recipeDoc.getMap('recipe:retention-recipe').get('title'),'Soup');
 assert.equal(recipeDoc.getMap('recipe-ingredient:'+encodeURIComponent(JSON.stringify(['retention-recipe','carrot']))).get('amount'),'3 cups');
 assert.equal(rootDoc.getMap('shopping-item:retention-item').get('value'),undefined);
 assert.equal(draft.rows.find(r=>r.effectId===prerequisite.effectId).status,'excluded');
 assert.equal(draft.rows.find(r=>r.effectId===copy.effectId).status,'held');
 const {saveSelectedRetention,reopenSelectedRetention}=await import('../compromise/selected-reconstruction.mjs');
 a.faultAt('selected-retention-draft');
 try {await assert.rejects(()=>saveSelectedRetention(runtime,{reportHash,selectedEffectIds:selectedIds}),/IO/);} finally {a.faultAt(null);}
 assert.deepEqual(a.rows(),beforeRows);
 const saved=await reports.saveDraft(currentConfirmation,reportHash,selectedIds);
 assert.equal(saved.replayed,false);
 const savedRows=a.rows();
 assert.deepEqual(await saveSelectedRetention(runtime,{reportHash,selectedEffectIds:[...selectedIds].reverse()}),{draftId:saved.draftId,replayed:true});
 assert.deepEqual(a.rows(),savedRows);
 a.reopen();
 let publicationFault;
 const reopenedStorage=openSQLiteStorage(a.connection,boundary=>{if(boundary===publicationFault)throw Error('injected failure');});
 const reopenedRuntime=await openWorkspaceHouseholdRuntime({storage:reopenedStorage,resolved:await resolveRuntimeAuthority(reopenedStorage,scope,a.root.head,a.provider,a.deviceId),pin:a.root.head,provider:a.provider,sodium,keys:signingKeys,signing:{publicKey:sodium.to_hex(a.signingTestKey.publicKey),operationId:'retention-signing'},LoroDoc,decodeImportBlobMeta});
 const reopened=await reopenSelectedRetention(reopenedRuntime,saved.draftId);
 const {checkedDraftSource}=await import('../compromise/checked-draft-source.mjs');
 const binding={draftId:saved.draftId,reportHash,suspectDevice:b.deviceId,sourceHead:report.report.payload.observation.manifest.parentHead,
  documents:draft.documents.map(({recipeId,documentId})=>({recipeId,documentId}))};
 const checkedDraft=await checkedDraftSource(reopenedRuntime,binding);
 const checkedRecipe=new LoroDoc();checkedRecipe.import(checkedDraft.documents[1].snapshot);
 assert.equal(checkedRecipe.getMap('recipe-ingredient:'+encodeURIComponent(JSON.stringify(['retention-recipe','carrot']))).get('amount'),'3 cups');
 assert.equal(checkedDraft.rows.find(r=>r.effectId===copy.effectId).status,'held');
 await assert.rejects(()=>checkedDraftSource(reopenedRuntime,{...binding,suspectDevice:a.deviceId}),/INVALID_DRAFT_SOURCE/);
 await assert.rejects(()=>checkedDraftSource(reopenedRuntime,{...binding,sourceHead:'wrong'}),/INVALID_DRAFT_SOURCE/);
 await assert.rejects(()=>checkedDraftSource(reopenedRuntime,{...binding,documents:[...binding.documents].reverse()}),/INVALID_DRAFT_SOURCE/);
 const {prepareDraftRotationProjection}=await import('../compromise/project-draft-rotation.mjs');
 const destination={parentHead:binding.sourceHead,documentId:'retention-rotation-root',epochId:'retention-rotation-epoch',generation:2};
 const allocateSeed=documentId=>documentId===runtime.scope.documentId?
  {seedId:'00000000-0000-4000-8000-000000000001',peerId:'100'}:
  {seedId:'00000000-0000-4000-8000-000000000002',peerId:'101'};
 const projectionArgs={runtime:reopenedRuntime,binding,destination,allocateSeed};
 const projection=await prepareDraftRotationProjection(projectionArgs);
 assert.deepEqual(projection.documents.map(doc=>doc.sourceDocumentId),binding.documents.map(doc=>doc.documentId));
 assert.deepEqual(projection.removed,[]);
 const [freshRoot,freshRecipe]=projection.documents.map(({seed})=>{const doc=new LoroDoc();doc.import(seed.snapshot);return doc;});
 assert.equal(freshRoot.getMap('pantry:retention-pantry').get('name'),'Beans');
 assert.equal(freshRoot.getMap('pantry:retention-suspect').get('name'),undefined);
 assert.equal(freshRoot.getMap('shopping-item:retention-item').get('value'),undefined);
 assert.equal(freshRecipe.getMap('recipe-ingredient:'+encodeURIComponent(JSON.stringify(['retention-recipe','carrot']))).get('amount'),'3 cups');
 assert.ok(projection.documents.every(doc=>doc.policyBundle.entries.every(entry=>entry.incomplete&&entry.policyHashes.includes(acceptedPolicy.policyHash))));
 assert.ok(projection.documents.every(doc=>doc.policyBundle.policies.some(row=>row.policyHash===acceptedPolicy.policyHash)));
 assert.deepEqual(await prepareDraftRotationProjection(projectionArgs),projection);
 const {verifyPublicParent}=await import('../pairing/household-recipient-proof.mjs');
 const {record:rotationRecord,state:rotationState,nodes:rotationNodes}=await verifyPublicParent(reopenedStorage,projection.source.expectedAuthority.scope,a.root.head,a.provider);
 const rotationParent=rotationNodes.get(rotationState.activeHead),wrap=sodium.crypto_box_keypair();
 const survivor=rotationParent.devices.find(d=>d.deviceId===a.deviceId),other=rotationParent.devices.find(d=>d.deviceId===c.deviceId),otherWrap=sodium.crypto_box_keypair();
 const rotationEvent={version:2,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',householdId:rotationParent.householdId,parentHead:rotationParent.head,policyHash:rotationParent.policyHash,generation:rotationParent.generation,epochId:rotationParent.epochId,proposalId:'retention-revoke',kind:'revokeDevice',authorDeviceId:a.deviceId,frozenAdultRoster:rotationParent.roster,subject:{deviceId:b.deviceId,documentId:destination.documentId,newGeneration:destination.generation,newEpochId:destination.epochId,devices:[{deviceId:a.deviceId,signingKeyRef:survivor.signingKeyRef,wrappingKeyRef:sodium.to_hex(wrap.publicKey),peerId:'102'},{deviceId:c.deviceId,signingKeyRef:other.signingKeyRef,wrappingKeyRef:sodium.to_hex(otherWrap.publicKey),peerId:'103'}]},nextPolicy:null};
 const signRotation=(purpose,body)=>sodium.to_hex(sodium.crypto_sign_detached(domain(purpose,body),a.signingTestKey.privateKey));
 const eventHash=sodium.to_hex(await a.provider.hash(domain('event',rotationEvent)));
 const approval={version:1,householdId:rotationParent.householdId,eventHash,parentHead:rotationParent.head,policyHash:rotationParent.policyHash,generation:rotationParent.generation,epochId:rotationParent.epochId,adultId:survivor.adultId,deviceId:a.deviceId};
 const item={event:rotationEvent,authorSignature:signRotation('event-signature',rotationEvent),approvals:[{...approval,signature:signRotation('approval-signature',approval)}]};
 const {prepareDraftRotationManifest}=await import('../compromise/draft-rotation-manifest.mjs');
 const candidate=await prepareDraftRotationManifest({runtime:reopenedRuntime,binding,item,allocateSeed});
 assert.equal(candidate.complete,true);
 const recipient={version:1,scopeId:rotationParent.householdId,parentHead:rotationParent.head,deviceId:a.deviceId,wrappingKey:sodium.to_hex(wrap.publicKey)};
 const otherRecipient={...recipient,deviceId:c.deviceId,wrappingKey:sodium.to_hex(otherWrap.publicKey)};
 const recipientBindings=[{...recipient,signature:signRotation('revocation-recipient',recipient)},{...otherRecipient,signature:sodium.to_hex(sodium.crypto_sign_detached(domain('revocation-recipient',otherRecipient),c.signingTestKey.privateKey))}];
 const {digest}=await import('../compromise/revocation.mjs');
 const grantBody={version:1,householdId:rotationParent.householdId,parentHead:rotationParent.head,eventHash,newEpochId:destination.epochId,newGeneration:destination.generation,documentId:destination.documentId,manifestHash:candidate.manifestHash,recipients:[a.deviceId,c.deviceId],packageRefs:['retention-package','retention-package-other'],contentClasses:['pantry','recipe','shopping'],disclosure:'current-state-only'};
 const bindingsHash=await digest(a.provider,'draft-rotation-recipient-bindings-v1',recipientBindings);
 const grant={...grantBody,signatures:[{adultId:survivor.adultId,deviceId:a.deviceId,signature:signRotation('draft-rotation-set-grant-vote-v1',{grant:grantBody,bindingsHash,adultId:survivor.adultId,deviceId:a.deviceId})}]};
 const {verifyDraftRotationGrant}=await import('../compromise/draft-rotation-grant.mjs');
 const verifyArgs={provider:a.provider,pin:a.root.head,parent:rotationParent,nodes:rotationNodes,state:rotationState,item,grant,manifest:candidate.manifest,recipientBindings};
 assert.equal((await verifyDraftRotationGrant(verifyArgs)).complete,true);
 const {authorDraftRotationSuccessor,verifyDraftRotationSuccessor}=await import('../compromise/draft-rotation-successor.mjs');
 const successorOptions={...verifyArgs,record:rotationRecord,documents:candidate.documents,LoroDoc,deviceId:a.deviceId,signingKey:survivor.signingKeyRef};
 const successor=await authorDraftRotationSuccessor(successorOptions);
 assert.deepEqual(successor.child.roster,rotationParent.roster);
 assert.deepEqual(successor.child.devices.filter(d=>!d.active).map(d=>d.deviceId),rotationParent.devices.filter(d=>!d.active||d.deviceId===b.deviceId).map(d=>d.deviceId));
 assert.equal(successor.record.acceptedParent,eventHash);
 await assert.rejects(()=>verifyDraftRotationSuccessor({...successorOptions,candidate:{...successor,child:{...successor.child,roster:[]}}}),/INVALID_SUCCESSOR/);

 const {sealDraftRotationFile,withOpenedDraftRotationFile}=await import('../pairing/draft-rotation-file.mjs');
 const codec={...verifyArgs,sodium,LoroDoc,documents:candidate.documents,recipientId:c.deviceId};
 const dataKeys=[sodium.randombytes_buf(32),sodium.randombytes_buf(32)];
 const file=await sealDraftRotationFile({...codec,keys:dataKeys,signingSecret:a.signingTestKey.privateKey});
 await withOpenedDraftRotationFile({...codec,file,wrappingSecret:otherWrap.privateKey},({keys,documents})=>{
  assert.deepEqual(keys,dataKeys); assert.deepEqual(documents,candidate.documents);
 });
 await assert.rejects(()=>withOpenedDraftRotationFile({...codec,file,recipientId:b.deviceId,wrappingSecret:otherWrap.privateKey},()=>{}));
 await assert.rejects(()=>withOpenedDraftRotationFile({...codec,file,recipientId:a.deviceId,wrappingSecret:wrap.privateKey},()=>{}));
 await assert.rejects(()=>withOpenedDraftRotationFile({...codec,file,wrappingSecret:sodium.crypto_box_keypair().privateKey},()=>{}));
 await assert.rejects(()=>sealDraftRotationFile({...codec,keys:[dataKeys[0],dataKeys[0]],signingSecret:a.signingTestKey.privateKey}),/INVALID_KEYS/);
 const {openDeviceCopy,sealDeviceCopy}=await import('../pairing/personal-copy.mjs');
 const fileHash=await digest(a.provider,'draft-rotation-file-binding-v1',{scope:rotationParent.householdId,pin:a.root.head,parentHead:rotationParent.head,
  manifestHash:candidate.manifestHash,grantHash:(await verifyDraftRotationGrant(verifyArgs)).grantHash,successorHead:eventHash,
  sender:a.deviceId,senderSigningKey:survivor.signingKeyRef,senderWrappingKey:recipient.wrappingKey,
  recipient:c.deviceId,recipientSigningKey:other.signingKeyRef,recipientWrappingKey:otherRecipient.wrappingKey,packageRef:'retention-package-other'});
 const fileDomain='draft-rotation-document-set-file-v1';
 const contents=openDeviceCopy(sodium,fileDomain,file,fileHash,{initiator:{signingPublicKey:a.signingTestKey.publicKey},responder:{wrappingPublicKey:otherWrap.publicKey}},otherWrap.privateKey);
 const reseal=value=>sealDeviceCopy(sodium,fileDomain,fileHash,{wrappingPublicKey:otherWrap.publicKey},a.signingTestKey.privateKey,value);
 await assert.rejects(()=>withOpenedDraftRotationFile({...codec,file:reseal({...contents,packets:[...contents.packets].reverse()}),wrappingSecret:otherWrap.privateKey},()=>{}),/INVALID_PROOF/);
 const alteredContents=structuredClone(contents);alteredContents.documents[1].policyBundle.version=99;
 await assert.rejects(()=>withOpenedDraftRotationFile({...codec,file:reseal(alteredContents),wrappingSecret:otherWrap.privateKey},()=>{}));
 const corrupt=file.slice();corrupt[corrupt.length-1]^=1;
 await assert.rejects(()=>withOpenedDraftRotationFile({...codec,file:corrupt,wrappingSecret:otherWrap.privateKey},()=>{}));
 const badDocuments=structuredClone(candidate.documents);badDocuments[1].policyBundle.version=99;
 await assert.rejects(()=>sealDraftRotationFile({...codec,documents:badDocuments,keys:dataKeys,signingSecret:a.signingTestKey.privateKey}));
 await assert.rejects(()=>withOpenedDraftRotationFile({...codec,file,grant:{...grant,manifestHash:'0'.repeat(64)},wrappingSecret:otherWrap.privateKey},()=>{}));
 await assert.rejects(()=>withOpenedDraftRotationFile({...codec,file,manifest:{...candidate.manifest,draftBindingHash:'0'.repeat(64)},wrappingSecret:otherWrap.privateKey},()=>{}));
 dataKeys.forEach(key=>key.fill(0));

 const previewItem={...item,approvals:[]},previewGrant={...grant,signatures:[]};
 assert.equal((await verifyDraftRotationGrant({...verifyArgs,item:previewItem,grant:previewGrant,requireQuorum:false})).complete,false);
 await assert.rejects(()=>verifyDraftRotationGrant({...verifyArgs,item:previewItem,grant:previewGrant}),/QUORUM_REQUIRED/);
 await assert.rejects(()=>verifyDraftRotationGrant({...verifyArgs,grant:{...grant,signatures:[{...grant.signatures[0],signature:'0'.repeat(128)}]},requireQuorum:false}),/INVALID_GRANT/);
 const alteredEntries=structuredClone(candidate.manifest.entries);alteredEntries[0].policyBundleHash='0'.repeat(64);
 await assert.rejects(()=>verifyDraftRotationGrant({...verifyArgs,manifest:{...candidate.manifest,entries:alteredEntries}}),/INVALID_GRANT/);
 await assert.rejects(()=>prepareDraftRotationManifest({runtime:reopenedRuntime,binding:{...binding,reportHash:'0'.repeat(64)},item,allocateSeed}));
 await assert.rejects(()=>prepareDraftRotationManifest({runtime:reopenedRuntime,binding:{...binding,suspectDevice:a.deviceId},item,allocateSeed}),/INVALID_DRAFT_SOURCE/);

 await assert.rejects(()=>verifyDraftRotationGrant({...verifyArgs,manifest:{...candidate.manifest,draftBindingHash:'0'.repeat(64)}}),/INVALID_GRANT/);
 await assert.rejects(()=>verifyDraftRotationGrant({...verifyArgs,recipientBindings:[{...recipientBindings[0],deviceId:b.deviceId}]}),/INVALID_RECIPIENT/);
 await assert.rejects(()=>prepareDraftRotationManifest({runtime:reopenedRuntime,binding:{...binding,draftId:'wrong'},item,allocateSeed}));
 assert.deepEqual(a.rows(),savedRows);

 await assert.rejects(()=>prepareDraftRotationProjection({...projectionArgs,destination:{...destination,epochId:a.root.epochId}}),/INVALID_DOCUMENT_SET/);
 const readSource=reopenedStorage.readDisclosureSource.bind(reopenedStorage);
 reopenedStorage.readDisclosureSource=(scopeId,effect)=>effect==='retention-pantry'?Promise.resolve({ok:true,value:null}):readSource(scopeId,effect);
 try {
  await assert.rejects(()=>prepareDraftRotationProjection(projectionArgs),/SOURCE_PROVENANCE_REQUIRED/);
  reopenedStorage.readDisclosureSource=async (scopeId,effect)=>{
   const result=await readSource(scopeId,effect);
   return effect==='retention-pantry'&&result.ok&&result.value?
    {ok:true,value:{...result.value,policyHashes:[]}}:result;
  };
  await assert.rejects(()=>prepareDraftRotationProjection(projectionArgs),/INVALID_SOURCE_PROOF/);
 }
 finally {reopenedStorage.readDisclosureSource=readSource;}
 assert.deepEqual(a.rows(),savedRows);
 assert.deepEqual(reopened.rows,draft.rows);
 const reopenedReports=householdCompromise({runtime:reopenedRuntime,withCurrent:use=>use(0)}).selected;
 const reopenedSession=await reopenedReports.open();
 assert.deepEqual(reopenedSession.draftIds,[saved.draftId]);
 const preview=await reopenedReports.reopenDraft(reopenedSession.confirmation,saved.draftId);
 assert.deepEqual(preview.rows,draft.rows);
 assert.deepEqual(preview.pantry,['Beans']);
 assert.deepEqual(preview.recipes,['Soup']);
 assert.deepEqual(preview.shopping,[]);
 assert.equal(preview.rows.find(row=>row.effectId==='retention-suspect').authorship,'suspect');
 assert.ok(!Object.hasOwn(preview,'documents'));
 const draftKey=JSON.stringify(['compromise-selected-draft-v1',scope.id,saved.draftId]);
 const stored=a.connection.executeSync('SELECT value FROM loro_records WHERE key=?',[draftKey]).rows[0].value;
 const altered=JSON.parse(stored);altered.selectedEffectIds=[];
 a.connection.executeSync('UPDATE loro_records SET value=? WHERE key=?',[JSON.stringify(altered),draftKey]);
 try {await assert.rejects(()=>reopenSelectedRetention(reopenedRuntime,saved.draftId),/CORRUPT/);await assert.rejects(()=>checkedDraftSource(reopenedRuntime,binding),/CORRUPT/);} finally {a.connection.executeSync('UPDATE loro_records SET value=? WHERE key=?',[stored,draftKey]);}
 const originalsKey=JSON.stringify(['compromise-selected-originals-v2',scope.id,reportHash]);
 const originals=a.connection.executeSync('SELECT value FROM loro_records WHERE key=?',[originalsKey]).rows[0].value;
 const damaged=JSON.parse(originals);damaged.objects[0].bytes.__storageBytes[0]^=1;
 a.connection.executeSync('UPDATE loro_records SET value=? WHERE key=?',[JSON.stringify(damaged),originalsKey]);
 try {await assert.rejects(()=>reopenSelectedRetention(reopenedRuntime,saved.draftId));} finally {a.connection.executeSync('UPDATE loro_records SET value=? WHERE key=?',[originals,originalsKey]);}
 const originalGuard=a.storage.checkSelectedHouseholdSources.bind(a.storage);
 a.storage.checkSelectedHouseholdSources=async()=>({ok:false,error:{code:'CONFLICT'}});
 try {await assert.rejects(()=>reopenSelectedRetention(runtime,saved.draftId),/CONFLICT/);} finally {a.storage.checkSelectedHouseholdSources=originalGuard;}
 const withoutEarlier=await reconstructSelectedRetention(runtime,{reportHash,selectedEffectIds:all.filter(id=>id!==earlier.effectId)});
 assert.equal(withoutEarlier.rows.find(r=>r.effectId===copy.effectId).reason,'HELD_DEPENDENCY');
 const completeSelection=await reconstructSelectedRetention(runtime,{reportHash,selectedEffectIds:all});
 const copiedRoot=new LoroDoc();
 copiedRoot.import(completeSelection.documents.find(d=>d.recipeId===null).snapshot);
 assert.equal(completeSelection.rows.find(r=>r.effectId===copy.effectId).status,'retained');
 assert.equal(copiedRoot.getMap('shopping-item-fields:retention-item').get('displayQuantity'),'2 cups');
 assert.equal(copiedRoot.getMap('shopping-item-fields:retention-item').get('ingredientId'),'carrot');
 assert.deepEqual(a.rows(),savedRows);
 const originalCheck=a.storage.checkSelectedHouseholdSources.bind(a.storage);
 a.storage.checkSelectedHouseholdSources=async()=>({ok:false,error:{code:'CONFLICT'}});
 try {await assert.rejects(()=>reconstructSelectedRetention(runtime,{reportHash,selectedEffectIds:selectedIds}),/CONFLICT/);} finally {a.storage.checkSelectedHouseholdSources=originalCheck;}
 await assert.rejects(()=>reconstructSelectedRetention(runtime,{reportHash,selectedEffectIds:['not-in-batch']}),/UNKNOWN_EFFECT/);
 const allPlan=await planSelectedRetention(runtime,{reportHash,selectedEffectIds:all});
 const fieldRow=allPlan.rows.find(row=>row.effectId===prerequisite.effectId),copyRow=allPlan.rows.find(row=>row.effectId===copy.effectId);
 assert.equal(copyRow.status,'retained');assert.ok(fieldRow.order<copyRow.order);
 await assert.rejects(()=>planSelectedRetention(runtime,{reportHash,selectedEffectIds:['not-in-batch']}),/UNKNOWN_EFFECT/);
 const check=a.storage.checkSelectedHouseholdSources.bind(a.storage);let checks=0;
 a.storage.checkSelectedHouseholdSources=async guard=>++checks===7?{ok:false,error:{code:'CONFLICT'}}:check(guard);
 try {await assert.rejects(()=>planSelectedRetention(runtime,{reportHash,selectedEffectIds:selectedIds}),/CONFLICT/);} finally {a.storage.checkSelectedHouseholdSources=check;}
 assert.deepEqual(a.rows(),savedRows);
 const {publishDraftRotation}=await import('../compromise/publish-draft-rotation.mjs');
 const publicationConfirmation={explicit:true,eventHash,grantHash:(await verifyDraftRotationGrant(verifyArgs)).grantHash};
 const publishArgs={runtime:reopenedRuntime,sodium,keys:signingKeys,signingKey:survivor.signingKeyRef,
  withSigningSecret:use=>use(a.signingTestKey.privateKey),binding,proposal:{item,grant,manifest:candidate.manifest,recipientBindings},confirmation:publicationConfirmation};
 await assert.rejects(()=>publishDraftRotation({...publishArgs,confirmation:{...publicationConfirmation,explicit:false}}),/CONFIRMATION_REQUIRED/);
 await assert.rejects(()=>publishDraftRotation({...publishArgs,confirmation:{...publicationConfirmation,grantHash:'0'.repeat(64)}}),/REVIEW_CHANGED/);
 for(const fault of ['draft-rotation-keys','draft-rotation-files']){
  publicationFault=fault;
  try {await assert.rejects(()=>publishDraftRotation(publishArgs),/IO/);}
  finally {publicationFault=null;}
  assert.deepEqual(a.rows(),savedRows);
 }
 const commitRotation=reopenedStorage.commitDraftRotationPublication.bind(reopenedStorage);
 reopenedStorage.commitDraftRotationPublication=async (...args)=>{
  a.connection.executeSync('UPDATE loro_records SET value=? WHERE key=?',[JSON.stringify(damaged),originalsKey]);
  try {return await commitRotation(...args);}
  finally {a.connection.executeSync('UPDATE loro_records SET value=? WHERE key=?',[originals,originalsKey]);}
 };
 try {await assert.rejects(()=>publishDraftRotation(publishArgs),/CONFLICT/);}
 finally {reopenedStorage.commitDraftRotationPublication=commitRotation;}
 assert.deepEqual(a.rows(),savedRows);

 // Keep the real late-edit check below on the original fixture.
 const publishedDb=new DatabaseSync(':memory:');
 t.after(()=>publishedDb.close());
 publishedDb.exec('CREATE TABLE loro_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
 const insert=publishedDb.prepare('INSERT INTO loro_records VALUES (?,?)');
 for(const row of savedRows)insert.run(row.key,row.value);
 const publishedStorage=openSQLiteStorage({executeSync(sql,params=[]){
  const statement=publishedDb.prepare(sql);
  return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])};
 }});
 const publishedKeys=publishedStorage.localKeys(master,sodium);
 const publisherKeys=Object.assign(Object.create(publishedKeys),{use:(op,identity,fn)=>op==='retention-signing'?fn(a.signingTestKey.privateKey):publishedKeys.use(op,identity,fn)});
 const publisher=await openWorkspaceHouseholdRuntime({storage:publishedStorage,resolved:await resolveRuntimeAuthority(publishedStorage,scope,a.root.head,a.provider,a.deviceId),
  pin:a.root.head,provider:a.provider,sodium,keys:publisherKeys,signing:{publicKey:sodium.to_hex(a.signingTestKey.publicKey),operationId:'retention-signing'},LoroDoc,decodeImportBlobMeta});
 assert.deepEqual(await publishDraftRotation({...publishArgs,runtime:publisher,keys:publisherKeys}),{operationId:'retention-revoke',head:eventHash});
 const publication=must(await publishedStorage.readDraftRotationPublication(scope.id,'retention-revoke'));
 assert.deepEqual(publication.next,successor.record);
 assert.equal(must(await publishedStorage.readAdultRemovalPublication(scope.id,'retention-revoke')),null);
 assert.deepEqual(publication.documents.map(row=>row.bytes),candidate.documents.map(row=>row.seed.snapshot));
 assert.deepEqual(publication.files.map(row=>row.recipientDeviceId),[c.deviceId]);
 const [,purpose,proof]=JSON.parse(new TextDecoder().decode(publication.proof));
 assert.equal(purpose,'draft-rotation-publication-v1');
 assert.ok(await a.provider.verify(survivor.signingKeyRef,domain(purpose,proof.body),sodium.from_hex(proof.signature)));
 await withOpenedDraftRotationFile({...codec,file:publication.files[0].bytes,wrappingSecret:otherWrap.privateKey},async ({keys})=>{
  for(const [i,{operationId,identity,keyHash}] of proof.body.keyCommitments.entries()){
   await publisherKeys.use(operationId,identity,key=>{
    assert.deepEqual(key,keys[i]);
    assert.equal(keyHash,sodium.to_hex(sodium.crypto_generichash(32,key)));
   });
  }
 });
 const {reopenDraftRotationSponsor,releaseDraftRotation}=await import('../compromise/release-draft-rotation.mjs');
 const releaseOptions={storage:publishedStorage,scope,operationId:'retention-revoke',pin:a.root.head,provider:a.provider,sodium,LoroDoc,keys:publisherKeys,deviceId:a.deviceId};
 const beforeRelease=publishedDb.prepare('SELECT key,value FROM loro_records ORDER BY key').all();
 const metadata=await reopenDraftRotationSponsor(releaseOptions);
 assert.deepEqual(metadata.record,publication.next);
 const exported=await releaseDraftRotation({...releaseOptions,recipientDeviceId:c.deviceId});
 assert.deepEqual(exported.bytes,publication.files[0].bytes);
 assert.deepEqual(exported.proof,publication.proof);
 for(const recipientDeviceId of [b.deviceId,a.deviceId,'wrong'])await assert.rejects(()=>releaseDraftRotation({...releaseOptions,recipientDeviceId}));
 await assert.rejects(()=>reopenDraftRotationSponsor({...releaseOptions,deviceId:c.deviceId}));
 await assert.rejects(()=>releaseDraftRotation({...releaseOptions,deviceId:c.deviceId,recipientDeviceId:c.deviceId}));
 const readPublication=publishedStorage.readDraftRotationPublication.bind(publishedStorage);
 const readAuthorityRecord=publishedStorage.readPairingAuthority.bind(publishedStorage);
 for(const mutate of [
  p=>{const envelope=JSON.parse(new TextDecoder().decode(p.proof));envelope[2].signature='0'.repeat(128);p.proof=domain(envelope[1],envelope[2]);}, p=>{p.files[0].bytes[0]^=1},
  p=>{p.documents[0].bytes[0]^=1}, p=>{p.documents[0].sourceRevision++},
  p=>{p.documents[0].localKey.record.wrapped[0]^=1},
  p=>{p.expected.authorizationSnapshot='0'.repeat(64)},
 ]) {
  publishedStorage.readDraftRotationPublication=async (...args)=>{const result=await readPublication(...args);const value=structuredClone(result.value);mutate(value);return {ok:true,value};};
  try {await assert.rejects(()=>reopenDraftRotationSponsor(releaseOptions));} finally {publishedStorage.readDraftRotationPublication=readPublication;}
 }
 publishedStorage.readPairingAuthority=async (...args)=>{const result=await readAuthorityRecord(...args);return {ok:true,value:{...result.value,revision:result.value.revision+1}};};
 try {await assert.rejects(()=>reopenDraftRotationSponsor(releaseOptions));} finally {publishedStorage.readPairingAuthority=readAuthorityRecord;}
 await assert.rejects(()=>reopenDraftRotationSponsor({...releaseOptions,keys:{use:async()=>{throw Error('missing key')}}}));
 await assert.rejects(()=>reopenDraftRotationSponsor({...releaseOptions,keys:{use:async (op,id,fn)=>fn(new Uint8Array(32))}}));
 assert.deepEqual(publishedDb.prepare('SELECT key,value FROM loro_records ORDER BY key').all(),beforeRelease);
 const archived=publishedDb.prepare('SELECT value FROM loro_records WHERE key=?');
 for(const row of savedRows.filter(({key})=>JSON.parse(key)[0]!=='pairing-authority'))assert.equal(archived.get(row.key).value,row.value);
 await assert.rejects(()=>readAuthority(publishedStorage,scope,a.root.head,a.provider),/INVALID_ROTATION/);

 const stalePlan=await reports.prepare(currentConfirmation,b.deviceId);
 await save(a.runtime,'retention-later',[{...pantry,commandId:'retention-later',effectId:'retention-later',data:{...pantry.data,itemId:'retention-later'}}]);
 const afterEdit=a.rows();
 await assert.rejects(()=>reports.sign(stalePlan,boundary),/STALE_SOURCE/);
 assert.deepEqual(a.rows(),afterEdit);
 await assert.rejects(()=>reopenSelectedRetention(reopenedRuntime,saved.draftId));
 await assert.rejects(()=>checkedDraftSource(reopenedRuntime,binding));
 await assert.rejects(()=>prepareDraftRotationProjection(projectionArgs));
 await assert.rejects(()=>prepareDraftRotationManifest({runtime:reopenedRuntime,binding,item,allocateSeed}));
 await assert.rejects(()=>publishDraftRotation(publishArgs));
 assert.deepEqual(a.rows(),afterEdit);
});

test('mounted admission rule stages a signed recipe set',async t=>{
 const [a]=await household(t,{onDisk:true}), keys=a.storage.localKeys(testMaster(),sodium);
 await keys.provision('rule-master');
 const policy=await prepareInitialPolicy({service:a.service,enforcement:'block'});
 await acceptInitialPolicy({service:a.service,provider:a.provider,deviceId:a.deviceId,policy,explicit:true});
 await a.edit('rule-root',1);
 const recipe=await a.runtime.forRecipe('rule-recipe');
 const after={id:'rule-recipe',title:'Soup',portions:2,ingredients:[],steps:[],stepIds:[],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
 await executeAction(recipe,{reserve:async()=>2},'rule-recipe',planRecipeAction({doc:(await recipe.document()).doc,before:null,after,actionId:'rule-recipe',author:a.deviceId,at:after.createdAt}),a.service);
 const identity={version:1,scope,deviceId:a.deviceId,purpose:'data',epochId:a.root.epochId};
 const sourceKey=await keys.preparePairedDataKey('rule-source',identity,a.dataKey);
 const {installLocalKey}=await import('../storage/local-keys.ts');
 await openSQLiteTransaction(a.connection)(true,tx=>installLocalKey(tx,sourceKey.record,sourceKey.catalog));
 const signingKeys=Object.assign(Object.create(keys),{use:(op,identity,fn)=>op==='rule-signing'?fn(a.signingTestKey.privateKey):keys.use(op,identity,fn)});
 const signing={publicKey:sodium.to_hex(a.signingTestKey.publicKey),operationId:'rule-signing'};
 const runtime=await openWorkspaceHouseholdRuntime({storage:a.storage,resolved:await resolveRuntimeAuthority(a.storage,scope,a.root.head,a.provider,a.deviceId),pin:a.root.head,provider:a.provider,sodium,keys:signingKeys,signing,LoroDoc,decodeImportBlobMeta});
 {
  const {verifySelectedEvidence}=await import('../compromise/selected-evidence.mjs');
  const root=must(await a.storage.getLocalOperation(scope.id,'rule-root'));
  const child=must(await a.storage.getLocalOperation(scope.id,'rule-recipe'));
  const candidate=(operation,documentId)=>{const object=operation.commit.outbound[0].object;return {sourceId:'fixture',objectId:object.id,documentId,bytes:object.bytes};};
  const batch=[candidate(root,runtime.scope.documentId),candidate(child,(await runtime.forRecipe('rule-recipe')).scope.documentId)];
  const before=a.rows();
  const verified=await verifySelectedEvidence(runtime,batch);
  assert.deepEqual(verified.results.map(row=>row.status),['verified','verified'],JSON.stringify(verified.results));
  assert.deepEqual(verified.results.map(row=>row.recipeId),[null,'rule-recipe']);
  assert.deepEqual(verified.results[1].bytes,batch[1].bytes);
  assert.deepEqual(a.rows(),before);
  const other=await a.runtime.forRecipe('rule-sibling');
  const sibling={...after,id:'rule-sibling'};
  await executeAction(other,{reserve:async()=>3},'rule-sibling',planRecipeAction({doc:(await other.document()).doc,before:null,after:sibling,actionId:'rule-sibling',author:a.deviceId,at:after.createdAt}),a.service);
  const otherId=(await runtime.forRecipe('rule-sibling')).scope.documentId;
  assert.equal((await verifySelectedEvidence(runtime,[{...batch[1],documentId:otherId}])).results[0].status,'rejected');
  const bad=JSON.parse(new TextDecoder().decode(batch[1].bytes));bad.signature='0'.repeat(128);
  assert.equal((await verifySelectedEvidence(runtime,[{...batch[1],bytes:new TextEncoder().encode(JSON.stringify(bad))}])).results[0].status,'rejected');
  assert.equal((await verifySelectedEvidence(runtime,[{...batch[1],documentId:'missing'}])).results[0].status,'unavailable');
  await assert.rejects(()=>verifySelectedEvidence(runtime,Array(REVIEW_LIMITS.objects+1).fill(batch[0])),/TOO_LARGE/);
  const {buildSelectedOperationReport,verifySelectedOperationReport}=await import('../compromise/selected-report.mjs');
  const boundary={documentId:batch[1].documentId,objectId:batch[1].objectId};
  const reportBefore=a.rows();
  const plan=await buildSelectedOperationReport(runtime,{candidates:batch,suspectDevice:'device-1',boundary});
  const verify=report=>verifySelectedOperationReport(runtime,{report,candidates:batch});
  assert.deepEqual((await verify(plan.report)).evidence.map(row=>row.recipeId),[null,'rule-recipe']);
  await assert.rejects(()=>buildSelectedOperationReport(runtime,{candidates:batch,suspectDevice:'device-1',boundary:{...boundary,documentId:otherId}}),/INVALID_BOUNDARY/);
  await assert.rejects(()=>buildSelectedOperationReport(runtime,{candidates:[batch[0],{...batch[1],documentId:otherId}],suspectDevice:'device-1',boundary:{...boundary,documentId:otherId}}),/UNVERIFIED_EVIDENCE/);
  const changed=structuredClone(plan.report);changed.payload.observation.manifest.catalog.hash='0'.repeat(64);
  await assert.rejects(()=>verify(changed),/INVALID_REPORT_SIGNATURE/);
  const signedWrong=structuredClone(plan.report);signedWrong.signature='0'.repeat(128);
  await assert.rejects(()=>verify(signedWrong),/INVALID_REPORT_SIGNATURE/);
  const alteredBytes=batch.map(row=>({...row,bytes:new Uint8Array(row.bytes)}));alteredBytes[1].bytes[0]^=1;
  await assert.rejects(()=>verifySelectedOperationReport(runtime,{report:plan.report,candidates:alteredBytes}),/EVIDENCE_MISMATCH/);
  await assert.rejects(()=>buildSelectedOperationReport(runtime,{candidates:[batch[0],batch[0]],suspectDevice:'device-1',boundary:{documentId:batch[0].documentId,objectId:batch[0].objectId}}),/DUPLICATE_EVIDENCE/);
  const authorization=runtime.authorization.bind(runtime);
  runtime.authorization=async()=>{const auth=await authorization();return {...auth,expectedAuthority:{...auth.expectedAuthority,record:{...auth.expectedAuthority.record,authorizationSnapshot:'stale'}}};};
  try {await assert.rejects(()=>verify(plan.report),/STALE_AUTHORITY/);} finally {runtime.authorization=authorization;}
  assert.deepEqual(a.rows(),reportBefore);
  const staleHead=structuredClone(plan.report);staleHead.payload.head='wrong-head';
  await assert.rejects(()=>verify(staleHead),/STALE_AUTHORITY/);
  const guardCheck=a.storage.checkSelectedHouseholdSources.bind(a.storage);let guardCalls=0;
  a.storage.checkSelectedHouseholdSources=async guard=>++guardCalls===3?{ok:false,error:{code:'CONFLICT'}}:guardCheck(guard);
  try {await assert.rejects(()=>buildSelectedOperationReport(runtime,{candidates:batch,suspectDevice:'device-1',boundary}),/CONFLICT/);} finally {a.storage.checkSelectedHouseholdSources=guardCheck;}
  assert.deepEqual(a.rows(),reportBefore);
  const check=a.storage.checkSelectedHouseholdSources.bind(a.storage);let calls=0;
  a.storage.checkSelectedHouseholdSources=async guard=>++calls===2?{ok:false,error:{code:'CONFLICT'}}:check(guard);
  try {await assert.rejects(()=>verifySelectedEvidence(runtime,batch),/CONFLICT/);} finally {a.storage.checkSelectedHouseholdSources=check;}

  const {selectedOperationReportService}=await import('../compromise/selected-report-service.mjs');
  const service=selectedOperationReportService(runtime),beforeFreeze=a.rows();
  const frozen=await service.freeze({report:plan.report,candidates:batch});
  assert.equal(frozen.replayed,false);
  const afterFreeze=a.rows(),beforeKeys=new Set(beforeFreeze.map(row=>row.key));
  assert.deepEqual(afterFreeze.filter(row=>!beforeKeys.has(row.key)).map(row=>JSON.parse(row.key)[0]).sort(),['compromise-selected-originals-v2','compromise-selected-report-v2']);
  assert.deepEqual(afterFreeze.filter(row=>beforeKeys.has(row.key)),beforeFreeze);
  a.reopen();
  assert.deepEqual((await service.reopen(frozen.reportHash)).evidence.map(row=>row.recipeId),[null,'rule-recipe']);
  const persisted=a.rows();
  assert.deepEqual(await service.freeze({report:plan.report,candidates:batch}),{reportHash:frozen.reportHash,replayed:true});
  assert.deepEqual(a.rows(),persisted);
  const originalKey=JSON.stringify(['compromise-selected-originals-v2',scope.id,frozen.reportHash]);
  const originalRow=a.rows().find(row=>row.key===originalKey),corruptOriginal=JSON.parse(originalRow.value);
  corruptOriginal.objects[0].bytes.__storageBytes[0]^=1;
  a.replaceRow(originalKey,JSON.stringify(corruptOriginal));
  await assert.rejects(()=>service.reopen(frozen.reportHash),/EVIDENCE_MISMATCH/);
  await assert.rejects(()=>service.freeze({report:plan.report,candidates:batch}),/CONFLICT/);
  a.replaceRow(originalKey,originalRow.value);
  const recordKey=JSON.stringify(['compromise-selected-report-v2',scope.id,frozen.reportHash]);
  const recordRow=a.rows().find(row=>row.key===recordKey),corruptRecord=JSON.parse(recordRow.value);corruptRecord.version=1;
  a.replaceRow(recordKey,JSON.stringify(corruptRecord));
  await assert.rejects(()=>service.reopen(frozen.reportHash),/CORRUPT/);
  a.replaceRow(recordKey,recordRow.value);
  const otherPlan=await buildSelectedOperationReport(runtime,{candidates:batch,suspectDevice:'device-1',boundary:{documentId:batch[0].documentId,objectId:batch[0].objectId}});
  const beforeFault=a.rows();a.faultAt('selected-report-originals');
  try {await assert.rejects(()=>service.freeze({report:otherPlan.report,candidates:batch}),/IO/);} finally {a.faultAt(null);}
  assert.deepEqual(a.rows(),beforeFault);
  const originalFreeze=a.storage.freezeSelectedOperationReport.bind(a.storage);
  a.storage.freezeSelectedOperationReport=async input=>{
   const doc=(await other.document()).doc,prior=projectCooking(doc).recipes.find(row=>row.id==='rule-sibling');
   const commands=planRecipeAction({doc,before:prior,after:{...prior,title:'Raced soup'},actionId:'rule-race',author:a.deviceId,at:after.createdAt});
   await executeAction(other,{reserve:async()=>4},'rule-race',commands,a.service);
   return originalFreeze(input);
  };
  try {await assert.rejects(()=>service.freeze({report:otherPlan.report,candidates:batch}),/CONFLICT/);} finally {a.storage.freezeSelectedOperationReport=originalFreeze;}
  assert.equal(a.rows().filter(row=>JSON.parse(row.key)[0]==='compromise-selected-report-v2').length,1);
  await assert.rejects(()=>service.reopen(frozen.reportHash),/STALE_SOURCE/);

 }
 const pairing={name:'fixture',sodium,storage:a.storage,provider:a.provider,store:fixtureSessionStore(a.connection),scope,pin:a.root.head,deviceId:a.deviceId,adultId:'adult',runtime,service:a.service,keys:signingKeys,signing,wrapping:{},LoroDoc};
 const api=householdPairing({...pairing,selectedHousehold:false}).admissionRule;
 const joinedRules=householdPairing({...pairing,selectedHousehold:true}).admissionRule;
 const proposal={policy:{kind:'unanimous',fixedCount:null},expectedHead:a.root.head,explicit:true};
 await assert.rejects(()=>joinedRules.propose(proposal),/UNSUPPORTED_VERSION/);
 const item=await api.propose(proposal);
 assert.equal(item.event.version,6); assert.equal(item.event.subject.documentCount,3);
 const review=await api.review(item), approved=await api.approve({item,confirmedEventHash:review.eventHash,explicit:true});
 await assert.rejects(()=>joinedRules.review(item),/UNSUPPORTED_VERSION/);
 await assert.rejects(()=>joinedRules.retain({item:approved.item,confirmedEventHash:review.eventHash,explicit:true}),/UNSUPPORTED_VERSION/);
 assert.deepEqual(approved.item.documentSet,item.documentSet);
 const altered=structuredClone(approved.item); altered.documentSet.body.observation.manifest.children[0].revision++;
 await assert.rejects(()=>api.retain({item:altered,confirmedEventHash:review.eventHash,explicit:true}));
 const staged=await api.retain({item:approved.item,confirmedEventHash:review.eventHash,explicit:true});
 assert.equal(staged.targetHead,review.eventHash);
 assert.deepEqual((await readVerifiedPolicyDocumentSet({runtime,targetHead:staged.targetHead})).signed,item.documentSet);
 await a.edit('rule-later',3);
 await assert.rejects(()=>api.retain({item:approved.item,confirmedEventHash:review.eventHash,explicit:true}),/STALE_SOURCE/);
 assert.equal((await readAuthority(a.storage,scope,a.root.head,a.provider)).activeHead,a.root.head);
});

test('retained policy activation authenticates signed history and local keys',async t=>{
 const [a]=await household(t), master=testMaster(), keys=a.storage.localKeys(master,sodium);
 await keys.provision('retained-master');
 const policy=await prepareInitialPolicy({service:a.service,enforcement:'block'});
 const accepted=await acceptInitialPolicy({service:a.service,provider:a.provider,deviceId:a.deviceId,policy,explicit:true});
 await a.edit('retained-root',1);
 const recipe=await a.runtime.forRecipe('retained-recipe');
 const after={id:'retained-recipe',title:'Soup',portions:2,ingredients:[],steps:[],stepIds:[],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
 const {doc}=await recipe.document();
 const commands=planRecipeAction({doc,before:null,after,actionId:'retained-recipe',author:a.deviceId,at:'2026-01-01T00:00:00Z'});
 await executeAction(recipe,{reserve:async()=>2},'retained-recipe',commands,a.service);
 const identity={version:1,scope,deviceId:a.deviceId,purpose:'data',epochId:a.root.epochId};
 const sourceKey=await keys.preparePairedDataKey('fixture-source',identity,a.dataKey);
 const {installLocalKey}=await import('../storage/local-keys.ts');
 await openSQLiteTransaction(a.connection)(true,tx=>installLocalKey(tx,sourceKey.record,sourceKey.catalog));
 const signingKeys=Object.assign(Object.create(keys),{use:(op,identity,fn)=>op==='fixture-signing'?fn(a.signingTestKey.privateKey):keys.use(op,identity,fn)});
 const signing={publicKey:sodium.to_hex(a.signingTestKey.publicKey),operationId:'fixture-signing'};
 const sourceRuntime=await openWorkspaceHouseholdRuntime({storage:a.storage,resolved:await resolveRuntimeAuthority(a.storage,scope,a.root.head,a.provider,a.deviceId),pin:a.root.head,provider:a.provider,sodium,keys:signingKeys,signing,LoroDoc,decodeImportBlobMeta});
 const full=await observePolicyDocumentSet(sourceRuntime), options={storage:a.storage,scope,pin:a.root.head,provider:a.provider,LoroDoc,signed:full.signed,retained:full.sources.map(x=>({documentId:x.runtime.scope.documentId,revision:x.revision,bytes:x.bytes??new Uint8Array()}))};
 const subject=await policyDocumentSetSubject(options), manifest=full.signed.body.observation.manifest;
 const parent=(await verifyPolicyDocumentSet(options)).selected;
 const event={version:6,kind:'changePolicy',authorDeviceId:a.deviceId,householdId:scope.id,parentHead:parent.head,epochId:parent.epochId,generation:parent.generation,subject,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',policyHash:parent.policyHash,proposalId:'retained-policy',frozenAdultRoster:parent.roster,nextPolicy:parent.policy};
 const targetHead=sodium.to_hex(await a.provider.hash(domain('event',event))),author=parent.devices.find(d=>d.deviceId===a.deviceId);
 const sign=async(kind,value)=>sodium.to_hex(await a.provider.sign(author.signingKeyRef,domain(kind,value)));
 const vote={version:1,householdId:scope.id,eventHash:targetHead,parentHead:parent.head,policyHash:parent.policyHash,generation:parent.generation,epochId:parent.epochId,adultId:author.adultId,deviceId:a.deviceId};
 const item={event,authorSignature:await sign('event-signature',event),approvals:[{...vote,signature:await sign('approval-signature',vote)}]};
 const staged=await stageVerifiedPolicyDocumentSet({runtime:sourceRuntime,item,signed:full.signed});
 const {capturePolicySourceEvidence}=await import('./capture-policy-source-evidence.mjs');
 const capture=()=>capturePolicySourceEvidence({runtime:sourceRuntime,targetHead,service:a.service,sodium});
 const evidenceCapture=await capture();
 assert.deepEqual(evidenceCapture.body.rows.map(x=>x.targetDocumentId),staged.mapping.map(x=>x.targetDocumentId));
 assert.ok(evidenceCapture.body.rows.every(x=>x.sources.length && x.sources.every(y=>y.incomplete)));
 assert.ok(evidenceCapture.body.rows.every(x=>x.sources.some(y=>y.policyHashes.includes(accepted.policyHash))));
 assert.deepEqual(await capture(),evidenceCapture);
 assert.ok(!JSON.stringify(evidenceCapture.body).includes('snapshot'));
 const tampered=Object.assign(Object.create(a.storage),{readStagedPolicyDocumentSet:async (...args)=>{const result=await a.storage.readStagedPolicyDocumentSet(...args);result.value.mapping[1].targetDocumentId='wrong';return result;}});
 await assert.rejects(()=>capturePolicySourceEvidence({runtime:Object.assign(Object.create(a.runtime),{storage:tampered}),targetHead,service:a.service,sodium}));
 const racing=Object.assign(Object.create(a.storage),{checkSelectedHouseholdSources:async()=>({ok:false,error:{code:'STALE_SOURCE'}})});
 await assert.rejects(()=>capturePolicySourceEvidence({runtime:Object.assign(Object.create(a.runtime),{storage:racing}),targetHead,service:a.service,sodium}));
 const expected=must(await a.storage.readPairingAuthority(scope));
 const confirm={runtime:sourceRuntime,expectedSourceHead:expected.acceptedParent,expectedSourceRevision:expected.revision,targetHead,service:a.service,sodium,keys:signingKeys};
 const beforeConfirmation=a.rows();
 await assert.rejects(()=>activateStagedPolicyDocumentSet({...confirm,expectedSourceRevision:expected.revision+1}),/STALE_SOURCE/);
 await assert.rejects(()=>activateStagedPolicyDocumentSet({...confirm,targetHead:'wrong'}));
 assert.deepEqual(a.rows(),beforeConfirmation);
 const commit=a.storage.commitPolicyDocumentSetSelection.bind(a.storage);
 a.storage.commitPolicyDocumentSetSelection=async args=>{const result=await commit(args); assert.equal(result.ok,true); return {ok:false,error:{code:'CONFLICT'}};};
 const activated=await activateStagedPolicyDocumentSet(confirm);
 a.storage.commitPolicyDocumentSetSelection=commit;
 const nextState=JSON.parse(new TextDecoder().decode(activated.record.authorityState));
 const receipt=must(await a.storage.readActivatedPolicyDocumentSet(scope.id,targetHead)).receipt;
 const provenance=receipt.provenance;
 const prepared=receipt.targets.map(target=>({record:{identity:target.identity}}));
 assert.equal(await a.provider.verify(author.signingKeyRef,provenance.statement,Uint8Array.from(provenance.signature.match(/../g),x=>parseInt(x,16))),true);
 const afterActivation=a.rows();
 assert.deepEqual(await activateStagedPolicyDocumentSet(confirm),activated);
 await assert.rejects(()=>activateStagedPolicyDocumentSet({...confirm,expectedSourceHead:'wrong'}),/STALE_SOURCE/);
 await assert.rejects(()=>activateStagedPolicyDocumentSet({...confirm,expectedSourceRevision:expected.revision+1}),/STALE_SOURCE/);
 await assert.rejects(()=>activateStagedPolicyDocumentSet({...confirm,targetHead:'wrong'}),/STALE_SOURCE/);
 assert.deepEqual(a.rows(),afterActivation);
 const args={storage:a.storage,LoroDoc,pin:a.root.head,provider:a.provider,scope,deviceId:a.deviceId,targetHead,keys};
 // A valid activation by the original device is not a joined admission.
 const {joinedHouseholdAuthority}=await import('./joined-household-authority.mjs');
 const joinedArgs={storage:a.storage,scope,pin:a.root.head,provider:a.provider,deviceId:a.deviceId,sodium,
  operationId:householdReceiverIds(sodium,scope,a.deviceId).operationId,confirmedParent:a.root.head,
  pins:{list:async()=>[{scope,pin:a.root.head,head:a.root.head}]},paired:{keys,LoroDoc},allowActivatedPolicy:true};
 await assert.rejects(()=>joinedHouseholdAuthority(joinedArgs),/INVALID_ADMISSION/);
 await assert.rejects(()=>joinedHouseholdAuthority({...joinedArgs,operationId:'wrong'}),/INVALID_ADMISSION/);
 const {preflightPolicyReturn}=await import('./preflight-policy-return.mjs');
 const preflightBefore=a.rows();
 const preflight=await preflightPolicyReturn({...args,expectedTargetHead:targetHead,expectedTargetRevision:activated.record.revision});
 assert.equal(preflight.sourceHead,expected.acceptedParent);
 await assert.rejects(()=>preflightPolicyReturn({...args,expectedTargetHead:'wrong',expectedTargetRevision:activated.record.revision}),/STALE_TARGET/);
 await assert.rejects(()=>preflightPolicyReturn({...args,expectedTargetHead:targetHead,expectedTargetRevision:activated.record.revision+1}),/STALE_TARGET/);
 await assert.rejects(()=>preflightPolicyReturn({...args,keys:{use:async()=>{throw Error('key failed')}},expectedTargetHead:targetHead,expectedTargetRevision:activated.record.revision}),/key failed/);
 assert.deepEqual(a.rows(),preflightBefore);
 const before=a.rows(), verified=await readVerifiedActivatedPolicyDocumentSet(args);
 assert.equal(verified.documents.length,2); assert.deepEqual(verified.provenance,evidenceCapture.body.rows); assert.deepEqual(a.rows(),before);
 const {readActivatedPolicySource}=await import('./activated-policy-source.mjs');
 const childRow=verified.provenance.find(row=>row.recipeId==='retained-recipe');
 const rootRow=verified.provenance.find(row=>row.recipeId===null);
 const inherited=childRow.sources.find(source=>source.policyHashes.includes(accepted.policyHash));
 assert.deepEqual(await readActivatedPolicySource({...args,documentId:childRow.targetDocumentId,effectId:inherited.effectId}),inherited);
 assert.equal(inherited.incomplete,true);
 await assert.rejects(()=>readActivatedPolicySource({...args,documentId:rootRow.targetDocumentId,effectId:inherited.effectId}),/SOURCE_PROVENANCE_REQUIRED/);
 await assert.rejects(()=>readActivatedPolicySource({...args,documentId:childRow.targetDocumentId,effectId:'missing'}),/SOURCE_PROVENANCE_REQUIRED/);
 await assert.rejects(()=>readActivatedPolicySource({...args,scope:{...scope,id:'wrong'},documentId:childRow.targetDocumentId,effectId:inherited.effectId}));

 const {resolveActivatedPolicyAuthority}=await import('../authority/chain.mjs');
 const resolve=overrides=>resolveActivatedPolicyAuthority({...args,authorDevice:a.deviceId,...overrides});
 const runtime=await resolve({});
 const reopenedOriginal=await resolveOriginalHousehold({storage:a.storage,scope,pin:a.root.head,provider:a.provider,deviceId:a.deviceId,sodium,LoroDoc,paired:{keys}});
 assert.deepEqual(reopenedOriginal.resolved,runtime);
 assert.deepEqual(reopenedOriginal.activatedPolicy,{targetHead});
 await assert.rejects(()=>resolveOriginalHousehold({storage:a.storage,scope,pin:a.root.head,provider:a.provider,deviceId:a.deviceId,sodium,LoroDoc}));
 const missingReceipt=Object.assign(Object.create(a.storage),{readActivatedPolicyDocumentSet:async()=>({ok:true,value:null})});
 await assert.rejects(()=>resolveOriginalHousehold({storage:missingReceipt,scope,pin:a.root.head,provider:a.provider,deviceId:a.deviceId,sodium,LoroDoc,paired:{keys}}));
 assert.equal(runtime.scope.branchHead,targetHead);
 assert.equal(runtime.scope.documentId,`policy-${targetHead}`);
 assert.deepEqual(runtime.scope.policyHashes,[await policyId(a.provider,event.nextPolicy)]);
 assert.deepEqual(runtime.members.map(({recipeId,documentId})=>({recipeId,documentId})),staged.mapping.map(({recipeId,targetDocumentId})=>({recipeId,documentId:targetDocumentId})));
 assert.ok(runtime.members.every(member=>member.operationId&&member.identity));
 assert.equal(runtime.selectionIndex,nextState.selections.length);
 const mounted=await openWorkspaceHouseholdRuntime({storage:a.storage,resolved:runtime,activatedPolicy:{targetHead},pin:a.root.head,provider:a.provider,sodium,keys,signing:{publicKey:author.signingKeyRef},LoroDoc,decodeImportBlobMeta});
 assert.ok((await mounted.document()).revision!==null);
 const mountedRecipe=await mounted.forRecipe('retained-recipe');
 assert.equal((await mountedRecipe.document()).doc.getMap('recipe:retained-recipe').get('title'),'Soup');
 const {activatedPolicyEditContext}=await import('./activated-policy-source.mjs');
 const editContext=await activatedPolicyEditContext(mountedRecipe,a.service);
 const editVerify=createSourceVerifier({runtime:mountedRecipe,service:a.service,localEditContext:editContext,allowIncomplete:true});
 assert.deepEqual(await editVerify(inherited.effectId),{policies:inherited.policyHashes,incomplete:true});
 assert.ok((await editVerify(inherited.effectId)).policies.includes(accepted.policyHash));
 await assert.rejects(()=>editVerify(rootRow.sources[0].effectId),/SOURCE_PROVENANCE_REQUIRED/);
 await assert.rejects(()=>editVerify('missing'),/SOURCE_PROVENANCE_REQUIRED/);
 assert.throws(()=>createSourceVerifier({runtime:mountedRecipe,service:a.service,localEditContext:editContext}),/INCOMPLETE_PROVENANCE/);
 await assert.rejects(()=>createSourceVerifier({runtime:mounted,service:a.service,localEditContext:editContext,allowIncomplete:true})(inherited.effectId),/INVALID_AUTHORITY/);

 await assert.rejects(()=>mounted.forRecipe('wrong-child'),/INVALID_RECIPE_DOCUMENT/);
 await assert.rejects(()=>mounted.execute({}),/SOURCE_PROVENANCE_REQUIRED/);
 await assert.rejects(()=>mounted.importItem({}),/SOURCE_PROVENANCE_REQUIRED/);
 const header={version:1,suiteId:runtime.scope.suiteId,scopeId:runtime.scope.scopeId,documentId:mountedRecipe.scope.documentId,documentGeneration:runtime.scope.documentGeneration,branchHead:targetHead,policyHashes:runtime.scope.policyHashes,epochId:runtime.scope.epochId,authorDevice:a.deviceId,deviceSequence:1,predecessorRefs:[],semanticEffectIds:['probe'],payloadKind:'loro-update-v1'};
 const calls=[], originalUse=keys.use.bind(keys); keys.use=async (operation,identity,fn)=>{calls.push({operation,identity});return originalUse(operation,identity,fn)};
 try {
  await assert.rejects(()=>mounted.codec.sealContent(header,new Uint8Array([1]),runtime.scope.epochId,author.signingKeyRef));
  assert.equal(calls.at(-2).operation,runtime.members.find(x=>x.recipeId==='retained-recipe').operationId);
  calls.length=0;
  await assert.rejects(()=>mounted.codec.sealContent({...header,documentId:'wrong'},new Uint8Array([1]),runtime.scope.epochId,author.signingKeyRef),/INVALID_AUTHORITY/);
  assert.equal(calls.length,0);
 } finally {keys.use=originalUse;}

 await assert.rejects(()=>a.runtime.authorize());
 await assert.rejects(()=>openWorkspaceHouseholdRuntime({storage:a.storage,resolved:runtime,activatedPolicy:{targetHead:'wrong'},pin:a.root.head,provider:a.provider,sodium,keys,signing:{publicKey:author.signingKeyRef},LoroDoc,decodeImportBlobMeta}));

 await assert.rejects(()=>resolve({authorDevice:'unauthorized'}));
 await assert.rejects(()=>resolveRuntimeAuthority(a.storage,scope,a.root.head,a.provider,a.deviceId),/UNSUPPORTED_VERSION/);
 await assert.rejects(()=>a.service.authority(),/UNSUPPORTED_VERSION/);

 const evidence=must(await a.storage.readActivatedPolicyDocumentSet(scope.id,targetHead));
 const historicalStorage=Object.assign(Object.create(a.storage),{readPairingAuthority:async()=>({ok:true,value:structuredClone(expected)})});
 const historical=await readHistoricalPolicyActivationEvidence({...args,storage:historicalStorage});
 const {verifyPolicyReturnCandidate}=await import('./verify-policy-return.mjs');
 const body={from:targetHead,to:expected.acceptedParent,deviceId:a.deviceId,index:nextState.selections.length};
 const returnSelection={...body,signature:await sign('select-head',{root:a.root.head,householdId:scope.id,...body})};
 const returned={...nextState,selections:[...nextState.selections,returnSelection],activeHead:body.to};
 const candidate={...evidence.receipt.next,revision:evidence.receipt.next.revision+1,acceptedParent:body.to,authorizationSnapshot:await snapshotId(a.provider,returned),authorityState:authorityBytes(returned)};
 const check=overrides=>verifyPolicyReturnCandidate({...args,candidate,...overrides});
 assert.equal((await check({})).source.head,expected.acceptedParent);
 const badReturn=async mutate=>{const state=structuredClone(returned);mutate(state);const record={...candidate,authorizationSnapshot:await snapshotId(a.provider,state),authorityState:authorityBytes(state)};await assert.rejects(()=>check({candidate:record}));};
 await badReturn(s=>{s.selections.at(-1).index++});
 await badReturn(s=>{s.selections.at(-1).to='wrong'});
 await badReturn(s=>{s.selections.at(-1).deviceId='wrong'});
 await badReturn(s=>{s.selections.at(-1).signature='0'.repeat(128)});
 await badReturn(s=>{s.events.push(structuredClone(s.events[0]))});
 await badReturn(s=>{s.selections.push(structuredClone(s.selections.at(-1)))});
 await badReturn(s=>{s.selections[0].signature='0'.repeat(128)});
 await assert.rejects(()=>check({storage:missingReceipt}));
 await assert.rejects(()=>check({keys:{use:async()=>{throw Error('key failed')}}}));
 assert.deepEqual(historical.expected,evidence.receipt.expected);
 assert.deepEqual(historical.next,evidence.receipt.next);
 assert.equal(historical.documents.length,2);
 assert.ok(historical.documents.every(document=>!('policySeed' in document)));
 await assert.rejects(()=>readVerifiedActivatedPolicyDocumentSet({...args,storage:historicalStorage}));
 await assert.rejects(()=>readHistoricalPolicyActivationEvidence({...args,storage:missingReceipt}));
 await assert.rejects(()=>readVerifiedActivatedPolicyDocumentSet({...args,storage:missingReceipt}));
 assert.deepEqual(a.rows(),before);
 const altered=async mutate=>{const copy=structuredClone(evidence);await mutate(copy);const storage=Object.assign(Object.create(a.storage),{readActivatedPolicyDocumentSet:async()=>({ok:true,value:copy}),readPairingAuthority:async()=>({ok:true,value:copy.receipt.next})});await assert.rejects(()=>readVerifiedActivatedPolicyDocumentSet({...args,storage}));await assert.rejects(()=>readHistoricalPolicyActivationEvidence({...args,storage}));await assert.rejects(()=>resolve({storage}));};
 await altered(x=>{x.receipt.provenance.signature='0'.repeat(128)});
 await altered(async x=>{const body=JSON.parse(new TextDecoder().decode(x.receipt.provenance.statement))[2];body.rows[0].sources.pop();body.rows[0].identities.pop();x.receipt.provenance.statement=domain('policy-provenance-receipt-v1',body);x.receipt.provenance.signature=await sign('policy-provenance-receipt-v1',body)});
 const legacy=structuredClone(evidence);delete legacy.receipt.provenance;
 const legacyStorage=Object.assign(Object.create(a.storage),{readActivatedPolicyDocumentSet:async()=>({ok:true,value:legacy})});
 assert.equal((await readVerifiedActivatedPolicyDocumentSet({...args,storage:legacyStorage})).provenance,null);
 await assert.rejects(()=>readActivatedPolicySource({...args,storage:legacyStorage,documentId:childRow.targetDocumentId,effectId:inherited.effectId}),/SOURCE_PROVENANCE_REQUIRED/);
 await altered(x=>{x.staged.proof[0]^=1});
 await altered(x=>{x.receipt.next.authorityState[0]^=1});
 await altered(async x=>{const n=JSON.parse(new TextDecoder().decode(x.receipt.next.authorityState));n.selections.at(-1).signature='0'.repeat(128);x.receipt.next.authorityState=authorityBytes(n);x.receipt.next.authorizationSnapshot=await snapshotId(a.provider,n)});
 await altered(x=>{x.receipt.targets[1].identity.epochId='wrong'});
 await altered(x=>{x.staged.mapping[1].targetDocumentId='wrong'});
 await altered(x=>{const bad=new LoroDoc();bad.setPeerId('999');bad.getMap('tamper').set('x',1);x.documents[1].bytes=bad.export({mode:'snapshot'});x.documents[1].revision=1});
 const edited=structuredClone(evidence), later=new LoroDoc();later.import(edited.documents[1].bytes);later.setPeerId('999');later.getMap('later-edit').set('x',1);edited.documents[1].bytes=later.export({mode:'snapshot'});edited.documents[1].revision=1;
 const laterStorage=Object.assign(Object.create(a.storage),{readActivatedPolicyDocumentSet:async()=>({ok:true,value:edited})});
 await assert.rejects(()=>readVerifiedActivatedPolicyDocumentSet({...args,storage:laterStorage}));
 await assert.rejects(()=>readVerifiedActivatedPolicyDocumentSet({...args,pin:'wrong'}));
 await assert.rejects(()=>readHistoricalPolicyActivationEvidence({...args,pin:'wrong'}));
 let authorityReads=0;const racingStorage=Object.assign(Object.create(a.storage),{readPairingAuthority:async sc=>{const result=await a.storage.readPairingAuthority(sc);if(++authorityReads===2)result.value.revision++;return result;}});
 await assert.rejects(()=>readVerifiedActivatedPolicyDocumentSet({...args,storage:racingStorage}),/STALE_SOURCE/);
 const slot=prepared[0].record.identity, key=JSON.stringify(['local-key','household',scope.id,a.deviceId,'data',slot.epochId]);
 const saved=a.rows().find(row=>row.key===key); a.connection.executeSync('DELETE FROM loro_records WHERE key=?',[key]);
 await assert.rejects(()=>readVerifiedActivatedPolicyDocumentSet(args));
 await assert.rejects(()=>readHistoricalPolicyActivationEvidence(args));
 await assert.rejects(()=>activateStagedPolicyDocumentSet(confirm),/STALE_SOURCE/);
 await assert.rejects(()=>resolve({}));
 await assert.rejects(()=>mounted.authorize());
 a.connection.executeSync('INSERT INTO loro_records (key,value) VALUES (?,?)',[saved.key,saved.value]);
 assert.deepEqual(a.rows(),before);
 const editMount=await openWorkspaceHouseholdRuntime({storage:a.storage,resolved:runtime,activatedPolicy:{targetHead},pin:a.root.head,provider:a.provider,sodium,keys:signingKeys,signing,LoroDoc,decodeImportBlobMeta});
 const editRecipe=await editMount.forRecipe('retained-recipe');
 const current=(await editRecipe.document()).doc;
 const base=current.getMap('recipe-index').get('retained-recipe');
 const prior=current.getMap(`field-head:${encodeURIComponent(JSON.stringify(['recipe','retained-recipe','title']))}`).get('effect');
 const edit={version:1,kind:'recipe-field',commandId:'activated-edit',effectId:'activated-edit',dependencyEffectIds:[...new Set([base,prior].filter(Boolean))].sort(),data:{recipeId:'retained-recipe',field:'title',value:'Edited soup',author:a.deviceId,at:'2026-01-02T00:00:00Z'}};
 const input={operationId:'activated-edit',deviceSequence:3,command:edit};
 await assert.rejects(()=>editRecipe.prepareActivatedRecipeField(input,{},a.service),/INVALID_AUTHORITY/);
 await assert.rejects(()=>editRecipe.prepare(input),/SOURCE_PROVENANCE_REQUIRED/);
 const {commitActivatedRecipeField}=await import('./activated-policy-edit.mjs');
 await commitActivatedRecipeField({runtime:editRecipe,service:a.service,input});
 const source=must(await a.storage.readDisclosureSource(scope.id,edit.effectId));
 assert.equal(source.incomplete,true);assert.ok(source.policyHashes.includes(accepted.policyHash));
 const envelope=await editRecipe.codec.openContent(source.envelope,runtime.signingKeyRefs);
 assert.equal(envelope.header.version,3);assert.equal(envelope.header.disclosureIncomplete,true);
 assert.deepEqual(envelope.header.disclosurePolicyHashes,source.policyHashes);
 assert.deepEqual(await readActivatedPolicySource({...args,documentId:childRow.targetDocumentId,effectId:inherited.effectId}),inherited);
 await assert.rejects(()=>commitActivatedRecipeField({runtime:editRecipe,service:a.service,input}),/SOURCE_PROVENANCE_REQUIRED|CONFLICT/);
 const reopened=await openWorkspaceHouseholdRuntime({storage:a.storage,resolved:runtime,activatedPolicy:{targetHead},pin:a.root.head,provider:a.provider,sodium,keys:signingKeys,signing,LoroDoc,decodeImportBlobMeta});
 assert.equal((await (await reopened.forRecipe('retained-recipe')).document()).doc.getMap('recipe:retained-recipe').get('title'),'Edited soup');
 const objectKey=JSON.stringify(['object',scope.id,envelope.object.id]);
 const objectRow=a.rows().find(row=>row.key===objectKey);
 a.connection.executeSync('DELETE FROM loro_records WHERE key=?',[objectKey]);
 try {await assert.rejects(()=>editRecipe.document());await assert.rejects(()=>resolve({}));} finally {a.connection.executeSync('INSERT INTO loro_records (key,value) VALUES (?,?)',[objectRow.key,objectRow.value]);}
 const corruptObject=JSON.parse(objectRow.value);corruptObject.bytes.__storageBytes[0]^=1;
 a.replaceRow(objectKey,JSON.stringify(corruptObject));
 try {await assert.rejects(()=>editRecipe.document());} finally {a.replaceRow(objectKey,objectRow.value);}
 const targetKey=JSON.stringify(['document',scope.id,childRow.targetDocumentId]);
 const targetRow=a.rows().find(row=>row.key===targetKey), targetRecord=JSON.parse(targetRow.value);
 const unsigned=new LoroDoc();unsigned.import(Uint8Array.from(targetRecord.bytes.__storageBytes));unsigned.setPeerId('999');unsigned.getMap('tamper').set('x',1);
 targetRecord.bytes={__storageBytes:[...unsigned.export({mode:'snapshot'})]};
 a.replaceRow(targetKey,JSON.stringify(targetRecord));
 try {await assert.rejects(()=>editRecipe.document());await assert.rejects(()=>resolve({}));} finally {a.replaceRow(targetKey,targetRow.value);}
 const {returnActivatedPolicyDocumentSet}=await import('./workspace-household-runtime.mjs');
 const returnArgs={runtime:editMount,expectedSourceHead:expected.acceptedParent,expectedTargetHead:targetHead,expectedTargetRevision:activated.record.revision,service:a.service,keys:signingKeys};
 a.replaceRow(targetKey,JSON.stringify(targetRecord));
 try {await assert.rejects(()=>returnActivatedPolicyDocumentSet(returnArgs));} finally {a.replaceRow(targetKey,targetRow.value);}
 const beforeReturn=a.rows();
 await assert.rejects(()=>returnActivatedPolicyDocumentSet({...returnArgs,expectedSourceHead:'wrong'}),/STALE_SOURCE/);
 await assert.rejects(()=>returnActivatedPolicyDocumentSet({...returnArgs,expectedTargetHead:'wrong'}));
 await assert.rejects(()=>returnActivatedPolicyDocumentSet({...returnArgs,expectedTargetRevision:activated.record.revision+1}),/STALE_TARGET/);
 const sourceRow=beforeReturn.find(row=>row.key===JSON.stringify(['document',scope.id,staged.mapping[0].sourceDocumentId]));
 const changedSource=JSON.parse(sourceRow.value);changedSource.revision++;
 a.replaceRow(sourceRow.key,JSON.stringify(changedSource));
 const changedRows=a.rows();
 await assert.rejects(()=>returnActivatedPolicyDocumentSet(returnArgs),/INVALID_SOURCE/);
 assert.deepEqual(a.rows(),changedRows);
 a.replaceRow(sourceRow.key,sourceRow.value);
 const originalUseIdentity=signingKeys.useIdentity;
 signingKeys.useIdentity=async()=>{throw Error('MISSING_SOURCE_KEY')};
 try {await assert.rejects(()=>returnActivatedPolicyDocumentSet(returnArgs),/MISSING_SOURCE_KEY/);} finally {signingKeys.useIdentity=originalUseIdentity;}
 assert.deepEqual(a.rows(),beforeReturn);
 const commitReturn=a.storage.commitPolicyDocumentSetReturn.bind(a.storage);
 let returnWrites=0,result;
 a.storage.commitPolicyDocumentSetReturn=async input=>{
  returnWrites++;
  const committed=await commitReturn(input);
  assert.equal(committed.ok,true);
  throw Error('return response lost');
 };
 try {
  result=await returnActivatedPolicyDocumentSet(returnArgs);
  const committedRows=a.rows();
  assert.deepEqual(await returnActivatedPolicyDocumentSet(returnArgs),result);
  await assert.rejects(()=>returnActivatedPolicyDocumentSet({...returnArgs,expectedSourceHead:'wrong'}));
  await assert.rejects(()=>returnActivatedPolicyDocumentSet({...returnArgs,expectedTargetRevision:activated.record.revision+1}),/STALE_TARGET/);
  assert.equal(returnWrites,1);
  assert.deepEqual(a.rows(),committedRows);
 } finally {a.storage.commitPolicyDocumentSetReturn=commitReturn;}
 assert.equal(result.sourceHead,expected.acceptedParent);
 const returnedState=JSON.parse(new TextDecoder().decode(result.record.authorityState));
 assert.equal(returnedState.selections.at(-1).to,expected.acceptedParent);
 assert.match(returnedState.selections.at(-1).signature,/^[a-f0-9]{128}$/);
 assert.equal(returnedState.selections.length,nextState.selections.length+1);
 assert.equal(must(await a.storage.readDisclosureActive(scope.id)),accepted.policyHash);
 const stable=row=>{const key=JSON.parse(row.key);return ['document','document-owner','local-key','local-key-operation'].includes(key[0]);};
 assert.deepEqual(a.rows().filter(stable),beforeReturn.filter(stable));
 const {resolveReturnedPolicyAuthority}=await import('../authority/chain.mjs');
 const returnResolve={storage:a.storage,scope,pin:a.root.head,provider:a.provider,authorDevice:a.deviceId,LoroDoc,targetHead,keys:signingKeys,sodium};
 const afterReturn=a.rows();
 const resolvedReturn=await resolveReturnedPolicyAuthority(returnResolve);
 assert.equal(resolvedReturn.scope.documentId,staged.mapping[0].sourceDocumentId);
 assert.deepEqual(resolvedReturn.members,staged.mapping.map(row=>({recipeId:row.recipeId,documentId:row.sourceDocumentId})));
 assert.equal(resolvedReturn.selectionIndex,returnedState.selections.length);
 const discovered=await resolveOriginalHousehold({storage:a.storage,scope,pin:a.root.head,provider:a.provider,deviceId:a.deviceId,LoroDoc,sodium,paired:{keys:signingKeys}});
 assert.deepEqual(discovered.returnedPolicy,{targetHead});
 const returnedMount=await openWorkspaceHouseholdRuntime({storage:a.storage,...discovered,pin:a.root.head,provider:a.provider,sodium,keys:signingKeys,signing,LoroDoc,decodeImportBlobMeta});
 const originalDoc=await returnedMount.document();
 assert.ok(originalDoc.doc);
 const originalRecipe=await returnedMount.forRecipe('retained-recipe');
 assert.ok((await originalRecipe.document()).doc);
 const replacementDoc=new LoroDoc(); replacementDoc.getMap('recipe:retained-recipe').set('title','Forged');
 const childSourceRow=afterReturn.find(row=>row.key===JSON.stringify(['document',scope.id,staged.mapping[1].sourceDocumentId]));
 const replacementRecord=JSON.parse(childSourceRow.value); replacementRecord.bytes={__storageBytes:[...replacementDoc.export({mode:'snapshot'})]};
 a.replaceRow(childSourceRow.key,JSON.stringify(replacementRecord));
 try {await assert.rejects(()=>originalRecipe.document(),/INVALID_SOURCE/);} finally {a.replaceRow(childSourceRow.key,childSourceRow.value);}
 assert.ok((await originalRecipe.document()).doc);
 await assert.rejects(()=>returnedMount.importItem({}),/SOURCE_PROVENANCE_REQUIRED/);
 await assert.rejects(()=>returnedMount.executeBatch({}),/SOURCE_PROVENANCE_REQUIRED/);
 await assert.rejects(()=>returnedMount.forRecipe('other'),/INVALID_RECIPE_DOCUMENT/);

 await assert.rejects(()=>resolveRuntimeAuthority(a.storage,scope,a.root.head,a.provider,a.deviceId));
 await assert.rejects(()=>mounted.authorize());
 await assert.rejects(()=>editMount.authorize());
 await assert.rejects(()=>resolveReturnedPolicyAuthority({...returnResolve,storage:missingReceipt}));
 await assert.rejects(()=>resolveReturnedPolicyAuthority({...returnResolve,keys:{use:async()=>{throw Error('missing key')}}}));
 await assert.rejects(()=>resolveReturnedPolicyAuthority({...returnResolve,keys:{use:signingKeys.use.bind(signingKeys),useIdentity:async()=>{throw Error('missing source key')}}}),/missing source key/);
 let returnReads=0;
 const returnRace=Object.assign(Object.create(a.storage),{readPairingAuthority:async sc=>{const value=await a.storage.readPairingAuthority(sc);if(++returnReads===2)value.value.revision++;return value;}});
 await assert.rejects(()=>resolveReturnedPolicyAuthority({...returnResolve,storage:returnRace}),/STALE_AUTHORITY/);
 const corrupt=structuredClone(result.record);corrupt.authorityState[0]^=1;
 const corruptStorage=Object.assign(Object.create(a.storage),{readPairingAuthority:async()=>({ok:true,value:corrupt})});
 await assert.rejects(()=>resolveReturnedPolicyAuthority({...returnResolve,storage:corruptStorage}));
 assert.deepEqual(a.rows(),afterReturn);

});

test('pinned recipe documents retain competing encrypted edits independently and roll back failed writes',async t=>{
 const [a,b]=await household(t,{onDisk:true});
 const files=peer=>cookingFiles({runtime:peer.runtime,service:peer.service,recipeCatalogVersion:1,allowRecipeSources:false});
 const recipes=(runtime)=>runtime.document().then(({doc})=>projectCooking(doc).recipes);
 const at='2026-01-01T00:00:00Z';
 const makeRecipe=(id,title)=>({id,title,portions:2,ingredients:[{id:'i',name:'Carrot'}],steps:['Slice'],stepIds:['s'],createdAt:at,updatedAt:at});
 const change=async(peer,runtime,actionId,patch)=>{
  const {doc}=await runtime.document(),before=projectCooking(doc).recipes.find(x=>x.id===patch.id)??null;
  return planRecipeAction({doc,before,after:{...before,...patch},actionId,author:peer.deviceId,at});
 };
 const sequences=new Map();
 let sequence=0;
 const allocator={reserve:async(_scope,key)=>sequences.get(key)??sequences.set(key,++sequence).get(key)};
 const execute=(peer,runtime,id,commands)=>executeAction(runtime,allocator,id,commands,peer.service);
 const content=peer=>bindHouseholdContent({runtime:peer.runtime,sequences:allocator,disclosure:peer.service,
  originalRecipeDocuments:true});
 const exported=async(peer,id)=>{
  const saved=must(await peer.storage.getLocalOperation(scope.id,id));
  return Promise.all(saved.commit.outbound.map(row=>files(peer).download(row.object.id)));
 };
 const [ar,br,other]=await Promise.all([a.runtime.forRecipe('r'),b.runtime.forRecipe('r'),a.runtime.forRecipe('unrelated')]);
 assert.equal(ar.scope.documentId,br.scope.documentId);
 assert.notEqual(ar.scope.documentId,other.scope.documentId);
 for (const overrides of [{scopeId:'another-household'},{branchHead:'another'},{documentId:'another-parent'},{documentGeneration:2},{epochId:'fresh-epoch'}]){
  assert.notEqual(await recipeDocumentId({...a.runtime.scope,...overrides},a.root.head,a.provider,'r'),ar.scope.documentId);
 }
 const legacy=await change(a,a.runtime,'legacy',makeRecipe('legacy','Legacy soup'));
 await execute(a,a.runtime,'legacy',legacy);
 for(const bytes of await exported(a,'legacy')) await files(b).receive(bytes);
 assert.equal((await recipes(b.runtime))[0].title,'Legacy soup');
 const oldRecipe=await change(a,a.runtime,'original-signed-recipe',makeRecipe('original','Original signed recipe'));
 await a.runtime.execute({operationId:'original-signed-recipe',deviceSequence:++sequence,command:oldRecipe[0]});
 const [originalBytes]=await exported(a,'original-signed-recipe');
 const original=(await a.runtime.codec.openContent(originalBytes,(await a.runtime.authorization()).signingKeyRefs)).object;
 await stage(b,{itemId:original.id,bytes:originalBytes},'legacy');
 await b.runtime.importItem({itemId:original.id,bytes:originalBytes});
 const beforeCatalog=await openSelectedRecipeCatalog(b.runtime);
 assert.equal(beforeCatalog.children.size,0);
 assert.deepEqual(projectSelectedRecipes(beforeCatalog).map(r=>r.id),['legacy','original']);
 await assert.rejects(()=>content(b).createRecipe('duplicate-child',makeRecipe('legacy','Duplicate child recipe')),/CONFLICT/);
 const legacyBefore=must(await b.storage.reopenBranchDocument(await b.runtime.authorize(),b.runtime.scope.documentId));
 const anotherLegacy=await change(a,a.runtime,'legacy-second',makeRecipe('legacy-second','Legacy second soup'));
 await execute(a,a.runtime,'legacy-second',anotherLegacy);
 await execute(a,a.runtime,'legacy-rename',await change(a,a.runtime,'legacy-rename',{id:'legacy',title:'Renamed legacy soup',updatedAt:'2026-01-02T00:00:00Z'}));
 const legacySource=must(await a.storage.reopenBranchDocument(await a.runtime.authorize(),a.runtime.scope.documentId));
 const reconstructed=await replayAuthenticated({runtime:a.runtime,checkpoint:legacySource.bytes});
 assert.deepEqual(reconstructed.held,[]);
 assert.deepEqual(projectCooking(reconstructed.doc),projectCooking((await a.runtime.document()).doc));
 const {doc:realSource}=await a.runtime.document();
 const [{peer,counter}]=realSource.frontiers();
 const substitute=realSource.forkAt([{peer,counter:counter-1}]);
 substitute.setPeerId(peer);
 substitute.getMap('recipe:legacy').set('title','Substituted checkpoint');
 assert.deepEqual(substitute.frontiers(),realSource.frontiers());
 await assert.rejects(()=>replayAuthenticated({runtime:a.runtime,checkpoint:substitute.export({mode:'snapshot'})}),/INSUFFICIENT_EVIDENCE/);

 const recipeToCreate=makeRecipe('r','Soup'),createId='create';
 const create=await change(a,ar,createId,recipeToCreate);
 await assert.rejects(()=>execute(a,other,'wrong-recipe',create),/INVALID_RECIPE_DOCUMENT/);
 const beforeCreate=a.rows();
 for(const fault of ['recipe-catalog','disclosure-local']){
  a.faultAt(fault);
  await assert.rejects(()=>content(a).createRecipe(createId,recipeToCreate),/IO/);
  assert.equal((await ar.document()).revision,null);
  assert.equal(must(await a.storage.getLocalOperation(scope.id,createId)),null);
  assert.deepEqual((await content(a).readCooking()).separateRecipeIds,[]);
  assert.deepEqual(a.rows(),beforeCreate);
 }
 a.faultAt(null);
 const commitPublication=a.storage.commitLocalWithDisclosurePolicy.bind(a.storage);
 a.storage.commitLocalWithDisclosurePolicy=async (...args)=>{
  a.storage.commitLocalWithDisclosurePolicy=commitPublication;
  assert.ok(args[3]);
  await a.edit('concurrent-pantry',++sequence);
  return commitPublication(...args);
 };
 await assert.rejects(()=>content(a).createRecipe(createId,recipeToCreate),/CONFLICT/);
 assert.equal((await openSelectedRecipeCatalog(a.runtime)).children.size,0);
 assert.equal((await ar.document()).revision,null);
 await content(a).createRecipe(createId,recipeToCreate);
 const [initial]=await exported(a,createId);
 const savedCreate=must(await a.storage.getLocalOperation(scope.id,createId)).commit.outbound[0].object.id;
 assert.ok((await files(a).list()).some(row=>row.objectId===savedCreate));
 assert.ok((await files(a).directBatch(b.deviceId,256,new Map())).objects.some(row=>row.objectId===savedCreate));
 assert.ok(!(await a.cooking.list()).some(row=>row.objectId===savedCreate));
 assert.ok(!(await a.cooking.directBatch(b.deviceId,256,new Map())).objects.some(row=>row.objectId===savedCreate));
 await assert.rejects(()=>a.cooking.download(savedCreate),/INVALID_AUTHORITY/);
 await assert.rejects(()=>b.cooking.receive(initial),/INVALID_AUTHORITY/);
 b.faultAt('recipe-catalog');
 await assert.rejects(()=>files(b).receive(initial),/IO/);
 const [stagedCreate]=must(await b.storage.listStagedInbox(scope.id)).filter(row=>Buffer.from(row.bytes).equals(initial));
 assert.ok(stagedCreate);
 assert.equal((await openSelectedRecipeCatalog(b.runtime)).children.size,0);
 assert.equal((await br.document()).revision,null);
 assert.equal(must(await b.storage.getInboxApplication(scope.id,stagedCreate.itemId)),null);
 b.reopen();
 b.faultAt(null);
 const created=await files(b).retry(stagedCreate.itemId);
 assert.deepEqual(await files(b).receive(initial),{...created,replayed:true});
 const selected=await openSelectedRecipeCatalog(b.runtime);
 assert.equal(selected.binding.version,1);
 assert.equal(selected.binding.sourceDocumentId,b.runtime.scope.documentId);
 assert.equal(selected.children.get('r').documentId,br.scope.documentId);
 assert.deepEqual(projectSelectedRecipes(selected).map(r=>r.id),['legacy','original','r']);
 const storedChild=b.rows().find(row=>row.key===JSON.stringify(['document',scope.id,br.scope.documentId]));
 const forgedChild=new LoroDoc(),signedMarker=selected.children.get('r').doc.getMap('domain-effects').get(create[0].effectId);
 forgedChild.setPeerId(ar.scope.authorPeers[a.deviceId]);
 apply(forgedChild,{...create[0],data:{...create[0].data,recipe:{...create[0].data.recipe,title:'Substituted creation'}}});
 forgedChild.setPeerId('999');
 forgedChild.getMap('domain-effects').set(create[0].effectId,signedMarker);
 assert.equal(projectCooking(forgedChild).recipes[0].title,'Substituted creation');
 b.replaceRow(storedChild.key,JSON.stringify({revision:0,bytes:{__storageBytes:[...forgedChild.export({mode:'snapshot'})]}}));
 b.reopen();
 try {
  await assert.rejects(()=>openSelectedRecipeCatalog(b.runtime,'r'),/POLICY_BASELINE_UNAVAILABLE/);
 } finally {
  b.replaceRow(storedChild.key,storedChild.value);
 }
 a.reopen();
 const retainedCreate=await content(a).createRecipe(createId,recipeToCreate);
 await assert.rejects(()=>content(a).createRecipe(createId,{...recipeToCreate,title:'Different retry'}),/CONFLICT/);
 assert.equal((await content(a).readRecipe('legacy')).scope.documentId,a.runtime.scope.documentId);
 assert.equal((await content(a).readRecipe('r')).scope.documentId,ar.scope.documentId);
 assert.equal(retainedCreate.replayed,true);
 assert.deepEqual(await exported(a,createId),[initial]);
 const duplicate=await change(b,b.runtime,'duplicate-legacy',makeRecipe('r','Duplicate legacy recipe'));
 await assert.rejects(()=>execute(b,b.runtime,'duplicate-legacy',duplicate),/CONFLICT/);
 const [plainCreate]=await change(b,b.runtime,'plain-root-duplicate',makeRecipe('r','Duplicate from a version-one envelope'));
 const plain=await b.runtime.prepare({operationId:'plain-root-duplicate',command:plainCreate,deviceSequence:++sequence});
 const {id:plainId,bytes:plainBytes}=plain.commit.outbound[0].object;
 const plainItem={itemId:plainId,bytes:plainBytes};
 must(await b.storage.stageInbox({scopeId:scope.id,object:{id:plainId,bytes:plainBytes},source:'plain-root-duplicate',
  cursor:plainId,expectedCursor:null},await b.runtime.authorize(),b.deviceId));
 const beforePlainImport=b.rows();
 await assert.rejects(()=>b.runtime.importItem(plainItem),/CONFLICT/);
 assert.deepEqual(b.rows(),beforePlainImport);
 assert.equal(must(await b.storage.getInboxApplication(scope.id,plainId)),null);
 const unrelated=await change(a,other,'unrelated',makeRecipe('unrelated','Unrelated canary'));
 await execute(a,other,'unrelated',unrelated);
 const [unrelatedBytes]=await exported(a,'unrelated');
 await execute(a,other,'unrelated-description',await change(a,other,'unrelated-description',{id:'unrelated',description:'Independent child description'}));
 const [unrelatedEdit]=await exported(a,'unrelated-description');
 const unrelatedEnvelope=(await a.runtime.codec.openContent(unrelatedEdit,(await a.runtime.authorization()).signingKeyRefs)).object;
 await assert.rejects(()=>files(b).receive(unrelatedEdit),/MISSING_DEPENDENCY/);
 assert.ok((await files(b).pending()).some(row=>row.itemId===unrelatedEnvelope.id));
 assert.ok(!(await b.cooking.pending()).some(row=>row.itemId===unrelatedEnvelope.id));
 assert.equal((await openSelectedRecipeCatalog(b.runtime)).children.has('unrelated'),false);
 await files(b).receive(unrelatedBytes);
 await files(b).retry(unrelatedEnvelope.id);
 const otherB=await b.runtime.forRecipe('unrelated');
 const unrelatedBefore=must(await b.storage.reopenBranchDocument(await b.runtime.authorize(),otherB.scope.documentId));
 const row=b.rows().find(r=>JSON.parse(r.key).at(-1)==='r'&&JSON.parse(r.key)[0]==='recipe-catalog');
 assert.ok(row);
 for(const override of [{documentId:otherB.scope.documentId},{binding:{...selected.binding,documentGeneration:2}}]){
  b.replaceRow(row.key,JSON.stringify({...JSON.parse(row.value),...override}));
  await assert.rejects(()=>openSelectedRecipeCatalog(b.runtime),/CORRUPT|INVALID_RECIPE_DOCUMENT/);
 }
 b.replaceRow(row.key,row.value);
 for(const runtime of [a.runtime,ar,other,b.runtime,br,otherB]){
  const {doc,storedBytes}=await runtime.document();
  const replay=await replayAuthenticated({runtime,checkpoint:storedBytes});
  assert.deepEqual(replay.held,[]);
  assert.deepEqual(projectCooking(replay.doc),projectCooking(doc));
 }
 const [dependent]=await change(a,ar,'cross-recipe-dependency',{id:'r',title:'Cross-recipe write'});
 await assert.rejects(()=>execute(a,ar,'cross-recipe-dependency',[{
  ...dependent,dependencyEffectIds:[...dependent.dependencyEffectIds,unrelated[0].effectId],
 }]),/MISSING_DEPENDENCY/);

 await execute(a,ar,'a-edit',await change(a,ar,'a-edit',{id:'r',title:'Alternative A'}));
 await execute(b,br,'b-edit',await change(b,br,'b-edit',{id:'r',title:'Alternative B',description:'Independent field'}));
 const [editA]=await exported(a,'a-edit'),[editB,descriptionB]=await exported(b,'b-edit');
 assert.equal((await recipes(ar))[0].title,'Alternative A');
 assert.equal((await recipes(br))[0].title,'Alternative B');
 assert.equal(new TextDecoder().decode(editA).includes('Alternative A'),false);
 const beforeForgery=b.rows();
 const auth=await ar.authorization(),opened=await ar.codec.openContent(editA,auth.signingKeyRefs),signing=auth.signingKeyRefs[a.deviceId];
 const unsigned=JSON.parse(new TextDecoder().decode(editA));
 unsigned.header.documentId=other.scope.documentId;
 await assert.rejects(()=>files(b).receive(new TextEncoder().encode(JSON.stringify(unsigned))));
 for(const header of [
  {...opened.header,documentId:other.scope.documentId},
  {...opened.header,branchHead:'unselected-head'},
  {...opened.header,documentGeneration:0},
  {...opened.header,epochId:'old-epoch'},
 ]){
  const forged=await ar.codec.sealContent(header,opened.value,ar.keyRef,signing);
  await assert.rejects(()=>files(b).receive(forged.bytes),/INVALID_AUTHORITY|INVALID_RECIPE_DOCUMENT/);
 }
 const mismatchedAuthor=await br.codec.sealContent({...opened.header,authorDevice:b.deviceId},
  opened.value,br.keyRef,auth.signingKeyRefs[b.deviceId]);
 await assert.rejects(()=>files(b).receive(mismatchedAuthor.bytes),/INVALID_AUTHORITY/);
 for(const header of [
  {...opened.header,semanticEffectIds:['different-effect']},
  {...opened.header,sourceEffectIds:['different-source']},
 ]){
  const forged=await ar.codec.sealContent(header,opened.value,ar.keyRef,signing);
  await assert.rejects(()=>files(b).receive(forged.bytes),/MALFORMED_UPDATE/);
 }
 assert.deepEqual(b.rows(),beforeForgery);

 const beforeImport=(await br.document()).revision;
 for(const boundary of ['import-documents','import']){
  b.faultAt(boundary);
  await assert.rejects(()=>files(b).receive(editA),/IO/);
  assert.equal((await br.document()).revision,beforeImport);
  assert.equal(must(await b.storage.getInboxApplication(scope.id,opened.object.id)),null);
  assert.equal(must(await b.storage.readDisclosureSource(scope.id,opened.header.semanticEffectIds[0])),null);
  assert.deepEqual(must(await b.storage.listStagedInbox(scope.id)).find(row=>row.itemId===opened.object.id)?.bytes,editA);
 }
 b.faultAt(null);
 const imported=await files(b).retry(opened.object.id);
 assert.deepEqual(await files(b).receive(editA),{...imported,replayed:true});
 const pendingA=await ar.codec.openContent(descriptionB,auth.signingKeyRefs);
 await assert.rejects(()=>files(a).receive(descriptionB),/MISSING_DEPENDENCY/);
 await files(a).receive(editB);
 await files(a).retry(pendingA.object.id);
 assert.deepEqual(await recipes(ar),await recipes(br));
 assert.equal((await recipes(br))[0].description,'Independent field');
 assert.deepEqual(must(await b.storage.reopenBranchDocument(await b.runtime.authorize(),b.runtime.scope.documentId)),legacyBefore);
 assert.deepEqual(must(await b.storage.reopenBranchDocument(await b.runtime.authorize(),otherB.scope.documentId)),unrelatedBefore);
 assert.ok(must(await a.storage.listBranchLocalOperations(await ar.authorize())).some(row=>row.operationId==='a-edit'));

 const {doc}= (await openSelectedRecipeCatalog(b.runtime,'r')).children.get('r');
 const history=readRecipeHistory(doc,'r');
 const loser=history.find(row=>row.field==='title'&&row.status==='competing');
 assert.ok(loser);
 assert.throws(()=>planRecipeRestore({doc,recipeId:'r',effectId:loser.effectId,expectedHead:'stale'}),/history changed/);
 const restore=planRecipeRestore({doc,recipeId:'r',effectId:loser.effectId,expectedHead:loser.head,actionId:'restore',author:b.deviceId,at});
 await execute(b,br,'restore',[restore]);
 for(const bytes of await exported(b,'restore')) await files(a).receive(bytes);
 assert.equal((await recipes(await a.runtime.forRecipe('r')))[0].title,loser.value);
 assert.equal((await recipes(br))[0].title,loser.value);
 a.reopen();
 b.reopen();
 for(const peer of [a,b]){
  const reopened=await openSelectedRecipeCatalog(peer.runtime);
  assert.equal(reopened.children.get('r').documentId,ar.scope.documentId);
  assert.equal(projectSelectedRecipes(reopened).find(r=>r.id==='r').title,loser.value);
  assert.equal(projectSelectedRecipes(reopened).find(r=>r.id==='unrelated').title,'Unrelated canary');
  assert.equal(projectSelectedRecipes(reopened).find(r=>r.id==='original').title,'Original signed recipe');
 }

 // The existing live-state codec can redact an isolated source. This checks
 // the bytes, independently of the future multi-document publication format.
 const {doc:restored}=await br.document();
 const seed=projectCurrentSeed({LoroDoc,source:restored.export({mode:'snapshot'}),seedId:'newcomer',peerId:'900'});
 const fresh=new LoroDoc();
 fresh.import(seed.snapshot);
 assert.equal(fresh.getMap('recipe:r').get('title'),loser.value);
 assert.deepEqual(readRecipeHistory(fresh,'r'),[]);
 const currentBytes=JSON.stringify(fresh.exportJsonUpdates(undefined,undefined,false));
 for(const secret of ['Legacy soup','Unrelated canary',history.find(row=>row.field==='title'&&row.status==='current').value])
  assert.equal(currentBytes.includes(secret),false,secret);

 const [versionOne]=await change(a,ar,'legacy-child-edit',{id:'r',title:'Version-one child'});
 await ar.execute({operationId:'legacy-child-edit',deviceSequence:++sequence,command:versionOne});
 const [legacyChild]=await exported(a,'legacy-child-edit');
 const childId=(await ar.codec.openContent(legacyChild,auth.signingKeyRefs)).object.id;
 must(await b.storage.stageInbox({scopeId:scope.id,object:{id:childId,bytes:legacyChild},source:'legacy-child',expectedCursor:null,cursor:childId}));
 const item={itemId:childId,bytes:legacyChild},applied=await br.importItem(item);
 assert.deepEqual(await br.importItem(item),{...applied,replayed:true});
 await assert.rejects(()=>otherB.importItem(item),/INVALID_AUTHORITY/);

 const stale=await b.runtime.authorize(),record=must(await b.storage.readPairingAuthority(scope));
 must(await b.storage.compareAndSwapPairingAuthority({expectedRevision:record.revision,record:{...record,revision:record.revision+1}}));
 const staleCatalog=await b.storage.readSelectedRecipeCatalog(stale,selected.binding);
 assert.equal(staleCatalog.error?.code,'CONFLICT');
 assert.equal((await openSelectedRecipeCatalog(b.runtime)).children.get('r').documentId,br.scope.documentId);
});
test('selected recipe shopping copies and current-only admission survive durable peers',async t=>{
 const [a,b]=await household(t,{onDisk:true});
 const sponsorMaster=testMaster(),existingMaster=testMaster();
 await a.storage.localKeys(sponsorMaster,sodium).provision('sponsor-master');
 await b.storage.localKeys(existingMaster,sodium).provision('existing-master');
 const files=peer=>cookingFiles({runtime:peer.runtime,service:peer.service,recipeCatalogVersion:1});
 const at='2026-01-01T00:00:00Z',recipeId='selected',ingredientId='carrot';
 const [ar,br,sibling]=await Promise.all([a.runtime.forRecipe(recipeId),b.runtime.forRecipe(recipeId),a.runtime.forRecipe('sibling')]);
 let sequence=0;
 const sequences={reserve:async()=>++sequence};
 const save=(peer,runtime,id,commands)=>executeAction(runtime,sequences,id,commands,peer.service);
 const objects=async(peer,id)=>(must(await peer.storage.getLocalOperation(scope.id,id))).commit.outbound.map(entry=>entry.object);
 const send=async(from,to,id)=>{for(const object of await objects(from,id))await files(to).receive(object.bytes);};
 const recipe=(id,name)=>({id,title:id,portions:2,ingredients:[{id:ingredientId,name,amount:'1 cup',needsShopping:true}],
  steps:[],stepIds:[],createdAt:at,updatedAt:at});
 const edit=async(peer,runtime,id,after)=>{
  const {doc}=await runtime.document(),before=projectCooking(doc).recipes.find(row=>row.id===after.id)??null;
  const commands=planRecipeAction({doc,before,after:{...before,...after},actionId:id,author:peer.deviceId,at});
  await save(peer,runtime,id,commands);
  return commands;
 };
 const shopping=async(runtime)=>projectCooking((await runtime.document()).doc).shopping;
 const initial=await edit(a,ar,'selected-create',recipe(recipeId,'Carrot'));
 const seededPantry={version:1,kind:'pantry-create',commandId:'seeded-pantry',effectId:'seeded-pantry',dependencyEffectIds:[],data:{itemId:'seeded-pantry',name:'Seeded beans',preference:3,author:a.deviceId,at}};
 await save(a,a.runtime,'seeded-pantry',[seededPantry]);
 const siblings=await edit(a,sibling,'sibling-create',recipe('sibling','Spare carrot'));
 const legacy=await edit(a,a.runtime,'legacy-recipe',recipe('legacy','Onion'));
 await send(a,b,'sibling-create');
 await send(a,b,'seeded-pantry');
 await send(a,b,'legacy-recipe');

 const policy=await prepareInitialPolicy({service:a.service,enforcement:'block'});
 const accepted=await acceptInitialPolicy({service:a.service,provider:a.provider,deviceId:a.deviceId,policy,explicit:true});
 await b.service.publish(accepted.policy,accepted.approvals);
 const nameAmount=await edit(a,ar,'restricted-ingredient',{
  id:recipeId,ingredients:[{id:ingredientId,name:'Purple carrot',amount:'2 cups',needsShopping:true}]
 });
 const [name,amount]=['name','amount'].map(field=>nameAmount.find(c=>c.data.field===field));
 assert.ok(name&&amount);
 const selected=await openSelectedRecipeCatalog(a.runtime);
 const before=projectCooking(selected.parent.doc);
 const list={id:'list',name:'Market',currentCycleId:'cycle',createdAt:at,updatedAt:at};
 const cycle={id:'cycle',listId:list.id,startedAt:at};
 const item=(id,recipeId,name,displayQuantity)=>({id,listId:list.id,name,recipeId,ingredientId,
  displayQuantity,purchaseCycleId:cycle.id,checked:false,createdAt:at,updatedAt:at});
 const copied=item('selected-item',recipeId,'Purple carrot','2 cups');
 const sameDocument=item('legacy-item','legacy','Onion','1 cup');
 const commands=planShoppingAction({doc:selected.parent.doc,recipeCatalog:selected,before:before.shopping,
  after:{lists:[list],cycles:[cycle],items:[copied,sameDocument],purchases:[]},
  pantryBefore:before.pantry,pantryAfter:before.pantry,actionId:'copy',author:a.deviceId,at});
 const linked=commands.find(c=>c.data.itemId===copied.id);
 const sameDoc=commands.find(c=>c.data.itemId===sameDocument.id);
 assert.deepEqual(linked.data.recipeSource.effectIds,[...initial.map(c=>c.effectId),name.effectId,amount.effectId].sort());
 assert.equal(linked.data.recipeSource.documentId,ar.scope.documentId);
 assert.equal(sameDoc.data.recipeSource,undefined);
 assert.ok(legacy.every(c=>sameDoc.dependencyEffectIds.includes(c.effectId)));
 a.faultAt('disclosure-local');
 await assert.rejects(()=>save(a,a.runtime,'copy',commands),/IO/);
 assert.deepEqual(await shopping(a.runtime),before.shopping);
 assert.equal(must(await a.storage.getLocalOperation(scope.id,'copy')),null);
 a.faultAt(null);
 await save(a,a.runtime,'copy',commands);
 const [listObject,legacyObject,linkedObject,...laterObjects]=await objects(a,'copy');
 assert.equal((await files(a).download(linkedObject.id)).length,linkedObject.bytes.length);
 await assert.rejects(()=>b.cooking.receive(linkedObject.bytes),/UNSUPPORTED_VERSION/);
 await files(b).receive(listObject.bytes);
 await b.cooking.receive(legacyObject.bytes);
 await assert.rejects(()=>files(b).receive(linkedObject.bytes),/MISSING_DEPENDENCY/);
 assert.equal(must(await b.storage.getInboxApplication(scope.id,linkedObject.id)),null);
 assert.deepEqual((await files(b).pending()).map(x=>x.itemId),[linkedObject.id]);
 for(const object of laterObjects){
  await assert.rejects(()=>files(b).receive(object.bytes),/MISSING_DEPENDENCY/);
  assert.equal(must(await b.storage.getInboxApplication(scope.id,object.id)),null);
 }
 assert.deepEqual((await shopping(b.runtime)).items,[sameDocument]);
 await send(a,b,'selected-create');
 await assert.rejects(()=>files(b).retry(linkedObject.id),/MISSING_DEPENDENCY/);
 await send(a,b,'restricted-ingredient');

 const auth=await a.runtime.authorization(),codec=a.runtime.codec;
 const opened=await codec.openContent(linkedObject.bytes,auth.signingKeyRefs);
 assert.equal(opened.header.disclosureIncomplete,true);
 assert.deepEqual(opened.header.disclosurePolicyHashes,[accepted.policyHash]);
 const prior=(await a.runtime.document()).doc.forkAt(a.runtime.inspectUpdate(
  Uint8Array.from(JSON.parse(new TextDecoder().decode(opened.value)).update)).frontiers);
 const sign=async(command,overrides={})=>{
  const doc=prior.fork();doc.setPeerId(a.runtime.scope.authorPeers[a.deviceId]);
  const before=doc.oplogVersion();
  apply(doc,command);
  const update=doc.export({mode:'update',from:before});
  const payload=new TextEncoder().encode(JSON.stringify({version:1,command,update:[...update]}));
  return codec.sealContent({...opened.header,semanticEffectIds:[command.effectId],sourceEffectIds:[...command.dependencyEffectIds].sort(),...overrides},
   payload,a.runtime.keyRef,auth.signingKeyRefs[a.deviceId]);
 };
 const forge=async(change,header,reason)=>{
  const command=structuredClone(linked);change(command);
  const forged=await sign(command,header);
  await assert.rejects(()=>files(b).receive(forged.bytes),reason);
  assert.equal(must(await b.storage.getInboxApplication(scope.id,forged.id)),null);
 };
 await forge(c=>{c.data.recipeSource.documentId=sibling.scope.documentId}, {}, /INVALID_RECIPE_SOURCE/);
 await forge(c=>{c.data.recipeId='sibling'}, {}, /INVALID_RECIPE_SOURCE/);
 await forge(c=>{c.data.displayQuantity='3 cups'}, {}, /INVALID_RECIPE_SOURCE/);
 const badUnit=JSON.parse(new TextDecoder().decode(opened.value));
 badUnit.command.data.displayUnit='cups';
 const signedUnit=await codec.sealContent(opened.header,new TextEncoder().encode(JSON.stringify(badUnit)),
  a.runtime.keyRef,auth.signingKeyRefs[a.deviceId]);
 await assert.rejects(()=>files(b).receive(signedUnit.bytes),/MALFORMED_COMMAND/);
 await forge(c=>{
  c.dependencyEffectIds=c.dependencyEffectIds.filter(id=>id!==amount.effectId);
  c.data.recipeSource.effectIds=c.data.recipeSource.effectIds.filter(id=>id!==amount.effectId);
 }, {}, /INVALID_RECIPE_SOURCE/);
 await forge(c=>{c.dependencyEffectIds.push(siblings[0].effectId)}, {}, /MISSING_DEPENDENCY/);
 await forge(c=>{c.data.recipeSource.frontiers[0].counter--}, {}, /INVALID_RECIPE_SOURCE/);
 await forge(()=>{}, {disclosurePolicyHash:null,disclosurePolicyHashes:[]}, /INVALID_SOURCE_PROOF/);
 await forge(()=>{}, {documentGeneration:0}, /INVALID_AUTHORITY/);
 const tampered=JSON.parse(new TextDecoder().decode(linkedObject.bytes));
 tampered.header.disclosurePolicyHashes=[];
 await assert.rejects(()=>files(b).receive(new TextEncoder().encode(JSON.stringify(tampered))));

 const revision=(await b.runtime.document()).revision;
 b.faultAt('import-documents');
 await assert.rejects(()=>files(b).retry(linkedObject.id),/IO/);
 b.faultAt(null);
 assert.equal((await b.runtime.document()).revision,revision);
 assert.equal(must(await b.storage.getInboxApplication(scope.id,linkedObject.id)),null);
 assert.equal(must(await b.storage.readDisclosureSource(scope.id,linked.effectId)),null);
 assert.deepEqual(must(await b.storage.listStagedInbox(scope.id)).find(x=>x.itemId===linkedObject.id).bytes,linkedObject.bytes);

 // The recipient authors its own recipe edit before importing the delayed
 // shopping command. A write racing the verified child read must retry.
 const originalCommit=b.storage.commitImportWithDisclosurePolicy.bind(b.storage);
 let intermediateAmount;
 b.storage.commitImportWithDisclosurePolicy=async (...args)=>{
  b.storage.commitImportWithDisclosurePolicy=originalCommit;
  assert.equal(args[5][0].documentId,br.scope.documentId);
  const intermediate=await edit(b,br,'intermediate-amount',{id:recipeId,ingredients:[{id:ingredientId,name:'Purple carrot',amount:'3 cups',needsShopping:true}]});
  intermediateAmount=intermediate.find(c=>c.data.field==='amount');
  await edit(b,br,'concurrent-amount',{id:recipeId,ingredients:[{id:ingredientId,name:'Purple carrot',amount:'4 cups',needsShopping:true}]});
  return originalCommit(...args);
 };
 await assert.rejects(()=>files(b).retry(linkedObject.id),/CONFLICT/);
 assert.equal((await b.runtime.document()).revision,revision);
 assert.equal(must(await b.storage.getInboxApplication(scope.id,linkedObject.id)),null);

 b.reopen();
 const imported=await files(b).retry(linkedObject.id);
 assert.deepEqual((await shopping(b.runtime)).items,[sameDocument,copied]);
 assert.equal(projectCooking((await br.document()).doc).recipes[0].ingredients[0].amount,'4 cups');
 const source=must(await b.storage.readDisclosureSource(scope.id,linked.effectId));
 assert.deepEqual(source.policyHashes,[accepted.policyHash]);
 assert.equal(source.incomplete,true);
 const context=await b.service.authority();
 const verify=allowIncomplete=>createSourceVerifier({runtime:b.runtime,service:b.service,context,allowIncomplete});
 assert.deepEqual((await verify(true)(linked.effectId)).policies,[accepted.policyHash]);
 await assert.rejects(()=>verify(false)(linked.effectId),/INCOMPLETE_PROVENANCE/);
 const {doc,storedBytes}=await b.runtime.document();
 const replay=await replayAuthenticated({runtime:b.runtime,checkpoint:storedBytes});
 assert.deepEqual(replay.held,[]);
 assert.deepEqual(projectCooking(replay.doc),projectCooking(doc));
 const withheld=await replayAuthenticated({runtime:b.runtime,checkpoint:new Uint8Array(),excludedEffectIds:[amount.effectId]});
 assert.deepEqual(withheld.held.map(x=>[x.command.effectId,x.reason]),[[linked.effectId,'DEPENDENCY_EXCLUDED']]);

 // Exchange the independently signed later recipe edit, then retry the exact
 // original local and imported shopping commands against the changed recipe.
 await send(b,a,'intermediate-amount');
 await send(b,a,'concurrent-amount');
 a.reopen();b.reopen();
 assert.equal((await save(a,a.runtime,'copy',commands)).replayed,true);
 assert.deepEqual((await objects(a,'copy'))[2],linkedObject);
 assert.deepEqual(await files(b).receive(linkedObject.bytes),{...imported,replayed:true});
 assert.deepEqual((await shopping(a.runtime)).items,[sameDocument,copied]);
 assert.deepEqual((await shopping(b.runtime)).items,[sameDocument,copied]);
 assert.ok(!(await files(b).pending()).some(x=>x.itemId===linkedObject.id));
 await forge(c=>{c.effectId='equivocated-copy';c.commandId=c.effectId}, {}, /CONFLICT/);

 // Use the normal single-command entry point on a second shopping list.
 for(const object of laterObjects)await files(b).retry(object.id);
 const otherList={...list,id:'second-list',currentCycleId:'second-cycle',updatedAt:null};
 const otherCycle={...cycle,id:otherList.currentCycleId,listId:otherList.id};
 const second=await openSelectedRecipeCatalog(a.runtime);
 const snapshot=projectCooking(second.parent.doc);
 const secondCopy={...copied,id:'second-item',listId:otherList.id,purchaseCycleId:otherCycle.id,displayQuantity:'4 cups'};
 const [createList,copyItem]=planShoppingAction({doc:second.parent.doc,recipeCatalog:second,before:snapshot.shopping,
  after:{...snapshot.shopping,lists:[...snapshot.shopping.lists,otherList],cycles:[...snapshot.shopping.cycles,otherCycle],
   items:[...snapshot.shopping.items,secondCopy]},pantryBefore:snapshot.pantry,pantryAfter:snapshot.pantry,
  actionId:'second-copy',author:a.deviceId,at});
 await save(a,a.runtime,'second-list',[createList]);
 const single={operationId:'single-copy',command:copyItem,deviceSequence:++sequence};
 const missingReceipt=a.storage.commitLocalWithDisclosurePolicy.bind(a.storage);
 a.storage.commitLocalWithDisclosurePolicy=(commit,policy,active,publication)=>missingReceipt(commit,policy,active,publication);
 try {
  await assert.rejects(()=>commitCookingWithPolicy({runtime:a.runtime,service:a.service,input:single}),/CONFLICT/);
  assert.equal(must(await a.storage.getLocalOperation(scope.id,single.operationId)),null);
 }finally{a.storage.commitLocalWithDisclosurePolicy=missingReceipt}
 await commitCookingWithPolicy({runtime:a.runtime,service:a.service,input:single});
 assert.equal((await commitCookingWithPolicy({runtime:a.runtime,service:a.service,input:single})).replayed,true);
 await send(a,b,'second-list');
 const [incoming]=await objects(a,single.operationId);
 const importBefore=(await b.runtime.document()).revision;
 b.storage.commitImportWithDisclosurePolicy=async (...args)=>{
  b.storage.commitImportWithDisclosurePolicy=originalCommit;
  const record=must(await b.storage.readPairingAuthority(scope));
  must(await b.storage.compareAndSwapPairingAuthority({expectedRevision:record.revision,record:{...record,revision:record.revision+1}}));
  return originalCommit(...args);
 };
 await assert.rejects(()=>files(b).receive(incoming.bytes),/CONFLICT/);
 assert.equal((await b.runtime.document()).revision,importBefore);
 assert.equal(must(await b.storage.getInboxApplication(scope.id,incoming.id)),null);
 assert.equal(must(await b.storage.readDisclosureSource(scope.id,copyItem.effectId)),null);
 assert.ok((await files(b).pending()).some(x=>x.itemId===incoming.id));
 await files(b).retry(incoming.id);
 assert.deepEqual((await shopping(b.runtime)).items,[sameDocument,secondCopy,copied]);
 assert.ok(intermediateAmount);
 assert.ok(!copyItem.dependencyEffectIds.includes(intermediateAmount.effectId));
 const earlierExcluded=await replayAuthenticated({runtime:b.runtime,checkpoint:new Uint8Array(),excludedEffectIds:[intermediateAmount.effectId]});
 assert.ok(earlierExcluded.applied.some(row=>row.command.effectId===linked.effectId));
 assert.ok(!earlierExcluded.applied.some(row=>row.command.effectId===copyItem.effectId));
 assert.equal(earlierExcluded.held.find(row=>row.command.effectId===copyItem.effectId)?.reason,'DEPENDENCY_EXCLUDED');
 const {storedBytes:withCopies}=await b.runtime.document();
 await assert.rejects(()=>replayAuthenticated({runtime:b.runtime,checkpoint:withCopies,excludedEffectIds:[intermediateAmount.effectId]}),/INVALID_BOUNDARY/);
 const {doc:shoppingDoc}=await b.runtime.document();
 const reviewed=projectCooking(shoppingDoc);
 const checked={...copied,checked:true};
 const [check]=planShoppingAction({doc:shoppingDoc,before:reviewed.shopping,
  after:{...reviewed.shopping,items:[sameDocument,secondCopy,checked]},pantryBefore:reviewed.pantry,
  pantryAfter:reviewed.pantry,actionId:'check-copied-item',author:b.deviceId,at});
 await save(b,b.runtime,'check-copied-item',[check]);
 await send(b,a,'check-copied-item');
 assert.deepEqual((await shopping(a.runtime)).items,[sameDocument,secondCopy,checked]);
 await assert.rejects(()=>verify(true)(check.effectId),/CONFLICT/);
 const refreshedContext=await b.service.authority();
 const verifyFollowOn=createSourceVerifier({runtime:b.runtime,service:b.service,context:refreshedContext,allowIncomplete:true});
 assert.deepEqual((await verifyFollowOn(check.effectId)).policies,[accepted.policyHash]);

 // The source set includes both children and the household document with a
 // signed copy dependency. The peer authenticates the claim from its own pin.
 const observation=await observeSelectedSourceSet(a.runtime);
 const full=await observePolicyDocumentSet(a.runtime);
 const retained=full.sources.map(source=>({documentId:source.runtime.scope.documentId,revision:source.revision,bytes:source.bytes??new Uint8Array()}));
 const verifyFull=(signed=full.signed,docs=retained,pin=b.root.head)=>verifyPolicyDocumentSet({storage:b.storage,scope,pin,provider:b.provider,LoroDoc,signed,retained:docs});
 await verifyFull();
 const setOptions={storage:b.storage,scope,pin:b.root.head,provider:b.provider,LoroDoc,signed:full.signed,retained};
 const subject=await policyDocumentSetSubject(setOptions);
 const setManifest=full.signed.body.observation.manifest;
 const policyEvent={version:6,kind:'changePolicy',authorDeviceId:full.signed.deviceId,householdId:setManifest.householdId,
  parentHead:setManifest.parentHead,epochId:setManifest.epochId,generation:setManifest.generation,subject};
 assert.equal(subject.documentCount,3);
 assert.deepEqual(subject.baseline,full.signed.body.documents[0].baseline);
 await matchPolicyDocumentSetEvent(setOptions,policyEvent);
 {
 const parent=(await verifyFull()).selected;
 const event={...policyEvent,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',policyHash:parent.policyHash,
  proposalId:'policy-stage-test',frozenAdultRoster:parent.roster,nextPolicy:parent.policy};
 const author=parent.devices.find(device=>device.deviceId===a.deviceId);
 const eventHash=sodium.to_hex(await a.provider.hash(domain('event',event)));
 const approvalBody={version:1,householdId:parent.householdId,eventHash,parentHead:parent.head,policyHash:parent.policyHash,
  generation:parent.generation,epochId:parent.epochId,adultId:author.adultId,deviceId:a.deviceId};
 const signPolicy=async (purpose,value)=>sodium.to_hex(await a.provider.sign(author.signingKeyRef,domain(purpose,value)));
 const policyItem={event,authorSignature:await signPolicy('event-signature',event),approvals:[{...approvalBody,signature:await signPolicy('approval-signature',approvalBody)}]};
 await assert.rejects(()=>stageVerifiedPolicyDocumentSet({runtime:a.runtime,item:{...policyItem,approvals:[]},signed:full.signed}),/QUORUM_REQUIRED/);
 const altered=structuredClone(full.signed); altered.signature='0'.repeat(128);
 await assert.rejects(()=>stageVerifiedPolicyDocumentSet({runtime:a.runtime,item:policyItem,signed:altered}),/INVALID_POLICY_DOCUMENT_SIGNATURE/);
 const stalePolicy=structuredClone(full.signed); stalePolicy.body.observation.manifest.catalog.hash='0'.repeat(64);
 await assert.rejects(()=>stageVerifiedPolicyDocumentSet({runtime:a.runtime,item:policyItem,signed:stalePolicy}),/STALE_SOURCE/);
 const staged=await stageVerifiedPolicyDocumentSet({runtime:a.runtime,item:policyItem,signed:full.signed});
 assert.equal(staged.targetHead,eventHash);
 assert.deepEqual(staged.mapping.map(row=>row.recipeId),full.sources.map(source=>source.runtime.recipeId??null));
 assert.equal(staged.mapping[0].targetDocumentId,`policy-${eventHash}`);
 const savedStage=await a.storage.readStagedPolicyDocumentSet(scope.id,eventHash);
 assert.equal(savedStage.ok,true); assert.deepEqual(savedStage.value.mapping,staged.mapping);
 const readStage=()=>readVerifiedPolicyDocumentSet({runtime:a.runtime,targetHead:eventHash});
 assert.equal((await readStage()).targetHead,eventHash);
 // Real, distinct source keys exercise the injected trust boundary. The reader
 // authenticates the entire route and never substitutes the root for a child.
 const localKeys=a.storage.localKeys(sponsorMaster,sodium), slots=new Map(), material=new Map();
 for(const [index,row] of staged.mapping.entries()) {
  const identity={version:1,scope,deviceId:a.deviceId,purpose:'data',epochId:`stage-source-${index}`};
  const operationId=`stage-source-operation-${index}`;
  await localKeys.generate(operationId,identity);
  await localKeys.use(operationId,identity,key=>material.set(row.sourceDocumentId,new Uint8Array(key)));
  slots.set(row.sourceDocumentId,{operationId,identity});
 }
 const routeReader=async(route,fn)=>{
  assert.equal(route.scopeId,scope.id); assert.equal(route.rootPin,a.root.head);
  assert.equal(route.sourceHead,parent.head); assert.equal(route.targetHead,eventHash);
  assert.equal(route.epochId,parent.epochId); assert.equal(route.generation,parent.generation);
  assert.equal(route.deviceId,a.deviceId);
  const row=staged.mapping.find(entry=>entry.sourceDocumentId===route.sourceDocumentId);
  if(!row || row.targetDocumentId!==route.targetDocumentId)throw Error('INVALID_SOURCE_ROUTE');
  const slot=slots.get(route.sourceDocumentId);
  if(!slot)throw Error('SOURCE_KEY_MISSING');
  return localKeys.use(slot.operationId,slot.identity,fn);
 };
 const prepare=(runtime=a.runtime,reader=routeReader,head=eventHash)=>preparePolicyDocumentKeys({runtime,targetHead:head,keys:localKeys,withSourceDocumentKey:reader});
 const beforeKeys=a.rows(), preparedKeys=await prepare();
 assert.deepEqual(a.rows(),beforeKeys);
 assert.equal(preparedKeys.length,staged.mapping.length);
 for(const [index,prepared] of preparedKeys.entries()) {
  const row=staged.mapping[index], record=prepared.record, identity=record.identity;
  assert.equal(prepared.targetDocumentId,row.targetDocumentId);
  const aad=new TextEncoder().encode(JSON.stringify(['creative-cooking/local-key/v1',identity.scope.kind,identity.scope.id,identity.deviceId,identity.purpose,identity.epochId]));
  const opened=await sponsorMaster.unwrap(record.masterId,record.wrapped,aad);
  assert.deepEqual(opened,material.get(row.sourceDocumentId));
  for(const [source,key] of material)if(source!==row.sourceDocumentId)assert.notDeepEqual(opened,key);
  assert.equal(Buffer.from(JSON.stringify(prepared)).includes(Buffer.from(opened)),false);
  assert.equal(Buffer.from(prepared.record.wrapped).includes(Buffer.from(opened)),false);
  opened.fill(0);
 }
 const missing=staged.mapping[1].sourceDocumentId, savedSlot=slots.get(missing); slots.delete(missing);
 await assert.rejects(()=>prepare(),/SOURCE_KEY_MISSING/); slots.set(missing,savedSlot);
 await assert.rejects(()=>prepare(a.runtime,routeReader,'0'.repeat(64)),/STAGE_NOT_FOUND/);
 const savedScope=structuredClone(a.runtime.scope);
 for(const change of [{scopeId:'wrong'},{branchHead:'wrong'},{epochId:'wrong'},{documentGeneration:999},{documentId:'wrong'},{authorDevice:'wrong'}]) {
  Object.assign(a.runtime.scope,change);
  await assert.rejects(()=>prepare());
  a.runtime.scope=structuredClone(savedScope);
 }
 const wrongRoute=async(route,fn)=>routeReader({...route,targetDocumentId:'wrong'},fn);
 await assert.rejects(()=>prepare(a.runtime,wrongRoute),/INVALID_SOURCE_ROUTE/);
 const changedDuringRead=async(route,fn)=>{await routeReader(route,fn);a.runtime.scope.epochId='wrong';};
 await assert.rejects(()=>prepare(a.runtime,changedDuringRead));
 a.runtime.scope=structuredClone(savedScope);
 assert.deepEqual(a.rows(),beforeKeys);
 for(const key of material.values())key.fill(0);
 for(const mutate of [s=>{s.proof=new Uint8Array([...s.proof,32])},s=>{s.mapping[1].targetDocumentId='substitute'},s=>{s.mapping[1].baseline[0]^=1},s=>{s.sourceHead='wrong'}]) {
  const fake=structuredClone(savedStage.value); mutate(fake);
  const storage=Object.assign(Object.create(a.storage),{readStagedPolicyDocumentSet:async()=>({ok:true,value:fake})});
  await assert.rejects(()=>readVerifiedPolicyDocumentSet({runtime:Object.assign(Object.create(a.runtime),{storage}),targetHead:eventHash}));
 }
 assert.equal((await verifyFull()).selected.head,parent.head);
 }

 for(const change of [{version:3},{kind:'pairOwnDevice'},{authorDeviceId:'wrong'},{householdId:'wrong'},
  {parentHead:'wrong'},{epochId:'wrong'},{generation:setManifest.generation+1},
  {subject:{...subject,setHash:'0'.repeat(64)}},{subject:{...subject,documentCount:1}},
  {subject:{...subject,baseline:{...subject.baseline,historyHash:'0'.repeat(64)}}}])
  await assert.rejects(()=>matchPolicyDocumentSetEvent(setOptions,{...policyEvent,...change}),/POLICY_DOCUMENT_SET_EVENT_MISMATCH/);
 await assert.rejects(()=>verifyFull(full.signed,retained.slice(0,-1)),/INVALID_POLICY_DOCUMENT_SET/);
 await assert.rejects(()=>verifyFull(full.signed,[retained[0],retained[1],retained[1]]),/INVALID_POLICY_DOCUMENT_SET/);
 const modified=structuredClone(full.signed); modified.body.documents[1].baseline.historyHash='0'.repeat(64);
 await assert.rejects(()=>verifyFull(modified),/INVALID_POLICY_DOCUMENT_SIGNATURE/);
 const resignFull=async body=>({...full.signed,body,signature:sodium.to_hex(await a.provider.sign(
  a.root.devices.find(device=>device.deviceId===a.deviceId).signingKeyRef,
  domain('policy-document-set-v1',{body,deviceId:a.deviceId})))});
 const omittedBaseline=structuredClone(full.signed.body); omittedBaseline.documents.pop();
 await assert.rejects(()=>resignFull(omittedBaseline).then(value=>verifyFull(value)),/INVALID_POLICY_DOCUMENT_SET/);
 const substituted=structuredClone(full.signed.body); substituted.documents[1].documentId=substituted.documents[2].documentId;
 await assert.rejects(()=>resignFull(substituted).then(value=>verifyFull(value)),/INVALID_POLICY_DOCUMENT_SET/);
 await assert.rejects(()=>verifyFull({...full.signed,deviceId:b.deviceId}),/INVALID_POLICY_DOCUMENT_SET/);

 await assert.rejects(()=>verifyFull(full.signed,retained,'0'.repeat(64)));
 const stale=structuredClone(retained); stale[1].bytes[0]^=1;
 await assert.rejects(()=>verifyFull(full.signed,stale),/INVALID_POLICY_DOCUMENT_SET/);
 const {signed,guard}=observation;
 const verifySet=signed=>verifySelectedSourceSet({storage:b.storage,scope,pin:b.root.head,provider:b.provider,signed});
 const verified=await verifySet(signed);
 assert.equal(verified.selected.head,a.root.head);
 assert.deepEqual(verified.manifest.children.map(x=>x.recipeId),[recipeId,'sibling']);
 assert.equal(verified.manifest.catalog.revision,2);
 assert.equal(verified.manifest.root.revision,(await a.runtime.document()).revision);
 assert.deepEqual(verified.manifest.children.map(x=>x.revision),
  [(await ar.document()).revision,(await sibling.document()).revision]);
 assert.equal(must(await a.storage.checkSelectedHouseholdSources(guard)),undefined);
 b.reopen();a.reopen();
 assert.deepEqual((await verifySet(signed)).manifest,verified.manifest);
 assert.deepEqual((await observeSelectedSourceSet(a.runtime)).signed,signed);
 const signSet=async(manifest,deviceId=a.deviceId)=>{
  const ref=a.root.devices.find(device=>device.deviceId===deviceId).signingKeyRef;
  return {manifest,deviceId,signature:sodium.to_hex(await a.provider.sign(ref,
   domain('selected-household-sources-v1',{manifest,deviceId})))};
 };
 for(const manifest of [
  {...signed.manifest,rootPin:'0'.repeat(64)},
  {...signed.manifest,epochId:'different-epoch'},
  {...signed.manifest,root:{...signed.manifest.root,documentId:ar.scope.documentId}},
  {...signed.manifest,children:[signed.manifest.children[0]]},
  {...signed.manifest,children:[...signed.manifest.children,signed.manifest.children[0]]},
  {...signed.manifest,children:[signed.manifest.children[0],signed.manifest.children[0]]},
  {...signed.manifest,children:[{...signed.manifest.children[0],documentId:sibling.scope.documentId},signed.manifest.children[1]]},
 ]){
  await assert.rejects(()=>signSet(manifest).then(verifySet),/INVALID_SOURCE_SET/);
 }
 await assert.rejects(()=>verifySet({...signed,deviceId:b.deviceId}),/INVALID_SOURCE_SIGNATURE/);
 const checkGuard=guard=>a.storage.checkSelectedHouseholdSources(guard);
 const tamperedObservation=structuredClone(guard);
 tamperedObservation.entries[0].bytes[0]^=1;
 assert.equal((await checkGuard(tamperedObservation)).error.code,'CONFLICT');
 await edit(a,ar,'source-set-child-race',{id:recipeId,title:'New child title'});
 assert.equal((await checkGuard(guard)).error.code,'CONFLICT');
 const beforeRootRace=(await observeSelectedSourceSet(a.runtime)).guard;
 await a.edit('source-set-root-race',++sequence);
 assert.equal((await checkGuard(beforeRootRace)).error.code,'CONFLICT');
 const beforeInsert=(await observeSelectedSourceSet(a.runtime)).guard;
 const omittedRecipeId='omitted-catalog-recipe',omittedIngredientId='omitted-catalog-ingredient';
 const inserted=await a.runtime.forRecipe(omittedRecipeId);
 let insertedDuringProjection=false;
 await assert.rejects(()=>prepareAdultRemovalProjection({runtime:a.runtime,service:a.service,
  destination:{parentHead:a.root.head,documentId:'catalog-race-target',epochId:'catalog-race-epoch',generation:2},
  allocateSeed:async()=>{
   if(!insertedDuringProjection){
    insertedDuringProjection=true;
    await edit(a,inserted,'source-set-catalog-race',{...recipe(omittedRecipeId,'Third carrot'),
     ingredients:[{id:omittedIngredientId,name:'Third carrot',amount:'1 cup'}]});
   }
   return {seedId:'11111111-1111-4111-8111-000000000001',peerId:'901'};
  }}),/CONFLICT|SOURCE_CHANGED/);
 assert.equal((await checkGuard(beforeInsert)).error.code,'CONFLICT');
 const afterInsert=await observeSelectedSourceSet(a.runtime);
 assert.equal(afterInsert.signed.manifest.catalog.revision,3);
 assert.equal(afterInsert.signed.manifest.root.revision,beforeInsert.root.revision);
 const head=must(await a.storage.readPairingAuthority(scope));
 const staleSingleDocument=await a.storage.compareAndSwapPairingAuthority({expectedRevision:head.revision,
  record:{...head,revision:head.revision+1,acceptedParent:'different-head'}});
 assert.equal(staleSingleDocument.error,'UNSUPPORTED_VERSION');
 assert.deepEqual(must(await a.storage.readPairingAuthority(scope)),head);

 const unrelatedPrivate={version:1,kind:'chef-proposal-create',commandId:'private-canary',effectId:'private-canary',
  dependencyEffectIds:[],data:{conversationId:'private',proposalId:'private',toolName:'draft',
   arguments:'UNRELATED_PRIVATE_CANARY',status:'pending',createdAt:at}};
 await a.runtime.execute({operationId:'private-canary',deviceSequence:++sequence,command:unrelatedPrivate});
 const copySource=await openSelectedRecipeCatalog(a.runtime);
 const cookingBeforeRemoval=projectCooking(copySource.parent.doc);
 const detachedCopy={...copied,id:'retained-detached-copy',recipeId:omittedRecipeId,ingredientId:omittedIngredientId,
  name:'Third carrot',displayQuantity:'1 cup'};
 const detachCommands=planShoppingAction({doc:copySource.parent.doc,recipeCatalog:copySource,before:cookingBeforeRemoval.shopping,
  after:{...cookingBeforeRemoval.shopping,items:[...cookingBeforeRemoval.shopping.items,detachedCopy]},
  pantryBefore:cookingBeforeRemoval.pantry,pantryAfter:cookingBeforeRemoval.pantry,actionId:'copy-before-removal',author:a.deviceId,at});
 await save(a,a.runtime,'copy-before-removal',detachCommands);
 const {doc:thirdDoc}=await inserted.document();
 await save(a,inserted,'remove-entire-child',planRecipeAction({doc:thirdDoc,before:projectCooking(thirdDoc).recipes[0],
  after:null,actionId:'remove-entire-child',author:a.deviceId,at}));
 await edit(a,sibling,'first-sibling-title',{id:'sibling',title:'SUPERSEDED_SIBLING_TITLE'});
 await edit(a,sibling,'replace-sibling-title',{id:'sibling',title:'New sibling title'});
 const beforeIngredient=projectCooking((await ar.document()).doc).recipes[0];
 const removedCopy={...copied,id:'retained-ingredient-copy',recipeId,ingredientId:'removed-copied-ingredient',
  name:'Turnip',displayQuantity:'3 cups'};
 await edit(a,ar,'ingredient-canary',{id:recipeId,
  ingredients:[...beforeIngredient.ingredients,{id:'removed-ingredient',name:'HIDDEN_INGREDIENT_TEXT'},
   {id:removedCopy.ingredientId,name:removedCopy.name,amount:removedCopy.displayQuantity}]});
 const catalogBeforeIngredientRemoval=await openSelectedRecipeCatalog(a.runtime);
 const cookingBeforeIngredientRemoval=projectCooking(catalogBeforeIngredientRemoval.parent.doc);
 await save(a,a.runtime,'copy-before-ingredient-removal',planShoppingAction({
  doc:catalogBeforeIngredientRemoval.parent.doc,recipeCatalog:catalogBeforeIngredientRemoval,
  before:cookingBeforeIngredientRemoval.shopping,
  after:{...cookingBeforeIngredientRemoval.shopping,items:[...cookingBeforeIngredientRemoval.shopping.items,removedCopy]},
  pantryBefore:cookingBeforeIngredientRemoval.pantry,pantryAfter:cookingBeforeIngredientRemoval.pantry,
  actionId:'copy-before-ingredient-removal',author:a.deviceId,at}));
 await edit(a,ar,'remove-ingredient-canary',{id:recipeId,ingredients:beforeIngredient.ingredients});
 const agreement={version:1,householdId:scope.id,parentHead:a.root.head,policyHash:a.root.policyHash,
  roster:a.root.roster,delegation:'currentCooking',sourcePolicyHashes:[a.root.policyHash]};
 const signer={adultId:'adult',deviceId:a.deviceId};
 const signAdmission=async(kind,value)=>sodium.to_hex(await a.provider.sign(a.root.devices[0].signingKeyRef,domain(kind,value)));
 const signedAgreement={...agreement,acceptances:[{...signer,
  signature:await signAdmission('admission-agreement-acceptance',{agreement,...signer})}]};
 const delegationHash=await acceptAdmissionAgreement(a.storage,scope,a.root.head,a.provider,signedAgreement);
 await acceptAdmissionAgreement(b.storage,scope,b.root.head,b.provider,signedAgreement);
 const newcomerSign=sodium.crypto_sign_keypair(),newcomerWrap=sodium.crypto_box_keypair();
 t.after(()=>{newcomerSign.privateKey.fill(0);newcomerWrap.privateKey.fill(0);});
 const event={version:2,suiteId:a.runtime.scope.suiteId,householdId:scope.id,parentHead:a.root.head,
  policyHash:a.root.policyHash,generation:a.root.generation,epochId:a.root.epochId,proposalId:'invite-set',
  kind:'inviteAdult',authorDeviceId:a.deviceId,frozenAdultRoster:a.root.roster,
  subject:{adultId:'newcomer',devices:[{deviceId:'newcomer-device',peerId:'3',
    signingKeyRef:sodium.to_hex(newcomerSign.publicKey),wrappingKeyRef:sodium.to_hex(newcomerWrap.publicKey)}],
    documentId:'fresh-cooking',newGeneration:2,newEpochId:'fresh-epoch'},nextPolicy:null};
 const eventHash=await selectedSourceHash(a.provider,'event',event);
 const approval={version:1,householdId:scope.id,eventHash,parentHead:a.root.head,policyHash:a.root.policyHash,
  generation:a.root.generation,epochId:a.root.epochId,...signer};
 const admissionItem={event,authorSignature:await signAdmission('event-signature',event),
  approvals:[{...approval,signature:await signAdmission('approval-signature',approval)}]};
 const seedAllocations=new Map();
 const allocateSeed=documentId=>{
  if(!seedAllocations.has(documentId)){
   const index=seedAllocations.size+1;
   seedAllocations.set(documentId,{seedId:`11111111-1111-4111-8111-${String(index).padStart(12,'0')}`,peerId:String(900+index)});
  }
  return seedAllocations.get(documentId);
 };
 let raced=false;
 await assert.rejects(()=>prepareAdultRemovalProjection({runtime:a.runtime,service:a.service,
  destination:{parentHead:a.root.head,documentId:'race-target',epochId:'race-epoch',generation:2},
  allocateSeed:async documentId=>{
   if(!raced){raced=true;await edit(a,sibling,'projection-child-race',{id:'sibling',title:'Race title'});}
   return allocateSeed(documentId);
  }}),/CONFLICT|SOURCE_CHANGED/);
 await edit(a,sibling,'projection-child-restore',{id:'sibling',title:'New sibling title'});
 const prepare=()=>prepareCurrentDocumentSet({runtime:a.runtime,service:a.service,item:admissionItem,allocateSeed});
 const prepared=await prepare();
 const destination={parentHead:a.root.head,documentId:'removal-cooking',epochId:'removal-epoch',generation:2};
 const adult=await prepareAdultRemovalProjection({runtime:a.runtime,service:a.service,destination,allocateSeed});
 assert.deepEqual(adult.entries.map(entry=>entry.recipeId),[null,recipeId,'sibling']);
 assert.deepEqual(adult.documents,prepared.documents.map(({seed,policyBundle})=>({seed,policyBundle})));
 assert.deepEqual(adult.removed,prepared.manifest.catalog.removed);
 await assert.rejects(()=>prepareAdultRemovalProjection({runtime:a.runtime,service:a.service,
  destination:{...destination,epochId:a.root.epochId},allocateSeed}),/INVALID_DOCUMENT_SET/);
 const grantFor=async manifest=>{
  const unsigned={version:1,householdId:scope.id,parentHead:a.root.head,admissionEventHash:eventHash,
   sourcePolicyHashes:[a.root.policyHash],delegationHash,recipientAdult:'newcomer',recipientDevices:['newcomer-device'],
   contentClasses:['pantry','recipe','shopping'],projectionManifestHash:await selectedSourceHash(a.provider,'projection-manifest',manifest),
   newDocumentGeneration:2,newEpochId:'fresh-epoch',keyEnvelopeRefs:['projected-set-package']};
  return {...unsigned,signatures:[{...signer,signature:await signAdmission('current-state-grant-signature',{grant:unsigned,...signer})}]};
 };
 const {manifest,documents}=prepared,grant=await grantFor(manifest);
 assert.equal(prepared.manifestHash,grant.projectionManifestHash);
 assert.equal(manifest.catalog.sourceRevision,3);
 assert.equal(manifest.catalog.targetRevision,2);
 assert.equal(manifest.catalog.removed.length,1);
 assert.deepEqual(manifest.entries.map(entry=>entry.recipeId),[null,recipeId,'sibling']);
 assert.deepEqual(manifest.entries.map(entry=>entry.sourceDocumentId),[a.runtime.scope.documentId,ar.scope.documentId,sibling.scope.documentId]);
 assert.equal(documents[0].documentId,event.subject.documentId);
 const verifyOptions={storage:b.storage,scope,pin:b.root.head,provider:b.provider,item:admissionItem,grant,manifest,documents,LoroDoc};
 const recipientRows=b.rows();
 assert.equal((await verifyCurrentDocumentSet(verifyOptions)).eventHash,eventHash);
 assert.deepEqual((await prepare()).documents,documents);
 const checkSource=(draft=prepared)=>verifyCurrentDocumentSetSource({runtime:a.runtime,service:a.service,item:admissionItem,
  manifest:draft.manifest,documents:draft.documents});
 assert.deepEqual(await checkSource(),prepared.source);
 const omitted=structuredClone(prepared);
 omitted.manifest.catalog.targetRevision--;
 omitted.manifest.catalog.removed.push('f'.repeat(64));
 omitted.manifest.catalog.removed.sort();
 omitted.manifest.entries.pop();
 omitted.documents.pop();
 await assert.rejects(()=>checkSource(omitted),/SOURCE_CHANGED/);
 b.reopen();a.reopen();
 assert.deepEqual((await verifyCurrentDocumentSet(verifyOptions)).manifest,manifest);
 const fresh=documents.map(document=>{
  const doc=new LoroDoc();
  assert.ok(!doc.import(document.seed.snapshot).pending?.size);
  const ops=JSON.stringify(doc.exportJsonUpdates(undefined,undefined,false));
  for(const canary of ['HIDDEN_INGREDIENT_TEXT','removed-ingredient',omittedRecipeId,omittedIngredientId,removedCopy.ingredientId,
   'SUPERSEDED_SIBLING_TITLE','UNRELATED_PRIVATE_CANARY','recipe-intentions','recipeSource']){
   assert.equal(ops.includes(canary),false,canary);
  }
  return doc;
 });
 const links=items=>items.map(({id,recipeId,ingredientId,displayQuantity})=>({id,recipeId,ingredientId,displayQuantity}));
 const sourceItems=(await shopping(a.runtime)).items;
 const projectedItems=projectCooking(fresh[0]).shopping.items;
 assert.deepEqual(links(projectedItems),links(sourceItems.map(item=>item.id===detachedCopy.id?
  {...item,recipeId:undefined,ingredientId:undefined}:item.id===removedCopy.id?{...item,ingredientId:undefined}:item)));
 const detached=projectedItems.find(item=>item.id===detachedCopy.id);
 assert.equal(detached.name,detachedCopy.name);
 assert.equal(detached.displayQuantity,detachedCopy.displayQuantity);
 for(const field of ['recipeId','ingredientId']){
  assert.equal(fresh[0].getMap('shopping-item-fields:'+detachedCopy.id).get(field),undefined);
  assert.equal(fresh[0].getMap('field-head:'+encodeURIComponent(JSON.stringify(['shopping-item',detachedCopy.id,field]))).get('effect'),undefined);
 }
 const detachedEffect=fresh[0].getMap('shopping-item:'+detachedCopy.id).get('value').effectId;
 assert.ok(documents[0].policyBundle.entries.find(entry=>entry.effectId===detachedEffect).policyHashes.includes(accepted.policyHash));
 const recipeOnly=projectedItems.find(item=>item.id===removedCopy.id);
 assert.equal(recipeOnly.recipeId,recipeId);
 assert.equal(recipeOnly.name,removedCopy.name);
 assert.equal(recipeOnly.displayQuantity,removedCopy.displayQuantity);
 assert.equal(fresh[0].getMap('field-head:'+encodeURIComponent(JSON.stringify(['shopping-item',removedCopy.id,'ingredientId']))).get('effect'),undefined);
 const copyEffect=fresh[0].getMap('shopping-item:'+removedCopy.id).get('value').effectId;
 assert.ok(documents[0].policyBundle.entries.find(entry=>entry.effectId===copyEffect).policyHashes.includes(accepted.policyHash));
 assert.equal(projectCooking(fresh[1]).recipes[0].title,'New child title');
 assert.equal(projectCooking(fresh[2]).recipes[0].title,'New sibling title');
 const copiedEffect=fresh[0].getMap('shopping-item:selected-item').get('value').effectId;
 assert.ok(documents[0].policyBundle.entries.find(entry=>entry.effectId===copiedEffect).policyHashes.includes(accepted.policyHash));
 const stolen=structuredClone(documents);
 stolen[1].seed.snapshot=(await ar.document()).storedBytes;
 const sealedOldHistory=structuredClone(manifest);
 sealedOldHistory.entries[1].snapshotHash=await selectedSourceHash(a.provider,'projection-snapshot',
  sodium.to_hex(stolen[1].seed.snapshot));
 await assert.rejects(async()=>verifyCurrentDocumentSet({...verifyOptions,manifest:sealedOldHistory,
  grant:await grantFor(sealedOldHistory),documents:stolen}),/INVALID_SEED/);
 const malformed=structuredClone(documents),malformedManifest=structuredClone(manifest);
 const malformedDoc=new LoroDoc();
 malformedDoc.setPeerId(malformed[1].seed.peerId);
 for(const [container,entries] of Object.entries(fresh[1].toJSON())){
  for(const [key,value] of Object.entries(entries)){
   malformedDoc.getMap(container).set(key,container.startsWith('recipe:')&&key==='title'?{old:'HIDDEN_OLD_TITLE'}:value);
  }
 }
 const invalidSnapshot=malformedDoc.export({mode:'snapshot'});
 malformed[1].seed.snapshot=invalidSnapshot;
 malformed[1].policyBundle.snapshotHash=await disclosureHash(a.provider,'seed-snapshot',Array.from(invalidSnapshot));
 malformedManifest.entries[1].snapshotHash=await selectedSourceHash(a.provider,'projection-snapshot',sodium.to_hex(invalidSnapshot));
 malformedManifest.entries[1].policyBundleHash=await disclosureHash(a.provider,'projection-policy-bundle',malformed[1].policyBundle);
 await assert.rejects(async()=>verifyCurrentDocumentSet({...verifyOptions,manifest:malformedManifest,
  grant:await grantFor(malformedManifest),documents:malformed}),/INVALID_SEED/);
 for(const badDocuments of [documents.slice(1),[...documents,documents[1]],[documents[0],documents[2],documents[2]],
  [documents[0],{...documents[1],policyBundle:documents[2].policyBundle},documents[2]]]){
  await assert.rejects(()=>verifyCurrentDocumentSet({...verifyOptions,documents:badDocuments}),/INVALID_DOCUMENT_SET|INVALID_PROOF/);
 }
 for(const forgedManifest of [{...manifest,rootPin:'0'.repeat(64)},
  {...manifest,catalog:{...manifest.catalog,removed:[]}},
  {...manifest,authorizationSnapshot:'0'.repeat(64)}]){
  await assert.rejects(async()=>verifyCurrentDocumentSet({...verifyOptions,manifest:forgedManifest,
   grant:await grantFor(forgedManifest)}),/INVALID_DOCUMENT_SET/);
 }
 assert.deepEqual(b.rows(),recipientRows);

 const freshDatabase=mkdtempSync(join(tmpdir(),'recipe-set-newcomer-'));
 let freshDb=new DatabaseSync(join(freshDatabase,'peer.sqlite'));
 t.after(()=>{freshDb.close();rmSync(freshDatabase,{recursive:true});});
 let freshFault;
 const freshConnection={executeSync(sql,params=[]){
  const statement=freshDb.prepare(sql);
  return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])};
 }};
 const freshStorage=openSQLiteStorage(freshConnection,boundary=>{if(boundary===freshFault)throw Error('injected');});
 const freshRows=()=>freshDb.prepare('SELECT key,value FROM loro_records ORDER BY key').all();
 const reopenFresh=()=>{freshDb.close();freshDb=new DatabaseSync(join(freshDatabase,'peer.sqlite'));};
 const record=must(await a.storage.readPairingAuthority(scope));
 must(await freshStorage.retainPublicHouseholdParent({...record,revision:0}));
 const newcomerMaster=testMaster();
 await freshStorage.localKeys(newcomerMaster,sodium).provision('newcomer-master');
 const oldIdentity={version:1,scope,deviceId:a.deviceId,purpose:'data',epochId:a.root.epochId};
 await a.storage.localKeys(sponsorMaster,sodium).generate('legacy-epoch-key',oldIdentity);
 const sponsorWrap=sodium.crypto_box_keypair(),existingWrap=sodium.crypto_box_keypair();
 t.after(()=>{sponsorWrap.privateKey.fill(0);existingWrap.privateKey.fill(0);});
 const sponsorKeys={signingSecret:a.signingTestKey.privateKey,wrappingSecret:sponsorWrap.privateKey};
 const newcomerKeys={signingSecret:newcomerSign.privateKey,wrappingSecret:newcomerWrap.privateKey};
 const existingKeys={signingSecret:b.signingTestKey.privateKey,wrappingSecret:existingWrap.privateKey};
 const sponsorSession=fixtureSessionStore(a.connection),newcomerSession=fixtureSessionStore(freshConnection),
  existingSession=fixtureSessionStore(b.connection);
 const newcomerContext={version:1,householdId:scope.id,parentHead:record.acceptedParent,admissionEventHash:eventHash,
  sponsorAdult:'adult',recipientAdult:'newcomer',sponsorDeviceId:a.deviceId,sponsorSigningKeyRef:a.root.devices[0].signingKeyRef,
  sponsorWrappingKeyRef:sodium.to_hex(sponsorWrap.publicKey),recipientDeviceId:event.subject.devices[0].deviceId,
  recipientSigningKeyRef:sodium.to_hex(newcomerSign.publicKey),recipientWrappingKeyRef:sodium.to_hex(newcomerWrap.publicKey)};
 const existingContext={version:1,householdId:scope.id,parentHead:record.acceptedParent,admissionEventHash:eventHash,
  newEpochId:event.subject.newEpochId,sponsorDeviceId:a.deviceId,recipientDeviceId:b.deviceId,
  recipientWrappingKey:sodium.to_hex(existingWrap.publicKey)};
 function completedPair(context,action,signingPublicKey,wrappingPublicKey,use,recipientKeys,signal,
   authority=record,sessionId=`set-${action}`){
  const transcript={version:1,sessionId,action,scope,purpose:'data',acceptedParent:authority.acceptedParent,
   authorizationSnapshot:authority.authorizationSnapshot,signaling:[signal(context)].flat(),
   initiator:{role:'initiator',deviceId:a.deviceId,signingPublicKey:a.signingTestKey.publicKey,
    wrappingPublicKey:sponsorWrap.publicKey,nonce:sodium.randombytes_buf(32)},
   responder:{role:'responder',deviceId:context.recipientDeviceId,signingPublicKey,
    wrappingPublicKey,nonce:sodium.randombytes_buf(32)}};
  const guard={version:1,guardId:`${sessionId}-guard`,scope,direction:'initiator-to-responder',purpose:'data'};
  const oob={hash:sodium.to_hex(sodium.crypto_generichash(32,ceremonyBytes(transcript,guard))),
   pins:Object.fromEntries(['initiator','responder'].map(role=>[role,{deviceId:transcript[role].deviceId,
    signingKey:sodium.to_hex(transcript[role].signingPublicKey),wrappingKey:sodium.to_hex(transcript[role].wrappingPublicKey)}]))};
  const sponsor=durableSession(sodium,sponsorSession,sponsorKeys,transcript,guard,'initiator',oob);
  const recipient=durableSession(sodium,use,recipientKeys,transcript,guard,'responder',oob);
  const first=sponsor.initialize(),second=recipient.initialize();
  const left=sponsor.respond(second,0),right=recipient.respond(first,0);
  const leftAck=sponsor.acknowledge(right,1),rightAck=recipient.acknowledge(left,1);
  sponsor.finish(rightAck,2);recipient.finish(leftAck,2);
  return {transcript,guard,context,oob,messages:sponsor.evidence().messages};
 }
 const ceremonies=[completedPair(newcomerContext,'inviteAdult',newcomerSign.publicKey,newcomerWrap.publicKey,
  newcomerSession,newcomerKeys,householdSessionContextBytes)];
 const existingCeremonies=[completedPair(existingContext,'pairOwnDevice',b.signingTestKey.publicKey,existingWrap.publicKey,
  existingSession,existingKeys,existingRecipientContextBytes)];
 const selectionBody={from:record.acceptedParent,to:eventHash,deviceId:a.deviceId,index:0};
 const selection={...selectionBody,signature:await signAdmission('select-head',{root:a.root.head,householdId:scope.id,...selectionBody})};
 const publicationInput={sodium,storage:a.storage,scope,pin:a.root.head,provider:a.provider,keys:sponsorKeys,
  sessionStore:sponsorSession,master:sponsorMaster,runtime:a.runtime,service:a.service,item:admissionItem,grant,manifest,
  documents,selection,localDeviceId:a.deviceId,ceremonies,existingCeremonies,keyOperationId:'set-sponsor-key'};
 const attempt=(updates={})=>publishHouseholdDocumentSet({...publicationInput,...updates});
 const beforePublisher=a.rows();
 const wrongWrappedKey=(master,inPlace)=>({...master,async wrap(id,key,aad){
  const changed=inPlace?key:new Uint8Array(key);
  changed[0]^=1;
  try{return await master.wrap(id,changed,aad);}finally{if(!inPlace)changed.fill(0);}
 }});
 for(const inPlace of [true,false]){
  await assert.rejects(()=>attempt({master:wrongWrappedKey(sponsorMaster,inPlace)}),/LOCKED/);
  assert.deepEqual(a.rows(),beforePublisher);
 }
 const operationId=event.proposalId;
 const sealOptions={sodium,storage:a.storage,scope,pin:a.root.head,provider:a.provider,keys:sponsorKeys,
  sessionStore:sponsorSession,operationId,LoroDoc,recipientDevice:newcomerContext.recipientDeviceId,kind:'document-set'};
 await assert.rejects(()=>sealHouseholdFile(sealOptions),/MISSING_PUBLICATION/);
 for(const fault of ['projection-set-keys','projection-set-catalog','projection-set-authority']){
  a.faultAt(fault);
  await assert.rejects(()=>attempt(),/IO/);
  a.reopen();
  assert.deepEqual(a.rows(),beforePublisher);
 }
 a.faultAt(null);
 // Each change lands after cryptographic checks and before the durable CAS.
 const commitSet=a.storage.publishProjection.bind(a.storage);
 let acceptedDraft=prepared,finalInput={};
 for(const mutate of [
  ()=>a.edit('transaction-root-race',++sequence),
  ()=>edit(a,ar,'transaction-child-race',{id:recipeId,description:'Concurrent description'}),
  async()=>edit(a,await a.runtime.forRecipe('racing-child'),'racing-child',recipe('racing-child','Concurrent recipe')),
 ]){
  a.storage.publishProjection=async(...args)=>{
   a.storage.publishProjection=commitSet;
   await mutate();
   return commitSet(...args);
  };
  await assert.rejects(()=>attempt(finalInput),/CONFLICT/);
  assert.equal(must(await a.storage.getProjectionPublication(scope.id,operationId)),null);
  assert.equal(must(await a.storage.reopenDocument(scope.id,event.subject.documentId)),null);
  acceptedDraft=await prepare();
  finalInput={grant:await grantFor(acceptedDraft.manifest),manifest:acceptedDraft.manifest,documents:acceptedDraft.documents};
 }
 // Both runs initially miss the publication. The winner commits before the
 // other run first checks its local key slot.
 const sponsorLocalKeys=a.storage.localKeys;
 a.storage.localKeys=(...args)=>{
  a.storage.localKeys=sponsorLocalKeys;
  const local=sponsorLocalKeys(...args),prepareKey=local.prepareForAtomicInstall.bind(local);
  local.prepareForAtomicInstall=async(...keyArgs)=>{
   assert.deepEqual(await attempt(finalInput),{replayed:false,operationId,head:eventHash});
   return prepareKey(...keyArgs);
  };
  return local;
 };
 assert.deepEqual(await attempt(finalInput),{replayed:true,operationId,head:eventHash});
 a.reopen();
 assert.deepEqual(await attempt(finalInput),{replayed:true,operationId,head:eventHash});
 const sealed=await sealHouseholdFile(sealOptions);
 const existingSealed=await sealHouseholdFile({...sealOptions,recipientDevice:b.deviceId});
 assert.deepEqual(await sealHouseholdFile(sealOptions),sealed);
 await assert.rejects(()=>sealHouseholdFile({...sealOptions,kind:'admission'}),/UNSUPPORTED_VERSION/);
 const release=await householdDocumentSetRelease(sealOptions);
 const newcomerOptions={sodium,storage:freshStorage,scope,pin:a.root.head,provider:a.provider,keys:newcomerKeys,
  sessionStore:newcomerSession,master:newcomerMaster,keyOperationId:'set-newcomer-key',confirmedParent:record.acceptedParent,
  recipientDevice:newcomerContext.recipientDeviceId,recipientKind:'document-set',LoroDoc};
 const confirmedInvitation={confirmedEventHash:eventHash,confirmedGrantHash:must(await a.storage.getProjectionPublication(scope.id,operationId)).grantHash,
  confirmedTranscriptHash:ceremonies[0].oob.hash};
 const joinName='v5-joined-fixture';
 const openDatabase=name=>{
  const database=new DatabaseSync(join(freshDatabase,`${name}.sqlite`));
  return {executeSync(sql,params=[]){
   const statement=database.prepare(sql);
   return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])};
  },close:()=>database.close()};
 };
 const openJoin=()=>openNativeHouseholdPersistence({name:joinName,openDatabase,
  workspaceRun:openSQLiteTransaction(freshConnection),master:newcomerMaster,storage:freshStorage,
  provider:a.provider,sodium,deviceId:newcomerOptions.recipientDevice});
 let joinStore=openJoin();
 t.after(()=>joinStore.close());
 const joinId=householdReceiverIds(sodium,scope,newcomerOptions.recipientDevice).operationId;
 const enrollment={scope,pin:a.root.head,operationId:joinId,confirmedParent:record.acceptedParent};
 await joinStore.prepareJoinedSequences(enrollment);
 const install=(bytes=sealed)=>installHouseholdFile({...newcomerOptions,...confirmedInvitation,bytes});
 const beforeNewcomer=freshRows();
 await assert.rejects(()=>installHouseholdFile({...newcomerOptions,bytes:sealed,recipientKind:'existing'}),/INVALID_AUTHORITY/);
 assert.deepEqual(freshRows(),beforeNewcomer);
 for(const field of Object.keys(confirmedInvitation)){
  await assert.rejects(()=>installHouseholdFile({...newcomerOptions,...confirmedInvitation,[field]:'0'.repeat(64),
   bytes:sealed,prepareEnrollment:()=>assert.fail('Unverified invitation reached enrollment')}),/INVALID_PROOF/);
 }
 assert.deepEqual(freshRows(),beforeNewcomer);
 const bad=structuredClone(release);
 [bad.packets[1],bad.packets[2]]=[bad.packets[2],bad.packets[1]];
 const forgedBytes=encodeHouseholdDocumentSetFile(bad);
 const forgedFile=sodium.crypto_box_seal(forgedBytes,newcomerWrap.publicKey);
 forgedBytes.fill(0);
 await assert.rejects(()=>install(forgedFile),/INVALID_KEY_PACKAGE/);
 await assert.rejects(()=>install(existingSealed),/INVALID_FILE|INVALID_DOCUMENT_SET/);
 await assert.rejects(()=>installHouseholdFile({...newcomerOptions,bytes:sealed,recipientKind:'newcomer'}),/INVALID_FILE/);
 assert.deepEqual(freshRows(),beforeNewcomer);
 for(const inPlace of [true,false]){
  await assert.rejects(()=>installHouseholdFile({...newcomerOptions,bytes:sealed,
   master:wrongWrappedKey(newcomerMaster,inPlace)}),/LOCKED/);
  assert.deepEqual(freshRows(),beforeNewcomer);
 }
 for(const fault of ['projection-set-keys','projection-set-catalog','projection-set-authority']){
  freshFault=fault;
  await assert.rejects(()=>install(),/IO/);
  reopenFresh();
  assert.deepEqual(freshRows(),beforeNewcomer);
 }
 freshFault=null;
 // Pause after reading an absent receipt until an identical install advances
 // the parent. An exact retry must verify the retained original parent.
 const getPublication=freshStorage.getProjectionPublication.bind(freshStorage);
 freshStorage.getProjectionPublication=async(...args)=>{
  freshStorage.getProjectionPublication=getPublication;
  const absent=await getPublication(...args);
  assert.equal(must(absent),null);
  assert.deepEqual(await install(),{replayed:false,head:eventHash});
  return absent;
 };
 assert.deepEqual(await install(),{replayed:true,head:eventHash});
 const withoutPin=freshRows();
 await assert.rejects(()=>joinStore.finalizeJoinedSequences(enrollment),/INVALID_ADMISSION/);
 assert.deepEqual(freshRows(),withoutPin);
 await joinStore.pins.save({version:1,scope,pin:a.root.head,head:record.acceptedParent});
 await assert.rejects(()=>joinStore.selection.select(scope),/INCOMPLETE_ENROLLMENT/);
 await assert.rejects(()=>joinStore.finalizeJoinedSequences({...enrollment,confirmedParent:'wrong-parent'}),/INVALID_ADMISSION/);
 const joined=await joinStore.finalizeJoinedSequences(enrollment);
 assert.equal(joined.resolved.scope.branchHead,eventHash);
 assert.equal(joined.installedSet.operationId,operationId);
 const firstSequence=await joined.sequences.reserve(scope.id,'v5-first-action');
 joined.sequences.close();
 await joinStore.selection.select(scope,eventHash);
 joinStore.close();reopenFresh();joinStore=openJoin();
 const reselected=await joinStore.selection.openSelected();
 assert.equal(reselected.resolved.scope.branchHead,eventHash);
 assert.equal(await reselected.sequences.reserve(scope.id,'v5-first-action'),firstSequence);
 reselected.sequences.close();
 reopenFresh();
 assert.deepEqual(await install(),{replayed:true,head:eventHash});
 const sponsorSelected=await readInstalledHouseholdDocumentSet(sealOptions);
 const newcomerSelected=await readInstalledHouseholdDocumentSet({...newcomerOptions,operationId});
 assert.deepEqual(newcomerSelected.documents,sponsorSelected.documents);
 const sponsorAuthority=await resolveInstalledSetAuthority({...sealOptions,authorDevice:a.deviceId});
 const newcomerAuthority=await resolveInstalledSetAuthority({...newcomerOptions,operationId,authorDevice:newcomerContext.recipientDeviceId});
 assert.deepEqual(sponsorAuthority.members,newcomerAuthority.members);
 assert.deepEqual(sponsorAuthority.members.map(member=>member.documentId),sponsorSelected.documents.map(document=>document.documentId));
 await assert.rejects(()=>resolveRuntimeAuthority(a.storage,scope,a.root.head,a.provider,a.deviceId),/UNSUPPORTED_VERSION/);
 await assert.rejects(()=>resolveInstalledSetAuthority({...sealOptions,authorDevice:'unauthorized'}),/UNAUTHORIZED_DEVICE/);

 // Exercise the production codec against the independently installed catalogs.
 const sponsorCatalog=a.storage.localKeys(sponsorMaster,sodium);
 const newcomerCatalog=freshStorage.localKeys(newcomerMaster,sodium);
 const sponsorContent=await installedDocumentSetContent(sealOptions,sponsorCatalog);
 const callerScope={...scope};
 const openingContent=installedDocumentSetContent({...newcomerOptions,scope:callerScope,operationId},newcomerCatalog);
 callerScope.id='redirected';
 const newcomerContent=await openingContent;
 const signingRef=sodium.to_hex(a.signingTestKey.publicKey);
 const signerKeys={use:(op,identity,fn)=>op==='test-signing'?fn(a.signingTestKey.privateKey):sponsorCatalog.use(op,identity,fn)};
 const sender=candidateCodec(localProvider(sodium,signerKeys,{signing:{publicKey:signingRef,operationId:'test-signing'},content:sponsorContent}));
 const receiver=candidateCodec(localProvider(sodium,newcomerCatalog,{signing:{publicKey:''},content:newcomerContent}));
 const routingManifest=sponsorSelected.item.admission.manifest;
 const header={version:1,suiteId:SUITE,scopeId:scope.id,documentId:routingManifest.newDocumentId,
  documentGeneration:routingManifest.newGeneration,branchHead:eventHash,policyHashes:[],epochId:routingManifest.newEpochId,
  authorDevice:signingRef,deviceSequence:1,predecessorRefs:[],semanticEffectIds:[],payloadKind:'snapshot'};
 const payload=new Uint8Array([1,2,3]);
 for(const documentId of [routingManifest.newDocumentId,routingManifest.entries[1].documentId]){
  const h={...header,documentId};
  const object=await sender.sealContent(h,payload,h.epochId);
  assert.deepEqual((await receiver.openContent(object.bytes)).value,payload);
  for(const bad of [{scopeId:'wrong'},{branchHead:'wrong'},{epochId:'wrong'}, {documentGeneration:h.documentGeneration+1},{documentId:'wrong'}])
   await assert.rejects(()=>sender.sealContent({...h,...bad},payload,h.epochId),/INVALID_AUTHORITY/);
 }
 // A validly signed child envelope encrypted with the root key must not open.
 const rootOnly=(ref,fn)=>sponsorCatalog.use(sponsorSelected.publication.localKey.record.operationId,sponsorSelected.publication.localKey.record.identity,fn);
 const wrongSender=candidateCodec(localProvider(sodium,signerKeys,{signing:{publicKey:signingRef,operationId:'test-signing'},content:rootOnly}));
 const wrongObject=await wrongSender.sealContent({...header,documentId:routingManifest.entries[1].documentId},payload,header.epochId);
 await assert.rejects(()=>receiver.openContent(wrongObject.bytes));
 const wrongScope=await wrongSender.sealContent({...header,scopeId:'wrong'},payload,header.epochId);
 await assert.rejects(()=>receiver.openContent(wrongScope.bytes),/INVALID_AUTHORITY/);

 // Exercise the shared origin verifier with the genuine installed v5 receipt.
 const {verifyJoinedOrigin}=await import('./joined-household-authority.mjs');
 await readAuthority(freshStorage,scope,a.root.head,a.provider);
 const originChain=JSON.parse(new TextDecoder().decode(must(await freshStorage.readPairingAuthority(scope)).authorityState));
 const originArgs={chain:originChain,expectedParent:eventHash,savedPin:{scope,pin:a.root.head,head:record.acceptedParent},
  storage:freshStorage,scope,pin:a.root.head,provider:a.provider,sodium,deviceId:newcomerContext.recipientDeviceId};
 await verifyJoinedOrigin(originArgs);
 await assert.rejects(()=>verifyJoinedOrigin({...originArgs,savedPin:{...originArgs.savedPin,head:'wrong'}}),/INVALID_ADMISSION/);
 const unrelatedOrigin=structuredClone(originChain);
 unrelatedOrigin.events.find(item=>item.admission?.grant?.admissionEventHash===eventHash).event.parentHead='unrelated';
 await assert.rejects(()=>verifyJoinedOrigin({...originArgs,chain:unrelatedOrigin}),/INVALID_ADMISSION/);
 const installedAuthority=await readAuthority(freshStorage,scope,a.root.head,a.provider);
 assert.equal(installedAuthority.activeHead,eventHash);
 const installedRecord=must(await freshStorage.readPairingAuthority(scope));
 const beforeRewrite=freshRows();
 const blockedRewrite=await freshStorage.compareAndSwapPairingAuthority({expectedRevision:installedRecord.revision,
  record:{...installedRecord,revision:installedRecord.revision+1}});
 assert.deepEqual(blockedRewrite,{ok:false,error:'UNSUPPORTED_VERSION'});
 assert.deepEqual(freshRows(),beforeRewrite);
 const expectedAuthority={version:2,scope,record:{revision:installedRecord.revision,
  acceptedParent:installedRecord.acceptedParent,authorizationSnapshot:installedRecord.authorizationSnapshot}};
 const seedContext={current:installedAuthority,resolved:{expectedAuthority}};
 const seedRuntime=documentId=>({storage:freshStorage,LoroDoc,authority:{rootPin:a.root.head,provider:a.provider},
  scope:{scopeId:scope.id,documentId,branchHead:eventHash,epochId:routingManifest.newEpochId,
   documentGeneration:routingManifest.newGeneration}});
 for(const {documentId,policyBundle} of newcomerSelected.documents){
  const source=await verifiedSeedSources({runtime:seedRuntime(documentId),context:seedContext});
  assert.equal(source.sourceMapping,'signed-attestation-only');
  assert.deepEqual([...source.entries],policyBundle.entries.map(entry=>[entry.effectId,entry.policyHashes]));
 }
 const [seedRoot,seedChild]=newcomerSelected.documents;
 const swappedSidecar=must(await freshStorage.readProjectionPolicySeed(expectedAuthority,seedChild.documentId));
 const wrongSeedSource={...seedRuntime(seedRoot.documentId),storage:{
  readProjectionPolicySeed:async()=>({ok:true,value:swappedSidecar}),
 }};
 await assert.rejects(()=>verifiedSeedSources({runtime:wrongSeedSource,context:seedContext}),/INVALID_SEED_PROOF/);
 assert.equal(newcomerSelected.publication.documentSet.catalog.length,3);
 const beforeReplay=freshRows();
 const wrongChildEpoch=newcomerSelected.publication.documentSet.childKeys[0].identity.epochId;
 const wrongChildMaster={...newcomerMaster,async unwrap(id,bytes,aad){
  const key=await newcomerMaster.unwrap(id,bytes,aad);
  if(JSON.parse(new TextDecoder().decode(aad)).at(-1)===wrongChildEpoch)key[0]^=1;
  return key;
 }};
 for(const master of [testMaster(),wrongChildMaster]){
  await assert.rejects(()=>installHouseholdFile({...newcomerOptions,bytes:sealed,master}),/LOCKED/);
  assert.deepEqual(freshRows(),beforeReplay);
 }
 for(const [index,document] of newcomerSelected.documents.entries()){
  const saved=must(await freshStorage.readRetainedProjectionSeed(scope.id,document.documentId));
  assert.deepEqual(saved,{
   seed:newcomerSelected.publication.documentSet.seeds[index].seed,
   snapshot:document.seed.snapshot,head:eventHash,
  });
 }
 const catalogSlot=JSON.stringify(['projection-document-set',scope.id,eventHash]);
 const installedCatalog=freshRows().find(row=>row.key===catalogSlot).value;
 freshDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify({
  ...JSON.parse(installedCatalog),catalog:[],
 }),catalogSlot);
 reopenFresh();
 await assert.rejects(()=>install(),/CORRUPT/);
 freshDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(installedCatalog,catalogSlot);
 const childEntry=newcomerSelected.item.admission.manifest.entries.find(entry=>entry.recipeId===recipeId);
 const child=newcomerSelected.documents.find(document=>document.documentId===childEntry.documentId);
 const childSlot=JSON.stringify(['document',scope.id,child.documentId]);
 const installedChild=freshRows().find(row=>row.key===childSlot).value;
 freshDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify({
  ...JSON.parse(installedChild),revision:1,
 }),childSlot);
 reopenFresh();
 await assert.rejects(()=>install(),/CORRUPT/);
 freshDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(installedChild,childSlot);
 assert.deepEqual(await install(),{replayed:true,head:eventHash});
 const originalSeed=new LoroDoc();
 originalSeed.import(child.seed.snapshot);
 const extendChild=doc=>{
  doc.setPeerId(event.subject.devices[0].peerId);
  const recipeEffect=doc.getMap('recipe-index').get(recipeId);
  apply(doc,{version:1,kind:'recipe-field',commandId:'future-child-edit',effectId:'future-child-edit',
   dependencyEffectIds:[recipeEffect],data:{recipeId,field:'description',value:'Edited after transfer',
    author:newcomerOptions.recipientDevice,at}});
  return doc.export({mode:'snapshot'});
 };
 const writeChild=bytes=>freshDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify({
  revision:1,bytes:{__storageBytes:Array.from(bytes)},
 }),childSlot);
 const advanced=new LoroDoc();
 advanced.import(child.seed.snapshot);
 const advancedBytes=extendChild(advanced);
 writeChild(advancedBytes);
 reopenFresh();
 assert.deepEqual(await install(),{replayed:true,head:eventHash});
 assert.equal((await readAuthority(freshStorage,scope,a.root.head,a.provider)).activeHead,eventHash);
 assert.deepEqual(must(await freshStorage.reopenDocument(scope.id,child.documentId)).bytes,advancedBytes);
 assert.deepEqual(must(await freshStorage.readRetainedProjectionSeed(scope.id,child.documentId)).snapshot,child.seed.snapshot);

 const forgedChild=new LoroDoc();
 forgedChild.setPeerId(child.seed.peerId);
 for(const [name,values] of Object.entries(originalSeed.toJSON())){
  for(const [key,value] of Object.entries(values)){
   forgedChild.getMap(name).set(key,name===`recipe:${encodeURIComponent(recipeId)}`&&key==='title'?'Changed baseline':value);
  }
 }
 assert.deepEqual(forgedChild.frontiers(),originalSeed.frontiers());
 writeChild(extendChild(forgedChild));
 reopenFresh();
 await assert.rejects(()=>install(),/CORRUPT/);
 await assert.rejects(()=>readAuthority(freshStorage,scope,a.root.head,a.provider),/CORRUPT/);
 freshDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(installedChild,childSlot);

 assert.equal(must(await freshStorage.reopenDocument(scope.id,ar.scope.documentId)),null);
 assert.equal(must(await freshStorage.reopenDocument(scope.id,a.runtime.scope.documentId)),null);
 assert.ok(must(await a.storage.reopenDocument(scope.id,ar.scope.documentId)));
 assert.ok(must(await a.storage.getLocalOperation(scope.id,'remove-entire-child')));
 assert.ok(sponsorSelected.publication.pendingEdits.some(operation=>operation.operationId==='remove-entire-child'));
 assert.ok(!freshRows().some(({key})=>{const slot=JSON.parse(key);return slot[0]==='local-key'&&slot[5]===a.root.epochId;}));
 await assert.rejects(()=>resolveRuntimeAuthority(freshStorage,scope,a.root.head,a.provider,newcomerContext.recipientDeviceId),
  /UNSUPPORTED_VERSION/);
 const sponsorKeysSaved=[sponsorSelected.publication.localKey.record,...sponsorSelected.publication.documentSet.childKeys];
 const newcomerKeysSaved=[newcomerSelected.publication.localKey.record,...newcomerSelected.publication.documentSet.childKeys];
 const distinctKeys=new Set();
 for(const [index,saved] of sponsorKeysSaved.entries()){
  await a.storage.localKeys(sponsorMaster,sodium).useIdentity(saved.identity,key=>
   freshStorage.localKeys(newcomerMaster,sodium).useIdentity(newcomerKeysSaved[index].identity,received=>{
    assert.deepEqual(received,key);
    distinctKeys.add(sodium.to_hex(sodium.crypto_generichash(32,key)));
   }));
 }
 assert.equal(distinctKeys.size,acceptedDraft.documents.length);
 // The existing device can have a different, independently signed selection
 // history at the same parent. Its history remains local after installation.
 const localParent=must(await b.storage.readPairingAuthority(scope));
 const localState=JSON.parse(new TextDecoder().decode(localParent.authorityState));
 const localBody={root:a.root.head,householdId:scope.id,from:a.root.head,to:a.root.head,deviceId:b.deviceId,index:0};
 const localSelection={from:localBody.from,to:localBody.to,deviceId:b.deviceId,index:0,
  signature:sodium.to_hex(sodium.crypto_sign_detached(domain('select-head',localBody),b.signingTestKey.privateKey))};
 localState.selections.push(localSelection);
 const localRecord={...localParent,revision:localParent.revision+1,authorizationSnapshot:await snapshotId(a.provider,localState),authorityState:authorityBytes(localState)};
 must(await b.storage.compareAndSwapPairingAuthority({expectedRevision:localParent.revision,record:localRecord}));
 const existingOptions={...newcomerOptions,storage:b.storage,keys:existingKeys,recipientDevice:b.deviceId,recipientKind:'existing',
  sessionStore:existingSession,master:existingMaster,keyOperationId:'set-existing-key',bytes:existingSealed,
  prepareEnrollment:()=>assert.fail('Existing device must reuse its counter')};
 const beforeExisting=b.rows();
 const authoritySlot=JSON.stringify(['pairing-authority','household',scope.id]);
 const originalAuthority=beforeExisting.find(row=>row.key===authoritySlot).value;
 const corruptedAuthority=JSON.parse(originalAuthority);corruptedAuthority.authorizationSnapshot='0'.repeat(64);
 b.replaceRow(authoritySlot,JSON.stringify(corruptedAuthority));
 await assert.rejects(()=>installHouseholdFile(existingOptions),/INVALID_AUTHORITY/);
 b.replaceRow(authoritySlot,originalAuthority);
 await assert.rejects(()=>installHouseholdFile({...existingOptions,confirmedParent:'stale-head'}),/INVALID_AUTHORITY/);
 const brokenCipher=new Uint8Array(existingSealed);brokenCipher[0]^=1;
 await assert.rejects(()=>installHouseholdFile({...existingOptions,bytes:brokenCipher}),/INVALID_FILE/);
 const existingRelease=await householdDocumentSetRelease({...sealOptions,recipientDevice:b.deviceId});
 const reseal=release=>sodium.crypto_box_seal(encodeHouseholdDocumentSetFile(release),existingWrap.publicKey);
 // A file sealed by the previous release format must remain an exact retry.
 const {publisherParent:ignoredPublisherParent,...legacyFields}=existingRelease;
 const legacyRelease={...legacyFields,version:1},legacyPlain=encodeHouseholdDocumentSetFile(legacyRelease);
 const legacyDigest=sodium.to_hex(sodium.crypto_generichash(32,legacyPlain));legacyPlain.fill(0);
 const legacyBytes=reseal(legacyRelease),legacySignature=sodium.crypto_sign_detached(domain('household-sealed-file',{
  scopeId:scope.id,operationId,recipientDevice:b.deviceId,digest:legacyDigest,
  cipherHash:sodium.to_hex(sodium.crypto_generichash(32,legacyBytes))}),sponsorKeys.signingSecret);
 // Legacy wire files installed now still get a ciphertext-bound receipt.
 const legacyDb=new DatabaseSync(':memory:');
 t.after(()=>legacyDb.close());
 const legacyStorage=openSQLiteStorage({executeSync(sql,params=[]){
  const statement=legacyDb.prepare(sql);
  return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])};
 }});
 const insertLegacy=legacyDb.prepare('INSERT INTO loro_records VALUES (?,?)');
 for(const {key,value} of beforeExisting)insertLegacy.run(key,key===authoritySlot?beforePublisher.find(row=>row.key===key).value:value);
 const legacyOptions={...existingOptions,storage:legacyStorage,bytes:legacyBytes};
 const readLegacyRows=legacyDb.prepare('SELECT key,value FROM loro_records ORDER BY key');
 const beforeLegacy=readLegacyRows.all();
 await assert.rejects(()=>installHouseholdFile({...legacyOptions,recipientKind:'document-set',
  prepareEnrollment:()=>assert.fail('An existing device reached newcomer enrollment')}),/INVALID_AUTHORITY/);
 assert.deepEqual(readLegacyRows.all(),beforeLegacy);
 assert.deepEqual(await installHouseholdFile(legacyOptions),{replayed:false,head:eventHash});
 assert.deepEqual(await installHouseholdFile(legacyOptions),{replayed:true,head:eventHash});
 await assert.rejects(()=>installHouseholdFile({...legacyOptions,bytes:reseal(legacyRelease)}),/CONFLICT/);
 const readSealed=a.storage.readHouseholdSealedFile;
 a.storage.readHouseholdSealedFile=async()=>({ok:true,value:{version:1,digest:legacyDigest,bytes:legacyBytes,signature:legacySignature}});
 try{assert.deepEqual(await sealHouseholdFile({...sealOptions,recipientDevice:b.deviceId}),legacyBytes);}
 finally{a.storage.readHouseholdSealedFile=readSealed;}
 for(const mutate of [value=>{value.selection.signature='0'.repeat(128)},
  value=>{value.publisherParent.authorizationSnapshot='0'.repeat(64)}]){
  const invalid=structuredClone(existingRelease);mutate(invalid);
  await assert.rejects(()=>installHouseholdFile({...existingOptions,bytes:reseal(invalid)}));
 }
 assert.deepEqual(b.rows(),beforeExisting);
 for(const fault of ['projection-set-keys','projection-set-catalog','projection-set-authority']){
  b.faultAt(fault);
  await assert.rejects(()=>installHouseholdFile(existingOptions),/IO/);
  b.reopen();assert.deepEqual(b.rows(),beforeExisting);
 }
 b.faultAt(null);
 assert.deepEqual(await installHouseholdFile(existingOptions),{replayed:false,head:eventHash});
 b.reopen();
 assert.deepEqual(await installHouseholdFile(existingOptions),{replayed:true,head:eventHash});
 await assert.rejects(()=>installHouseholdFile({...existingOptions,bytes:reseal(existingRelease)}),/CONFLICT/);
 const retainedState=JSON.parse(new TextDecoder().decode(must(await b.storage.readPairingAuthority(scope)).authorityState));
 assert.deepEqual(retainedState.selections[0],localSelection);
 assert.equal(retainedState.selections[1].deviceId,b.deviceId);
 assert.ok(must(await b.storage.reopenDocument(scope.id,br.scope.documentId)));

 const receiverRef=sodium.to_hex(newcomerSign.publicKey);
 const receiverKeys={use:(op,identity,fn)=>op==='test-signing'
  ?fn(newcomerSign.privateKey):newcomerCatalog.use(op,identity,fn)};
 const openPeer=async (storage,{resolved,installedSet,sequences:peerSequences=sequences},keys,publicKey,wrapping)=>{
  const runtime=await openWorkspaceHouseholdRuntime({storage,resolved,installedSet,pin:a.root.head,
   provider:a.provider,sodium,keys,signing:{publicKey,operationId:'test-signing'},wrapping,LoroDoc,decodeImportBlobMeta});
  const service=disclosureService({storage,scope,rootPin:a.root.head,provider:a.provider,
   deviceId:runtime.scope.authorDevice,installedSet:{...installedSet,sodium,LoroDoc}});
  const householdContent=bindHouseholdContent({runtime,sequences:peerSequences,disclosure:service,shoppingRecipeCopies:true});
  return {runtime,service,householdContent,files:cookingFiles({runtime,service,recipeCatalogVersion:1})};
 };
 const openSponsor=async()=>openPeer(a.storage,await resolveOriginalHousehold({...sealOptions,deviceId:a.deviceId}),signerKeys,signingRef);
 let newcomerSelection=await joinStore.selection.openSelected();
 let sponsor=await openSponsor();
 await t.test('installed admission permits newcomer ceremony preparation without publication',async()=>{
  const signing=sodium.crypto_sign_keypair(),wrapping=sodium.crypto_box_keypair();
  const signingKey=sodium.to_hex(signing.publicKey),wrappingKey=sodium.to_hex(wrapping.publicKey);
  const verify=a.provider.verify;
  a.provider.verify=async(ref,bytes,signature)=>ref===signingKey
   ?sodium.crypto_sign_verify_detached(signature,bytes,signing.publicKey):verify(ref,bytes,signature);
  const entries=new Map(),store={transaction:async fn=>fn({get:key=>entries.get(key),put:(key,value)=>entries.set(key,structuredClone(value))})};
  try{
   const service=householdPairing({name:'fixture',sodium,storage:a.storage,provider:a.provider,store,scope,pin:a.root.head,
    deviceId:a.deviceId,adultId:'adult',runtime:sponsor.runtime,service:sponsor.service,keys:signerKeys,
    signing:{operationId:'test-signing'},wrapping:{operationId:'test-wrapping'},signingKey:signingRef,
    wrappingPublicKey:sodium.to_hex(sponsorWrap.publicKey),LoroDoc});
   const request={deviceId:'fresh-own-device',signingKey,wrappingKey,nonce:sodium.to_hex(sodium.randombytes_buf(32))};
   const signed={request,signature:sodium.to_hex(sodium.crypto_sign_detached(domain('household-own-device-request',request),signing.privateKey))};
   const fingerprint=pairingDigest(sodium,domain('household-own-device-fingerprint',{deviceId:request.deviceId,signingKey,wrappingKey}));
   const proposal=await service.ownDevice.propose(JSON.stringify(signed),fingerprint);
   assert.equal(proposal.head,eventHash);
   assert.equal((await service.ownDevice.resume('initiator')).code,proposal.code);
   assert.throws(()=>service.ownDevice.publish(proposal.code),/UNSUPPORTED_VERSION/);
   assert.throws(()=>service.ownDevice.install(new Uint8Array()),/UNSUPPORTED_VERSION/);
   const authorization=sponsor.runtime.authorization.bind(sponsor.runtime);
   sponsor.runtime.authorization=async()=>{const value=await authorization();return {...value,expectedAuthority:{...value.expectedAuthority,record:{...value.expectedAuthority.record,acceptedParent:'0'.repeat(64)}}};};
   try{await assert.rejects(()=>service.ownDevice.propose(JSON.stringify(signed),fingerprint),/CONFLICT/);}
   finally{delete sponsor.runtime.authorization;}
  }finally{a.provider.verify=verify;signing.privateKey.fill(0);wrapping.privateKey.fill(0);}
 });
 await t.test('installed admission prepares a public complete-set adult removal',async()=>{
  const entries=new Map(),store={transaction:async fn=>fn({get:key=>entries.get(key),put:(key,value)=>entries.set(key,structuredClone(value))})};
  const service=householdPairing({name:'fixture',sodium,storage:a.storage,provider:a.provider,store,scope,pin:a.root.head,
   deviceId:a.deviceId,adultId:'adult',runtime:sponsor.runtime,service:sponsor.service,keys:signerKeys,
   signing:{operationId:'test-signing'},wrapping:{operationId:'test-wrapping'},signingKey:signingRef,
   wrappingPublicKey:sodium.to_hex(sponsorWrap.publicKey),LoroDoc});
  const body={version:1,scopeId:scope.id,parentHead:eventHash,deviceId:b.deviceId,wrappingKey:sodium.to_hex(existingWrap.publicKey)};
  const binding={...body,signature:sodium.to_hex(await a.provider.sign(a.root.devices.find(d=>d.deviceId===b.deviceId).signingKeyRef,domain('revocation-recipient',body)))};
  const rows=a.rows();
  const draft=await service.adultRemoval.prepare({targetAdultId:'newcomer',bindings:[binding],explicit:true});
  assert.equal(draft.proposal.manifest.version,6);
  assert.deepEqual(draft.proposal.manifest.entries.map(row=>row.recipeId),[null,'racing-child',recipeId,'sibling']);
  assert(!JSON.stringify(draft.proposal).includes('Purple carrot'));
  const approved=await service.adultRemoval.approve({proposal:draft.proposal,confirmed:draft.confirmation,explicit:true});
  assert.equal(approved.complete,true);
  assert.deepEqual(a.rows(),rows);
 });
 let newcomer=await openPeer(freshStorage,newcomerSelection,receiverKeys,receiverRef);
 const recipeRuntime=await sponsor.runtime.forRecipe(recipeId);
 await assert.rejects(()=>sponsor.runtime.forRecipe('outside-signed-catalog'),/INVALID_RECIPE_DOCUMENT/);
 const beforeUnsupported=a.rows(),beforeUnsupportedSequence=sequence;
 const newRecipe='outside-signed-catalog';
 const unsupported=planRecipeAction({doc:(await sponsor.runtime.document()).doc,before:null,
  after:recipe(newRecipe,'Unsupported'),actionId:newRecipe,author:a.deviceId,at});
 await assert.rejects(()=>executeAction(sponsor.runtime,sequences,newRecipe,unsupported,sponsor.service),/UNSUPPORTED_VERSION/);
 await assert.rejects(()=>sponsor.householdContent.createRecipe(newRecipe,recipe(newRecipe,'Unsupported')),/UNSUPPORTED_VERSION/);
 await assert.rejects(()=>newcomer.householdContent.createRecipe(newRecipe,recipe(newRecipe,'Unsupported')),/UNSUPPORTED_VERSION/);
 assert.equal(sequence,beforeUnsupportedSequence);
 assert.deepEqual(a.rows(),beforeUnsupported);
 const originalRecipe=(await sponsor.householdContent.readCooking()).recipes.find(recipe=>recipe.id===recipeId);
 const recipeAction='installed-recipe-edit';
 const recipeDocument=await sponsor.householdContent.readRecipe(recipeId);
 assert.equal(recipeDocument.scope.documentId,recipeRuntime.scope.documentId);
 const recipeCommands=planRecipeAction({doc:recipeDocument.doc,before:originalRecipe,
  after:{...originalRecipe,title:'Edited on the sponsor'},actionId:recipeAction,author:a.deviceId,at});
 await sponsor.householdContent.execute(recipeAction,recipeCommands,recipeId);
 const storedRecipeEdit=must(await a.storage.getLocalOperation(scope.id,recipeAction));
 const recipeObjectId=storedRecipeEdit.commit.outbound[0].object.id;
 const recipeBytes=await sponsor.files.download(recipeObjectId);
 await newcomer.files.receive(recipeBytes);
 assert.deepEqual(must(await freshStorage.readDisclosureSource(scope.id,recipeCommands[0].effectId)).policyHashes,
  [accepted.policyHash]);

 const rootAction='installed-pantry-edit';
 const pantry={version:1,kind:'pantry-create',commandId:rootAction,effectId:rootAction,dependencyEffectIds:[],
  data:{itemId:'shared-after-join',name:'Chickpeas',preference:3,at,author:newcomer.runtime.scope.authorDevice}};
 await newcomer.householdContent.execute(rootAction,[pantry]);
 const pantryObjectId=must(await freshStorage.getLocalOperation(scope.id,rootAction)).commit.outbound[0].object.id;
 const pantryBytes=await newcomer.files.download(pantryObjectId);
 await sponsor.files.receive(pantryBytes);
 assert.equal((await newcomer.files.receive(recipeBytes)).replayed,true);

 newcomerSelection.sequences.close();
 a.reopen();reopenFresh();
 sponsor=await openSponsor();
 newcomerSelection=await joinStore.selection.openSelected();
 newcomer=await openPeer(freshStorage,newcomerSelection,receiverKeys,receiverRef);
 for(const peer of [sponsor,newcomer]){
  const cooking=await peer.householdContent.readCooking();
  assert.equal(cooking.recipes.find(recipe=>recipe.id===recipeId)?.title,'Edited on the sponsor');
  assert.ok(cooking.pantry.some(item=>item.name==='Chickpeas'));
 }

 let admittedShoppingObjects;
 await t.test('admitted shopping claims preserve signed seed ancestry and transact against both documents',async()=>{
  const before=await sponsor.householdContent.readCooking();
  const sourceRecipe=before.recipes.find(row=>row.id===recipeId);
  const ingredient=sourceRecipe.ingredients[0],list=before.shopping.lists.find(row=>!row.removedAt);
  const item={id:'admitted-copy',listId:list.id,recipeId,ingredientId:ingredient.id,name:ingredient.name,
   displayQuantity:ingredient.amount,purchaseCycleId:list.currentCycleId,checked:false,createdAt:at,updatedAt:at};
  const after={...before.shopping,items:[...before.shopping.items,item]};
  const attempt={actionId:'admitted-copy-action',at,commands:null};
  a.faultAt('disclosure-local');
  await assert.rejects(()=>sponsor.householdContent.saveShoppingCopy(attempt,before,after),/IO/);
  a.faultAt(null);
  assert.equal(must(await a.storage.getLocalOperation(scope.id,attempt.actionId)),null);
  assert.deepEqual((await sponsor.householdContent.readCooking()).shopping,before.shopping);
  await sponsor.householdContent.saveShoppingCopy(attempt,before,after);
  const command=attempt.commands.find(c=>c.kind==='shopping-item-create');
  const applied=must(await a.storage.getLocalOperation(scope.id,attempt.actionId));
  const objects=applied.commit.outbound.map(row=>row.object);
  admittedShoppingObjects=objects;
  const [copy]=objects;
  const auth=await sponsor.runtime.authorization();
  const opened=await sponsor.runtime.codec.openContent(copy.bytes,auth.signingKeyRefs);
  assert.equal(opened.header.disclosureIncomplete,true);
  assert.deepEqual(opened.header.disclosurePolicyHashes,[accepted.policyHash]);
  const {buildSelectedOperationReport}=await import('../compromise/selected-report.mjs');
  const {selectedOperationReportService}=await import('../compromise/selected-report-service.mjs');
  const {reconstructSelectedRetention,saveSelectedRetention}=await import('../compromise/selected-reconstruction.mjs');
  const candidates=objects.map(object=>({sourceId:'outbound',documentId:sponsor.runtime.scope.documentId,objectId:object.id,bytes:object.bytes}));
  const report=await buildSelectedOperationReport(sponsor.runtime,{candidates,
   suspectDevice:newcomer.runtime.scope.authorDevice,boundary:{documentId:candidates[0].documentId,objectId:copy.id}});
  const {reportHash}=await selectedOperationReportService(sponsor.runtime).freeze({report:report.report,candidates});
  const beforeDraft=a.rows();
  const draft=await reconstructSelectedRetention(sponsor.runtime,{reportHash,selectedEffectIds:[command.effectId]});
  assert.equal(draft.rows.find(row=>row.effectId===command.effectId).status,'retained');
  const rootDraft=new LoroDoc();rootDraft.import(draft.documents[0].snapshot);
  assert.equal(rootDraft.getMap('shopping-item-fields:admitted-copy').get('displayQuantity'),ingredient.amount);
  assert.ok(draft.documents.find(row=>row.recipeId===recipeId).identities.some(row=>row.incomplete&&row.policyHashes.includes(accepted.policyHash)));
  assert.deepEqual(a.rows(),beforeDraft);
  const {draftId}=await saveSelectedRetention(sponsor.runtime,{reportHash,selectedEffectIds:[command.effectId]});
  const {prepareDraftRotationProjection}=await import('../compromise/project-draft-rotation.mjs');
  const binding={draftId,reportHash,suspectDevice:newcomer.runtime.scope.authorDevice,sourceHead:eventHash,
   documents:draft.documents.map(({recipeId,documentId})=>({recipeId,documentId}))};
  const beforeProjection=a.rows();
  let seedCount=0;
  const projected=await prepareDraftRotationProjection({runtime:sponsor.runtime,binding,
   destination:{parentHead:eventHash,documentId:'admitted-rotation-root',epochId:'admitted-rotation-epoch',generation:3},
   allocateSeed:()=>({seedId:`10000000-0000-4000-8000-${String(++seedCount).padStart(12,'0')}`,peerId:String(150+seedCount)})});
  const projectedRoot=new LoroDoc();projectedRoot.import(projected.documents[0].seed.snapshot);
  assert.equal(projectedRoot.getMap('shopping-item-fields:admitted-copy').get('displayQuantity'),ingredient.amount);
  assert.ok(projected.documents.every(doc=>doc.policyBundle.entries.some(entry=>entry.incomplete&&entry.policyHashes.includes(accepted.policyHash))));
  assert.deepEqual(a.rows(),beforeProjection);
  await assert.rejects(()=>newcomer.files.verify(copy.bytes,copy.id,a.deviceId),/UNSUPPORTED_VERSION/);
  assert.ok(!(await sponsor.files.directBatch(newcomer.runtime.scope.authorDevice,256,new Map()))
   .objects.some(row=>row.objectId===copy.id));

  const localCommit=freshStorage.commitImportWithDisclosurePolicy.bind(freshStorage);
  const rootBefore=(await newcomer.runtime.document()).revision;
  const rejectReceipt=async change=>{
   freshStorage.commitImportWithDisclosurePolicy=(...args)=>{
    change(args[5][0]);
    return localCommit(...args);
   };
   try{await assert.rejects(()=>newcomer.files.receive(copy.bytes),/CONFLICT/);}
   finally{freshStorage.commitImportWithDisclosurePolicy=localCommit;}
   assert.equal((await newcomer.runtime.document()).revision,rootBefore);
   assert.equal(must(await freshStorage.getInboxApplication(scope.id,copy.id)),null);
  };
  await rejectReceipt(receipt=>{receipt.rootRevision++});
  await rejectReceipt(receipt=>{receipt.revision++});
  await rejectReceipt(receipt=>{receipt.recipeId='different-recipe'});
  await rejectReceipt(receipt=>{receipt.effects.find(effect=>effect.seedId).seedId='forged-seed'});

  const rootPrior=(await sponsor.runtime.document()).doc.forkAt(sponsor.runtime.inspectUpdate(
   Uint8Array.from(JSON.parse(new TextDecoder().decode(opened.value)).update)).frontiers);
  const sign=async change=>{
   const forged=structuredClone(command);
   change(forged.data);
   const doc=rootPrior.fork();
   doc.setPeerId(sponsor.runtime.scope.authorPeers[a.deviceId]);
   const from=doc.oplogVersion();
   apply(doc,forged);
   const payload=new TextEncoder().encode(JSON.stringify({version:1,command:forged,
    update:[...doc.export({mode:'update',from})]}));
   return sponsor.runtime.codec.sealContent(opened.header,payload,sponsor.runtime.keyRef,auth.signingKeyRefs[a.deviceId]);
  };
  for(const change of [
   data=>{data.ingredientId='different-ingredient'},
   data=>{data.name='Different ingredient'},
   data=>{data.recipeSource.frontiers[0].counter--},
  ]){
   const forged=await sign(change);
   await assert.rejects(()=>newcomer.files.receive(forged.bytes),/INVALID_RECIPE_SOURCE|POLICY_BASELINE_UNAVAILABLE/);
   assert.equal(must(await freshStorage.getInboxApplication(scope.id,forged.id)),null);
  }
  const raceId='root-copy-race';
  const race={version:1,kind:'pantry-create',commandId:raceId,effectId:raceId,dependencyEffectIds:[],
   data:{itemId:raceId,name:'Race pantry item',preference:3,at,author:newcomer.runtime.scope.authorDevice}};
  freshStorage.commitImportWithDisclosurePolicy=async (...args)=>{
   freshStorage.commitImportWithDisclosurePolicy=localCommit;
   await commitCookingWithPolicy({runtime:newcomer.runtime,service:newcomer.service,input:{
    operationId:raceId,command:race,deviceSequence:++sequence}});
   return localCommit(...args);
  };
  await assert.rejects(()=>newcomer.files.retry(copy.id),/CONFLICT/);
  assert.equal((await newcomer.runtime.document()).revision,rootBefore+1);
  assert.equal(must(await freshStorage.getInboxApplication(scope.id,copy.id)),null);

  const childRuntime=await newcomer.runtime.forRecipe(recipeId);
  const currentRecipe=(await newcomer.householdContent.readCooking()).recipes.find(row=>row.id===recipeId);
  const edited={...currentRecipe,ingredients:currentRecipe.ingredients.map(row=>row.id===ingredient.id
   ? {...row,amount:'5 cups'} : row)};
  freshStorage.commitImportWithDisclosurePolicy=async (...args)=>{
   freshStorage.commitImportWithDisclosurePolicy=localCommit;
   const actionId='child-copy-race';
   const {doc}=await childRuntime.document();
   const commands=planRecipeAction({doc,before:currentRecipe,after:edited,actionId,at,author:childRuntime.scope.authorDevice});
   await newcomer.householdContent.execute(actionId,commands,recipeId);
   return localCommit(...args);
  };
  await assert.rejects(()=>newcomer.files.retry(copy.id),/CONFLICT/);
  assert.equal((await newcomer.runtime.document()).revision,rootBefore+1);
  assert.equal(must(await freshStorage.getInboxApplication(scope.id,copy.id)),null);
  freshFault='import-documents';
  await assert.rejects(()=>newcomer.files.retry(copy.id),/IO/);
  freshFault=null;
  assert.equal((await newcomer.runtime.document()).revision,rootBefore+1);
  assert.equal(must(await freshStorage.getInboxApplication(scope.id,copy.id)),null);
  for(const object of objects)await newcomer.files.receive(object.bytes);
  assert.equal((await newcomer.householdContent.readCooking()).recipes.find(row=>row.id===recipeId)
   .ingredients.find(row=>row.id===ingredient.id).amount,'5 cups');
  const context=await newcomer.service.authority();
  const settings={runtime:newcomer.runtime,service:newcomer.service,context};
  assert.deepEqual((await createSourceVerifier({...settings,allowIncomplete:true})(command.effectId)).policies,[accepted.policyHash]);
  await assert.rejects(()=>createSourceVerifier(settings)(command.effectId),/INCOMPLETE_PROVENANCE/);
  const copied=(await newcomer.householdContent.readCooking()).shopping.items.find(row=>row.id===item.id);
  assert.deepEqual(copied,item);
 });

 // Use the same Add Recipe binding as production with the fixture devices' real
 // ceremony secrets, and durable LocalKeys for every installed data key.
 await t.test('installed recipe creation publishes and imports its independent key atomically',async()=>{
  const enable=(catalog,signer,wrap)=>Object.assign(Object.create(catalog),{
   use:(op,identity,fn)=>op==='test-wrapping'?fn(wrap):op==='test-signing'?fn(signer):catalog.use(op,identity,fn),
  });
  const wrapping={operationId:'test-wrapping'};
  const openCreatingSponsor=async()=>openPeer(a.storage,await resolveOriginalHousehold({...sealOptions,deviceId:a.deviceId}),
   enable(sponsorCatalog,a.signingTestKey.privateKey,sponsorWrap.privateKey),signingRef,wrapping);
  const openCreatingNewcomer=()=>openPeer(freshStorage,newcomerSelection,
   enable(newcomerCatalog,newcomerSign.privateKey,newcomerWrap.privateKey),receiverRef,wrapping);
  sponsor=await openCreatingSponsor();
  newcomer=await openCreatingNewcomer();
  const createId='create-after-v5',added={...recipe('new-member','Carrots'),title:'Created in the installed household'};
  const dec=new TextDecoder();
  const newDocumentId=await recipeDocumentId(sponsor.runtime.scope,a.root.head,a.provider,added.id);
  const beforeCreation=a.rows();
  let precommits=0;
  for(const fault of ['recipe-key','recipe-catalog','disclosure-local']){
   a.faultAt(fault);
   await assert.rejects(()=>sponsor.householdContent.createRecipe(createId,added,()=>precommits++),/IO/);
   a.reopen();
   assert.deepEqual(a.rows(),beforeCreation);
  }
  a.faultAt(null);
  const created=await sponsor.householdContent.createRecipe(createId,added,()=>precommits++);
  assert.equal(precommits,4);
  const afterCreation=a.rows();
  const [creation]=must(await a.storage.getLocalOperation(scope.id,createId)).commit.outbound.map(x=>x.object);
  const bytes=await sponsor.files.download(creation.id);
  assert.equal(sponsor.runtime.scope.documentId===newDocumentId,false);
  assert.equal(JSON.parse(dec.decode(bytes)).header.documentId,newDocumentId);
  assert.equal(dec.decode(bytes).includes(added.id),false);
  assert.ok(new Set([newDocumentId,...sponsorAuthority.members.map(x=>x.documentId)]).size===sponsorAuthority.members.length+1);
  await assert.rejects(()=>sponsor.files.receive(bytes),/INVALID_AUTHORITY/);
  a.reopen();
  sponsor=await openCreatingSponsor();
  assert.deepEqual(await sponsor.householdContent.createRecipe(createId,added,()=>assert.fail('replayed allergy check')),
   {...created,replayed:true});
  await assert.rejects(()=>sponsor.householdContent.createRecipe(createId,{...added,title:'Changed retry'}),/CONFLICT/);
  await assert.rejects(()=>sponsor.householdContent.createRecipe('seed-collision',recipe(recipeId,'Duplicate baseline')),/INVALID_RECIPE_DOCUMENT/);
  await assert.rejects(()=>sponsor.householdContent.createRecipe('child-collision',added),/CONFLICT/);
  assert.deepEqual(a.rows(),afterCreation);

  const {buildSelectedOperationReport}=await import('../compromise/selected-report.mjs');
  const {selectedOperationReportService}=await import('../compromise/selected-report-service.mjs');
  const {resolveSelectedReportStart}=await import('../compromise/selected-report-start.mjs');
  const candidates=[{sourceId:'outbound',documentId:newDocumentId,objectId:creation.id,bytes},
   {sourceId:'outbound',documentId:recipeRuntime.scope.documentId,objectId:recipeObjectId,bytes:recipeBytes}];
  const report=await buildSelectedOperationReport(sponsor.runtime,{candidates,
   suspectDevice:sponsor.runtime.scope.acceptedAuthors.find(id=>id!==a.deviceId),
   boundary:{documentId:newDocumentId,objectId:creation.id}});
  const {reportHash}=await selectedOperationReportService(sponsor.runtime).freeze({report:report.report,candidates});
  const beforeStart=a.rows();
  const start=await resolveSelectedReportStart(sponsor.runtime,reportHash);
  const seededRoot=start.documents.find(row=>row.recipeId===null);
  const seededRecipe=start.documents.find(row=>row.recipeId===recipeId);
  assert.ok(seededRoot.snapshot.length>0);
  assert.ok(seededRecipe.snapshot.length>0);
  assert.ok(seededRecipe.identities.some(row=>row.incomplete&&row.policyHashes.includes(accepted.policyHash)));
  assert.deepEqual(start.documents.find(row=>row.recipeId===added.id),{
   recipeId:added.id,documentId:newDocumentId,snapshot:new Uint8Array(),seedId:null,identities:[],policies:[],
  });
  const {reconstructSelectedRetention}=await import('../compromise/selected-reconstruction.mjs');
  const seedEdit=recipeCommands[0];
  assert.ok(seedEdit.dependencyEffectIds.some(id=>seededRecipe.identities.some(identity=>identity.effectId===id)));
  const draft=await reconstructSelectedRetention(sponsor.runtime,{reportHash,selectedEffectIds:[seedEdit.effectId]});
  assert.equal(draft.rows.find(row=>row.effectId===seedEdit.effectId).status,'retained');
  const rootDraft=draft.documents.find(row=>row.recipeId===null),recipeDraft=draft.documents.find(row=>row.recipeId===recipeId);
  const rebuiltRoot=new LoroDoc(),rebuiltRecipe=new LoroDoc();rebuiltRoot.import(rootDraft.snapshot);rebuiltRecipe.import(recipeDraft.snapshot);
  assert.equal(rebuiltRecipe.getMap('recipe:'+encodeURIComponent(recipeId)).get('title'),'Edited on the sponsor');
  assert.equal(rebuiltRecipe.getMap('recipe-ingredient:'+encodeURIComponent(JSON.stringify([recipeId,ingredientId]))).get('amount'),'4 cups');
  assert.equal(rebuiltRoot.getMap('pantry:seeded-pantry').get('name'),'Seeded beans');
  assert.deepEqual(rebuiltRoot.toJSON(),(()=>{const doc=new LoroDoc();doc.import(seededRoot.snapshot);return doc.toJSON()})());
  assert.deepEqual(recipeDraft.identities,seededRecipe.identities);assert.deepEqual(recipeDraft.policies,seededRecipe.policies);
  assert.ok(recipeDraft.identities.some(row=>row.incomplete&&row.policyHashes.includes(accepted.policyHash)));
  assert.deepEqual(a.rows(),beforeStart);
  const originalPublication=a.storage.getProjectionPublication.bind(a.storage);
  a.storage.getProjectionPublication=async(...args)=>{
   const result=await originalPublication(...args);
   if(result.ok&&result.value?.documentSet){
    const malformed=structuredClone(result.value);
    malformed.documents[1].bytes[0]^=1;
    return {ok:true,value:malformed};
   }
   return result;
  };
  try {await assert.rejects(()=>resolveSelectedReportStart(sponsor.runtime,reportHash));await assert.rejects(()=>reconstructSelectedRetention(sponsor.runtime,{reportHash,selectedEffectIds:[seedEdit.effectId]}));}
  finally {a.storage.getProjectionPublication=originalPublication;}
  assert.deepEqual(a.rows(),beforeStart);

  const document=await sponsor.householdContent.readRecipe(added.id);
  const edited={...added,title:'Edited after installed creation'};
  const editId='edit-after-v5';
  const newMemberEdits=planRecipeAction({doc:document.doc,before:added,after:edited,actionId:editId,author:a.deviceId,at});
  await sponsor.householdContent.execute(editId,newMemberEdits,added.id);
  const [editBytes]=must(await a.storage.getLocalOperation(scope.id,editId)).commit.outbound.map(x=>x.object.bytes);
  // An installed admission contains signed seed members as well as recipes
  // created later under the selected head. Both must be captured after reopen.
  const previousVerify=a.provider.verify;
  a.provider.verify=(ref,data,signature)=>ref===sodium.to_hex(newcomerSign.publicKey)
   ?sodium.crypto_sign_verify_detached(signature,data,newcomerSign.publicKey):previousVerify(ref,data,signature);
  const nextRecipient=sodium.crypto_sign_keypair(),nextWrap=sodium.crypto_box_keypair();
  t.after(()=>{nextRecipient.privateKey.fill(0);nextWrap.privateKey.fill(0);});
  const nextEvent={...event,parentHead:eventHash,generation:2,epochId:event.subject.newEpochId,
   proposalId:'next-set-invite',frozenAdultRoster:['adult','newcomer'],subject:{adultId:'third',devices:[{
    deviceId:'third-device',peerId:'4',signingKeyRef:sodium.to_hex(nextRecipient.publicKey),
    wrappingKeyRef:sodium.to_hex(nextWrap.publicKey)}],documentId:'next-cooking',newGeneration:3,newEpochId:'next-epoch'}};
  const nextHash=await selectedSourceHash(a.provider,'event',nextEvent);
  const nextApprovalBase={version:1,householdId:scope.id,eventHash:nextHash,parentHead:eventHash,
   policyHash:a.root.policyHash,generation:2,epochId:event.subject.newEpochId};
  const nextSigners=[{adultId:'adult',deviceId:a.deviceId},{adultId:'newcomer',deviceId:newcomerContext.recipientDeviceId}];
  const nextItem={event:nextEvent,authorSignature:await signAdmission('event-signature',nextEvent),
   approvals:nextSigners.map((signer,index)=>{const approval={...nextApprovalBase,...signer};return {...approval,
    signature:sodium.to_hex(sodium.crypto_sign_detached(domain('approval-signature',approval),
     index?newcomerSign.privateKey:a.signingTestKey.privateKey))};})};
  const observedInstalled=await observeSelectedSourceSet(sponsor.runtime);
  assert.equal(observedInstalled.signed.manifest.version,2);
  assert.ok(observedInstalled.signed.manifest.children.some(child=>child.recipeId===recipeId&&child.creationEffectId===null));
  assert.ok(observedInstalled.signed.manifest.children.some(child=>child.recipeId===added.id&&child.creationEffectId!==null));
  // Exercise the production reader against admitted and later-created keys.
  const policyCapture=await observePolicyDocumentSet(sponsor.runtime);
  const policyRetained=policyCapture.sources.map(source=>({documentId:source.runtime.scope.documentId,revision:source.revision,bytes:source.bytes??new Uint8Array()}));
  const policyOptions={storage:a.storage,scope,pin:a.root.head,provider:a.provider,LoroDoc,signed:policyCapture.signed,retained:policyRetained};
  const policySubject=await policyDocumentSetSubject(policyOptions);
  const policyParent=(await verifyPolicyDocumentSet(policyOptions)).selected;
  const policyEvent={version:6,kind:'changePolicy',authorDeviceId:a.deviceId,householdId:scope.id,
   parentHead:policyParent.head,epochId:policyParent.epochId,generation:policyParent.generation,subject:policySubject,
   suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',policyHash:policyParent.policyHash,
   proposalId:'installed-policy-stage',frozenAdultRoster:policyParent.roster,nextPolicy:policyParent.policy};
  const policyHash=sodium.to_hex(await a.provider.hash(domain('event',policyEvent)));
  const policyApprovals=nextSigners.map((signer,index)=>{const approval={version:1,householdId:scope.id,eventHash:policyHash,
   parentHead:policyParent.head,policyHash:policyParent.policyHash,generation:policyParent.generation,epochId:policyParent.epochId,...signer};
   return {...approval,signature:sodium.to_hex(sodium.crypto_sign_detached(domain('approval-signature',approval),index?newcomerSign.privateKey:a.signingTestKey.privateKey))};});
  await stageVerifiedPolicyDocumentSet({runtime:sponsor.runtime,item:{event:policyEvent,
   authorSignature:await signAdmission('event-signature',policyEvent),approvals:policyApprovals},signed:policyCapture.signed});
  const beforePreparation=a.rows();
  const prepared=await prepareWorkspacePolicyDocumentKeys(sponsor.runtime,policyHash,sponsorCatalog);
  assert.equal(prepared.length,policyCapture.sources.length);
  for(const [index,entry] of prepared.entries()) {
   const identity=entry.record.identity;
   const aad=new TextEncoder().encode(JSON.stringify(['creative-cooking/local-key/v1',identity.scope.kind,identity.scope.id,identity.deviceId,identity.purpose,identity.epochId]));
   const actual=await sponsorMaster.unwrap(entry.record.masterId,entry.record.wrapped,aad);
   const source=policyCapture.sources[index].runtime;
   if(sponsorAuthority.members.some(member=>member.documentId===source.scope.documentId))
    await sponsorContent(source.scope.epochId,key=>assert.deepEqual(actual,key),source.scope);
   else {
    const epochId=await selectedSourceHash(a.provider,'installed-recipe-key-slot-v1',{pin:a.root.head,scopeId:scope.id,
     head:source.scope.branchHead,epochId:source.scope.epochId,generation:source.scope.documentGeneration,documentId:source.scope.documentId});
    const operationId=await selectedSourceHash(a.provider,'installed-recipe-key-operation-v1',{epochId,deviceId:a.deviceId});
    await sponsorCatalog.use(operationId,{version:1,scope,deviceId:a.deviceId,purpose:'data',epochId},key=>assert.deepEqual(actual,key));
   }
   actual.fill(0);
  }
  await assert.rejects(()=>prepareWorkspacePolicyDocumentKeys(sponsor.runtime,'0'.repeat(64),sponsorCatalog));
  const dynamicSource=policyCapture.sources.find(source=>source.runtime.recipeId===added.id).runtime.scope;
  const missingEpoch=await selectedSourceHash(a.provider,'installed-recipe-key-slot-v1',{pin:a.root.head,scopeId:scope.id,
   head:dynamicSource.branchHead,epochId:dynamicSource.epochId,generation:dynamicSource.documentGeneration,documentId:dynamicSource.documentId});
  const missingOperation=await selectedSourceHash(a.provider,'installed-recipe-key-operation-v1',{epochId:missingEpoch,deviceId:a.deviceId});
  const savedUse=sponsorCatalog.use;
  sponsorCatalog.use=function(op,...args){if(op===missingOperation)throw Error('NOT_FOUND');return savedUse.call(this,op,...args);};
  try{await assert.rejects(()=>prepareWorkspacePolicyDocumentKeys(sponsor.runtime,policyHash,sponsorCatalog),/RECIPE_CREATION_REQUIRED/);}
  finally{sponsorCatalog.use=savedUse;}

  const originalPolicyScope=structuredClone(sponsor.runtime.scope);
  for(const change of [{scopeId:'wrong'},{documentId:'wrong'},{branchHead:'wrong'}]) {
   Object.assign(sponsor.runtime.scope,change);
   await assert.rejects(()=>prepareWorkspacePolicyDocumentKeys(sponsor.runtime,policyHash,sponsorCatalog));
   sponsor.runtime.scope=structuredClone(originalPolicyScope);
  }
  assert.deepEqual(a.rows(),beforePreparation);
  { // Policy activation carries only verified admission seeds.
   const db=new DatabaseSync(':memory:');
   const connection={executeSync(sql,params=[]){const stmt=db.prepare(sql);return {rows:sql.trimStart().toUpperCase().startsWith('SELECT')?stmt.all(...params):(stmt.run(...params),[])};}};
   const storage=openSQLiteStorage(connection);
   try{
    for(const row of a.connection.executeSync('SELECT key,value FROM loro_records').rows)
     connection.executeSync('INSERT INTO loro_records(key,value) VALUES (?,?)',[row.key,row.value]);
    const sourceRows=a.rows();
    const expected=must(await storage.readPairingAuthority(scope)), state=JSON.parse(new TextDecoder().decode(expected.authorityState));
    const selection={from:policyParent.head,to:policyHash,deviceId:a.deviceId,index:state.selections.length};
    selection.signature=await signAdmission('select-head',{root:a.root.head,householdId:scope.id,...selection});
    const item={event:policyEvent,authorSignature:await signAdmission('event-signature',policyEvent),approvals:policyApprovals};
    const nextState={...state,events:[...state.events,item],selections:[...state.selections,selection],activeHead:policyHash};
    const next={...expected,revision:expected.revision+1,acceptedParent:policyHash,authorizationSnapshot:await snapshotId(a.provider,nextState),authorityState:authorityBytes(nextState)};
    const stage=must(await storage.readStagedPolicyDocumentSet(scope.id,policyHash));
    must(await storage.commitPolicyDocumentSetSelection({guard:policyCapture.guard,targetHead:policyHash,proof:stage.proof,mapping:stage.mapping,expected,next,deviceId:a.deviceId,prepared}));
    const keys=storage.localKeys(sponsorMaster,sodium);
    const {resolveActivatedPolicyAuthority}=await import('../authority/chain.mjs');
    const resolved=await resolveActivatedPolicyAuthority({storage,scope,pin:a.root.head,provider:a.provider,authorDevice:a.deviceId,LoroDoc,targetHead:policyHash,keys});
    const runtime=new OfflineRuntime({storage,codec:sponsor.runtime.codec,LoroDoc,decodeImportBlobMeta,scope:resolved.scope,keyRef:'data',authority:{rootPin:a.root.head,provider:a.provider,activatedPolicy:{targetHead:policyHash,keys,resolved}}});
    assert.ok(resolved.members.find(x=>x.recipeId===null).policySeed);
    assert.ok(resolved.members.find(x=>x.recipeId===recipeId).policySeed);
    assert.equal(resolved.members.find(x=>x.recipeId===added.id).policySeed,null);
    for(const mutate of [publication=>{publication.documents[0].bytes[0]^=1},
      publication=>{publication.documentSet.seeds[0].seed.identities=[]},
      publication=>{publication.localKey.record.identity.deviceId='wrong'}]){
     const view=Object.create(storage), get=storage.getProjectionPublication.bind(storage);
     view.getProjectionPublication=async(...args)=>{const result=await get(...args);if(result.ok&&result.value){result.value=structuredClone(result.value);mutate(result.value)}return result};
     await assert.rejects(()=>resolveActivatedPolicyAuthority({storage:view,scope,pin:a.root.head,provider:a.provider,authorDevice:a.deviceId,LoroDoc,targetHead:policyHash,keys}));
    }
    await runtime.document();
    await (await runtime.forRecipe(recipeId)).document();
    await (await runtime.forRecipe(added.id)).document();
    const rootMember=resolved.members.find(x=>x.recipeId===null), childMember=resolved.members.find(x=>x.recipeId===recipeId);
    const rootStored=must(await storage.reopenBranchDocument(resolved.expectedAuthority,rootMember.documentId));
    const checkTarget=async bytes=>{
     const view=Object.create(storage), reopen=storage.reopenBranchDocument.bind(storage);
     view.reopenBranchDocument=async(authority,id)=>id===rootMember.documentId?{ok:true,value:{...rootStored,bytes}}:reopen(authority,id);
     const probe=new OfflineRuntime({storage:view,codec:sponsor.runtime.codec,LoroDoc,decodeImportBlobMeta,scope:resolved.scope,keyRef:'data',authority:{rootPin:a.root.head,provider:a.provider,activatedPolicy:{targetHead:policyHash,keys,resolved}}});
     await assert.rejects(()=>probe.document(),/INVALID_ACTIVATED_HISTORY/);
    };
    await checkTarget(childMember.policySeed.snapshot);
    const changed=new LoroDoc();changed.import(rootStored.bytes);changed.setPeerId('999998');
    const marker=Object.keys(changed.getMap('domain-effects').toJSON()).find(id=>changed.getMap('domain-effects').get(id)?.version===3);
    assert.ok(marker);
    changed.getMap('domain-effects').delete(marker);
    await checkTarget(changed.export({mode:'snapshot'}));
    const transaction=openSQLiteTransaction(connection), target=resolved.members.find(x=>x.recipeId===added.id).documentId;
    const slot=JSON.stringify(['document',scope.id,target]);
    const saved=await transaction(false,tx=>tx.get(slot));
    const forged=new LoroDoc();forged.import(saved.bytes);forged.setPeerId('999999');
    forged.getMap('domain-effects').set('forged',{version:3,seedId:'forged',effectId:'forged',commandId:'forged'});
    await transaction(true,tx=>tx.put(slot,{revision:saved.revision+1,bytes:forged.export({mode:'snapshot'})}));
    await assert.rejects(async()=>{await (await runtime.forRecipe(added.id)).document()},/INVALID_ACTIVATED_HISTORY/);
    assert.deepEqual(a.rows(),sourceRows);
   }finally{db.close()}
  }
  const copyOptions={runtime:sponsor.runtime,service:sponsor.service,sodium,peerId:'31337',seedId:'copy-set-test'};
  const capturedCopy=await captureOwnDeviceCopySet(copyOptions);
  const forgottenHistory=observedInstalled.guard.members[0];
  const forgottenDoc=new LoroDoc();forgottenDoc.import(forgottenHistory.bytes);
  forgottenDoc.setPeerId('31338');
  const visibleBefore=forgottenDoc.toJSON();
  forgottenDoc.getMap('recipe-index').set('ephemeral-proof-control','Unsigned hidden value');
  forgottenDoc.commit();
  forgottenDoc.getMap('recipe-index').delete('ephemeral-proof-control');
  forgottenDoc.commit();
  assert.deepEqual(forgottenDoc.toJSON(),visibleBefore);
  const historyStore=openSQLiteTransaction(a.connection);
  const historySlot=JSON.stringify(['document',scope.id,forgottenHistory.documentId]);
  const savedHistory=await historyStore(false,tx=>tx.get(historySlot));
  await historyStore(true,tx=>tx.put(historySlot,{revision:savedHistory.revision+1,bytes:forgottenDoc.export({mode:'snapshot'})}));
  try{
   await observeSelectedSourceSet(sponsor.runtime);
   await assert.rejects(captureOwnDeviceCopySet(copyOptions),/INSUFFICIENT_EVIDENCE/);
  }
  finally{await historyStore(true,tx=>tx.put(historySlot,savedHistory))}
  const verifyCopy=set=>verifyOwnDeviceCopySet({storage:a.storage,scope,pin:a.root.head,provider:a.provider,
   sodium,LoroDoc,set,copyHash:capturedCopy.copyHash,authorDevice:a.deviceId,peerId:copyOptions.peerId});
  const checkedCopy=await verifyCopy(capturedCopy.set);
  const parentRecord=must(await a.storage.readPairingAuthority(scope));
  const parentChain=JSON.parse(dec.decode(parentRecord.authorityState));
  const parent=(await verifyAuthority(parentChain,a.root.head,a.provider)).nodes.get(parentRecord.acceptedParent);
  const peer=completedPair({recipientDeviceId:'own-device-set-recipient'},'pairOwnDevice',
   nextRecipient.publicKey,nextWrap.publicKey,newcomerSession,
   {signingSecret:nextRecipient.privateKey,wrappingSecret:nextWrap.privateKey},
   ()=>ownDeviceSignal(a.root.head,parent,'adult',copyOptions.peerId,parentRecord.revision),
   parentRecord,'own-device-set-copy');
  const eventV5={version:5,suiteId:SUITE,householdId:scope.id,parentHead:parent.head,
   policyHash:parent.policyHash,generation:parent.generation,epochId:parent.epochId,
   proposalId:peer.transcript.sessionId,kind:'pairOwnDevice',authorDeviceId:a.deviceId,
   frozenAdultRoster:parent.roster,nextPolicy:null,subject:{
    adultId:'adult',deviceId:peer.transcript.responder.deviceId,signingKeyRef:sodium.to_hex(nextRecipient.publicKey),
    wrappingKeyRef:sodium.to_hex(nextWrap.publicKey),peerId:copyOptions.peerId,documentId:'paired-own-device-set-copy',
    parentSnapshot:parentRecord.authorizationSnapshot,parentRevision:parentRecord.revision,transcriptHash:peer.oob.hash,
    baseline:checkedCopy[0].baseline,copyHash:capturedCopy.copyHash}};
  async function signedCopyTransition(event){
   const head=await selectedSourceHash(a.provider,'event',event);
   const item={event,approvals:[],authorSignature:await signAdmission('event-signature',event),
    ownDevice:encodeEvidence({transcript:peer.transcript,guard:peer.guard,messages:peer.messages})};
   const selection={from:parent.head,to:head,deviceId:a.deviceId,index:parentChain.selections.length};
   selection.signature=await signAdmission('select-head',{root:a.root.head,householdId:scope.id,...selection});
   const state={...parentChain,events:[...parentChain.events,item],selections:[...parentChain.selections,selection],activeHead:head};
   return {state,next:{scope,revision:parentRecord.revision+1,acceptedParent:head,
    authorizationSnapshot:await snapshotId(a.provider,state),authorityState:authorityBytes(state)}};
  }
  const copyTransition=await signedCopyTransition(eventV5);
  const copyArgs={storage:a.storage,parentRecord,pin:a.root.head,provider:a.provider,sodium,LoroDoc,
   set:capturedCopy.set,proposal:{hash:peer.oob.hash,guard:peer.guard}};
  const signedCopy=await verifyOwnDeviceSetSuccessor({...copyArgs,next:copyTransition.next});
  assert.equal(signedCopy.documents[0].targetDocumentId,eventV5.subject.documentId);
  const targetScope={scopeId:scope.id,branchHead:signedCopy.head,documentId:eventV5.subject.documentId,
   documentGeneration:parent.generation,epochId:parent.epochId};
  for(const document of signedCopy.documents.slice(1)){
   assert.equal(document.targetDocumentId,await recipeDocumentId(targetScope,a.root.head,a.provider,document.recipeId));
   assert.notEqual(document.targetDocumentId,document.documentId);
  }
  const verifiedParent=(await verifyOwnDeviceSuccessor({sodium,provider:a.provider,pin:a.root.head,parentRecord,next:copyTransition.next,eventVersion:5})).parent;
  const establishedIds=verifiedParent.runtime.acceptedRecipients.filter(id=>id!==a.deviceId).sort();
  assert.deepEqual(establishedIds,[b.deviceId,newcomerContext.recipientDeviceId].sort());
  const establishedMaterials=new Map([
   [b.deviceId,{sign:b.signingTestKey.publicKey,wrap:existingWrap.publicKey,secret:existingWrap.privateKey,keys:existingKeys,session:existingSession}],
   [newcomerContext.recipientDeviceId,{sign:newcomerSign.publicKey,wrap:newcomerWrap.publicKey,secret:newcomerWrap.privateKey,keys:newcomerKeys,session:newcomerSession}],
  ]);
  const establishedEvidence=establishedIds.map((recipientDeviceId,index)=>{
   const material=establishedMaterials.get(recipientDeviceId);
   const context={version:1,householdId:scope.id,parentHead:verifiedParent.head,admissionEventHash:signedCopy.head,
    newEpochId:eventV5.epochId,sponsorDeviceId:a.deviceId,recipientDeviceId,recipientWrappingKey:sodium.to_hex(material.wrap)};
   return completedPair(context,'pairOwnDevice',material.sign,material.wrap,material.session,material.keys,
    c=>[existingRecipientContextBytes(c),ownDeviceRecipientSignal(signedCopy.head,eventV5.subject.copyHash,eventV5.epochId)],
    parentRecord,`own-device-established-${index}`);
  });
  const establishedRecipients=await verifyOwnDeviceRecipients({sodium,provider:a.provider,successor:signedCopy,parent:verifiedParent,
   authorizationSnapshot:parentRecord.authorizationSnapshot,evidence:establishedEvidence});
  const evidence={...peer,hash:peer.oob.hash};
  const fileOptions={storage:a.storage,parentRecord,pin:a.root.head,provider:a.provider,sodium,LoroDoc,evidence};
  assert.ok(signedCopy.documents.length>=3);
  const testKeys=new Map(signedCopy.documents.map((document,index)=>[document.documentId,new Uint8Array(32).fill(index+1)]));
  const requested=[];
  const probeFile=await sealOwnDeviceSetFile({...fileOptions,next:copyTransition.next,set:capturedCopy.set,
   signingSecret:sponsorKeys.signingSecret,useSourceKey:({documentId},use)=>{
    requested.push(documentId);
    return use(testKeys.get(documentId));
   }});
  assert.deepEqual(requested,signedCopy.documents.map(document=>document.documentId));
  // A failure after key installation and the first document write rolls back every row.
  const preparedDocuments=[];
  for(const [index,document] of signedCopy.documents.entries()){
   const identity={version:1,scope,deviceId:a.deviceId,purpose:'data',epochId:`own-device-set-test-${index}`};
   const localKey=await sponsorCatalog.preparePairedDataKey(`own-device-set-key-${index}`,identity,testKeys.get(document.documentId));
   preparedDocuments.push({recipeId:document.recipeId,sourceDocumentId:document.documentId,
    documentId:document.targetDocumentId,bytes:document.copy.snapshot,identities:document.identities,
    sources:document.copy.sources,localKey});
  }
  const publication={operationId:'own-device-set-transaction',guardId:'own-device-set-guard',expected:parentRecord,
   next:copyTransition.next,guard:capturedCopy.guard,copyHash:capturedCopy.copyHash,file:probeFile,documents:preparedDocuments};
  const entries=['established-a','established-b'].map((recipientDeviceId,index)=>({recipientDeviceId,
   ceremonyGuardId:`ceremony-${index}`,transcriptHash:'a'.repeat(64),ciphertextHash:'b'.repeat(64),
   ciphertext:new Uint8Array(113).fill(index+1)}));
  const retainedPublication={...publication,sponsor:{deviceId:a.deviceId,set:{},
   keyHashes:preparedDocuments.map(()=>'c'.repeat(64)),signature:'d'.repeat(128),
   establishedRecipients:{version:1,entries}}};
  // Established storage writes require the captured local set as a transaction guard.
  const establishedPublication={...publication,recipient:{deviceId:a.deviceId,fileHash:'a'.repeat(64),
   signature:'b'.repeat(128),kind:'established',transcriptHash:'c'.repeat(64)}};
  const missingGuard={...establishedPublication}; delete missingGuard.guard;
  assert.equal((await a.storage.commitHouseholdOwnDeviceSet(missingGuard)).error.code,'MALFORMED');
  const staleEstablished=structuredClone(establishedPublication);
  staleEstablished.guard.root.revision++;
  const beforeEstablished=a.rows();
  assert.equal((await a.storage.commitHouseholdOwnDeviceSet(staleEstablished)).ok,false);
  assert.deepEqual(a.rows(),beforeEstablished);
  a.faultAt('household-own-device-set');
  assert.equal((await a.storage.commitHouseholdOwnDeviceSet(establishedPublication)).error.code,'IO');
  a.faultAt(undefined);
  assert.deepEqual(a.rows(),beforeEstablished);
  const beforeSetWrite=a.rows();
  const duplicate=structuredClone(retainedPublication);
  duplicate.sponsor.establishedRecipients.entries[1].recipientDeviceId=entries[0].recipientDeviceId;
  assert.equal((await a.storage.commitHouseholdOwnDeviceSet(duplicate)).error.code,'MALFORMED');
  const oversized=structuredClone(retainedPublication);
  oversized.sponsor.establishedRecipients.entries=Array.from({length:3},(_,index)=>({
   ...entries[0],recipientDeviceId:`device-${index}`,ciphertext:new Uint8Array(6*1024*1024)}));
  assert.equal((await a.storage.commitHouseholdOwnDeviceSet(oversized)).error.code,'MALFORMED');
  a.faultAt('household-own-device-set');
  assert.equal((await a.storage.commitHouseholdOwnDeviceSet(retainedPublication)).error.code,'IO');
  a.faultAt(undefined);
  assert.deepEqual(a.rows(),beforeSetWrite);
  const openedKeys=[];
  const openPairingFile=(file,wrappingSecret=nextWrap.privateKey)=>withOpenedOwnDeviceSetFile({
   ...fileOptions,file,wrappingSecret,withKeys:({next,keys,fileHash})=>{
    assert.deepEqual(next,copyTransition.next);
    assert.equal(fileHash,pairingDigest(sodium,probeFile));
    assert.deepEqual(keys,signedCopy.documents.map(document=>({
     documentId:document.targetDocumentId,key:testKeys.get(document.documentId)
    })));
    openedKeys.push(...keys.map(({key})=>key));
   }
  });
  await openPairingFile(probeFile);
  assert.equal(openedKeys.length,signedCopy.documents.length);
  assert.ok(openedKeys.every(key=>key.every(byte=>byte===0)));
  const fileDomain='household-own-device-set-file';
  const openedFile=openDeviceCopy(sodium,fileDomain,probeFile,evidence.hash,evidence.transcript,nextWrap.privateKey);
  const [rootPacket,firstRecipePacket,secondRecipePacket,...remainingPackets]=openedFile.packets;
  for(const [packets,error] of [
   [[rootPacket,firstRecipePacket,...remainingPackets],/INVALID_KEY_PACKAGE/],
   [[rootPacket,secondRecipePacket,firstRecipePacket,...remainingPackets],/INVALID_PROOF/],
  ]){
   const changed=sealDeviceCopy(sodium,fileDomain,evidence.hash,evidence.transcript.responder,sponsorKeys.signingSecret,
    {...openedFile,packets});
   await assert.rejects(openPairingFile(changed),error);
  }
  await assert.rejects(openPairingFile(probeFile,existingWrap.privateKey),/INVALID_KEY/);
  assert.equal(openedKeys.length,signedCopy.documents.length);
  const pairedDir=mkdtempSync(join(tmpdir(),'own-device-set-recipient-'));
  // Clone the current fixture rows into an isolated disk database for sponsor publication.
  let publishDb=new DatabaseSync(join(pairedDir,'sponsor.sqlite'));
  const publishStorage=openSQLiteStorage({executeSync(sql,params=[]){
   const statement=publishDb.prepare(sql);
   return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])};
  }});
  t.after(()=>publishDb.close());
  const beforePublish=a.rows();
  const put=publishDb.prepare('INSERT INTO loro_records (key,value) VALUES (?,?)');
  for(const row of beforePublish)put.run(row.key,row.value);
  assert.equal((await publishStorage.commitHouseholdOwnDeviceSet(establishedPublication)).ok,true);
  const establishedReceipt=must(await publishStorage.readHouseholdOwnDeviceSetReceipt(scope,publication.operationId));
  assert.deepEqual(establishedReceipt.recipient,establishedPublication.recipient);
  publishDb.prepare('DELETE FROM loro_records').run();
  for(const row of beforePublish)put.run(row.key,row.value);
  assert.equal((await publishStorage.commitHouseholdOwnDeviceSet(retainedPublication)).ok,true);
  const retained=must(await publishStorage.readHouseholdOwnDeviceSetRetained(scope,publication.operationId));
  assert.deepEqual(retained.sponsor.establishedRecipients,{version:1,entries});
  // Restore the cloned fixture for the separate legacy publisher scenario.
  publishDb.prepare('DELETE FROM loro_records').run();
  for(const row of beforePublish)put.run(row.key,row.value);
  const noEvidenceRows=publishDb.prepare('SELECT key,value FROM loro_records ORDER BY key').all();
  await assert.rejects(()=>publishOwnDeviceSet({...fileOptions,storage:publishStorage,next:copyTransition.next,captured:capturedCopy,
   signingSecret:sponsorKeys.signingSecret,keys:publishStorage.localKeys(sponsorMaster,sodium),deviceId:a.deviceId}),/INVALID_PROOF/);
  assert.deepEqual(publishDb.prepare('SELECT key,value FROM loro_records ORDER BY key').all(),noEvidenceRows);
  const published=await publishOwnDeviceSet({...fileOptions,storage:publishStorage,next:copyTransition.next,captured:capturedCopy,establishedEvidence,
   signingSecret:sponsorKeys.signingSecret,keys:publishStorage.localKeys(sponsorMaster,sodium),deviceId:a.deviceId});
  assert.equal(published.head,signedCopy.head);
  // Installer proof with a deliberately matching publisher snapshot. This is not
  // a claim that independent same-head authorization snapshots are identical.
  const proofDb=new DatabaseSync(join(pairedDir,'established-proof.sqlite'));
  t.after(()=>proofDb.close());
  const proofConnection={executeSync(sql,params=[]){const statement=proofDb.prepare(sql);
   return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])};}};
  const proofStorage=openSQLiteStorage(proofConnection);
  const proofPut=proofDb.prepare('INSERT INTO loro_records (key,value) VALUES (?,?)');
  const resetProof=()=>{proofDb.prepare('DELETE FROM loro_records').run();for(const row of beforePublish)proofPut.run(row.key,row.value);};
  const proofRows=()=>proofDb.prepare('SELECT key,value FROM loro_records ORDER BY key').all();
  resetProof();
  const proofKeys=proofStorage.localKeys(sponsorMaster,sodium);
  const openProofRuntime=async()=>openPeer(proofStorage,await resolveOriginalHousehold({...sealOptions,storage:proofStorage,deviceId:a.deviceId}),
   enable(proofKeys,a.signingTestKey.privateKey,sponsorWrap.privateKey),signingRef,wrapping);
  let proofPeer=await openProofRuntime();
  const establishedIndex=establishedRecipients.findIndex(row=>row.deviceId===b.deviceId);
  const establishedFile=published.establishedRecipients[establishedIndex].ciphertext;
  const establishedProof=establishedEvidence[establishedIndex];
  const localParent=must(await b.storage.readPairingAuthority(scope));
  assert.equal(localParent.acceptedParent,parentRecord.acceptedParent);
  assert.notEqual(localParent.authorizationSnapshot,parentRecord.authorizationSnapshot);
  const localBefore=JSON.parse(dec.decode(localParent.authorityState));
  const {preflightOwnDeviceLocalTransition,verifyOwnDeviceLocalTransition}=await import('../pairing/household-own-device-local-transition.mjs');
  const preflightArgs={sodium,provider:a.provider,pin:a.root.head,localParent,publisherParent:parentRecord,
   publisherNext:copyTransition.next,deviceId:b.deviceId};
  const preflight=await preflightOwnDeviceLocalTransition(preflightArgs);
  assert.equal(preflight.head,signedCopy.head);
  assert.deepEqual(preflight.event,signedCopy.item.event);
  assert.ok(preflight.parent.runtime.acceptedRecipients.includes(b.deviceId));
  await assert.rejects(preflightOwnDeviceLocalTransition({...preflightArgs,deviceId:'unknown-device'}),/INVALID_AUTHORITY/);
  const tamperedParent=structuredClone(localParent);tamperedParent.authorizationSnapshot='changed';
  await assert.rejects(preflightOwnDeviceLocalTransition({...preflightArgs,localParent:tamperedParent}),/INVALID_AUTHORITY/);
  await assert.rejects(verifyOwnDeviceLocalTransition(preflightArgs),/INVALID_KEY/);
  let localNext;
  await withOpenedEstablishedOwnDeviceTransition({storage:a.storage,provider:a.provider,sodium,LoroDoc,pin:a.root.head,
   parentRecord:localParent,evidence:establishedProof,file:establishedFile,wrappingSecret:existingWrap.privateKey,
   signingSecret:b.signingTestKey.privateKey,withKeys:result=>{localNext=result.localNext;}});
  const localAfter=JSON.parse(dec.decode(localNext.authorityState));
  assert.deepEqual(localAfter.selections.slice(0,-1),localBefore.selections);
  assert.equal(localAfter.selections.at(-1).index,localBefore.selections.length);
  assert.equal(localAfter.selections.at(-1).deviceId,b.deviceId);
  const replaySelection=localAfter.selections.at(-1);
  await withOpenedEstablishedOwnDeviceTransition({storage:a.storage,provider:a.provider,sodium,LoroDoc,pin:a.root.head,
   parentRecord:localParent,evidence:establishedProof,file:establishedFile,wrappingSecret:existingWrap.privateKey,
   localSelection:replaySelection,withKeys:result=>assert.deepEqual(result.localNext,localNext)});
  const badSelection=structuredClone(replaySelection);badSelection.index++;
  await assert.rejects(withOpenedEstablishedOwnDeviceTransition({storage:a.storage,provider:a.provider,sodium,LoroDoc,pin:a.root.head,
   parentRecord:localParent,evidence:establishedProof,file:establishedFile,wrappingSecret:existingWrap.privateKey,
   localSelection:badSelection,withKeys:()=>assert.fail('unexpected callback')}));
  const badLocal=structuredClone(localParent);badLocal.acceptedParent='changed';
  await assert.rejects(withOpenedEstablishedOwnDeviceTransition({storage:a.storage,provider:a.provider,sodium,LoroDoc,pin:a.root.head,
   parentRecord:badLocal,evidence:establishedProof,file:establishedFile,wrappingSecret:existingWrap.privateKey,
   signingSecret:b.signingTestKey.privateKey,withKeys:()=>assert.fail('unexpected callback')}));
  let preparedCount=0;
  const guardedKeys={preparePairedDataKey:(...args)=>{preparedCount++;return proofKeys.preparePairedDataKey(...args)}};
  let proofKeyHashes=[];
  const installProof=()=>withOpenedEstablishedOwnDeviceTransition({storage:proofStorage,provider:a.provider,sodium,LoroDoc,pin:a.root.head,
   parentRecord,evidence:establishedProof,file:establishedFile,wrappingSecret:existingWrap.privateKey,
   withKeys:({checked,next,keys:opened})=>{proofKeyHashes=opened.map(({key})=>pairingDigest(sodium,key));return commitVerifiedEstablishedOwnDeviceSet({storage:proofStorage,runtime:proofPeer.runtime,
    provider:a.provider,sodium,pin:a.root.head,parentRecord,evidence:establishedProof,file:establishedFile,
    signer:b.signingTestKey.privateKey,keys:guardedKeys,deviceId:b.deviceId,checked,next,opened});}});
  const localRecipe=await proofPeer.householdContent.readRecipe(added.id);
  const divergent={...edited,title:'Recipient local edit survives'};
  const divergentCommands=planRecipeAction({doc:localRecipe.doc,before:edited,after:divergent,
   actionId:'established-local-divergence',author:a.deviceId,at});
  await proofPeer.householdContent.execute('established-local-divergence',divergentCommands,added.id);
  const divergentRows=proofRows();
  await assert.rejects(installProof,/LOCAL_EDITS_CONFLICT/);
  assert.equal(preparedCount,0);
  assert.deepEqual(proofRows(),divergentRows);
  assert.equal(projectCooking((await proofPeer.householdContent.readRecipe(added.id)).doc).recipes[0].title,divergent.title);
  resetProof();proofPeer=await openProofRuntime();
  const installedEstablished=await installProof();
  assert.deepEqual(installedEstablished,{scope,head:signedCopy.head,replayed:false});
  assert.equal(preparedCount,signedCopy.documents.length);
  const establishedSaved=must(await proofStorage.readHouseholdOwnDeviceSetRetained(scope,eventV5.proposalId));
  assert.equal(establishedSaved.guardId,establishedProof.guard.guardId);
  assert.equal(establishedSaved.recipient.transcriptHash,establishedProof.oob.hash);
  const receiptBody={scope,pin:a.root.head,operationId:eventV5.proposalId,guardId:establishedProof.guard.guardId,
   ceremonyGuard:establishedProof.guard,transcriptHash:establishedProof.oob.hash,fileHash:pairingDigest(sodium,establishedFile),
   parent:parentRecord,child:copyTransition.next,deviceId:b.deviceId,copyHash:capturedCopy.copyHash};
  assert.ok(sodium.crypto_sign_verify_detached(sodium.from_hex(establishedSaved.recipient.signature),
   domain('household-own-device-established-receipt-v1',receiptBody),b.signingTestKey.publicKey));
  for(const [index,document] of signedCopy.documents.entries()){
   assert.deepEqual(establishedSaved.documents[index].document.bytes,document.copy.snapshot);
   const epochId=await selectedSourceHash(a.provider,'household-own-device-key-slot-v1',{
    scope,pin:a.root.head,head:signedCopy.head,epochId:signedCopy.context.epochId,documentId:document.targetDocumentId});
   const keyOperationId=await selectedSourceHash(a.provider,'household-own-device-key-operation-v1',{epochId,deviceId:b.deviceId});
   const identity={version:1,scope,deviceId:b.deviceId,purpose:'data',epochId};
   await proofKeys.use(keyOperationId,identity,key=>assert.equal(pairingDigest(sodium,key),proofKeyHashes[index]));
  }
  const establishedReopen={storage:proofStorage,scope,operationId:eventV5.proposalId,pin:a.root.head,provider:a.provider,sodium,LoroDoc,keys:proofKeys,wrappingSecret:existingWrap.privateKey};
  const reopenedEstablished=await reopenOwnDeviceSet(establishedReopen);
  assert.equal(reopenedEstablished.head,signedCopy.head);
  assert.equal(reopenedEstablished.documents.length,signedCopy.documents.length);
  for(const mutate of [saved=>{saved.recipient.signature='0'.repeat(128)},saved=>{saved.recipient.evidence.guard.guardId+='x'},saved=>{saved.copyHash='0'.repeat(64)},saved=>{saved.documents.reverse()}]){
   const changed=structuredClone(establishedSaved);mutate(changed);
   const storage={...proofStorage,readHouseholdOwnDeviceSetRetained:async()=>({ok:true,value:changed})};
   await assert.rejects(reopenOwnDeviceSet({...establishedReopen,storage}));
  }
  const retryArgs={storage:proofStorage,runtime:{...proofPeer.runtime,scope:{...proofPeer.runtime.scope,authorDevice:b.deviceId}},provider:a.provider,sodium,LoroDoc,pin:a.root.head,parentRecord,evidence:establishedProof,file:establishedFile,wrappingSecret:existingWrap.privateKey,signingSecret:b.signingTestKey.privateKey,keys:proofKeys,deviceId:b.deviceId};
  const installedSet={operationId:eventV5.proposalId,paired:{keys:proofKeys,useWrapping:use=>use(existingWrap.privateKey)}};
  const resolvedEstablished=await resolveInstalledSetAuthority({...fileOptions,storage:proofStorage,scope,authorDevice:b.deviceId,...installedSet});
  const establishedPeer=await openPeer(proofStorage,{resolved:resolvedEstablished,installedSet},enable(proofKeys,b.signingTestKey.privateKey,existingWrap.privateKey),sodium.to_hex(b.signingTestKey.publicKey));
  const installedRecipe=await establishedPeer.householdContent.readRecipe(added.id);
  const installedBefore=projectCooking(installedRecipe.doc).recipes[0];
  const installedAfter={...installedBefore,title:'Established recipient edit'};
  const installedCommands=planRecipeAction({doc:installedRecipe.doc,before:installedBefore,after:installedAfter,actionId:'established-post-install',author:b.deviceId,at});
  await establishedPeer.householdContent.execute('established-post-install',installedCommands,added.id);
  assert.equal(projectCooking((await establishedPeer.householdContent.readRecipe(added.id)).doc).recipes[0].title,installedAfter.title);
  const beforeRetry=proofRows();
  assert.equal((await installEstablishedOwnDeviceSet(retryArgs)).replayed,true);
  const altered=establishedFile.slice(); altered[altered.length-1]^=1;
  await assert.rejects(installEstablishedOwnDeviceSet({...retryArgs,file:altered}));
  const changedEvidence=structuredClone(establishedProof); changedEvidence.guard.guardId+='-changed';
  await assert.rejects(installEstablishedOwnDeviceSet({...retryArgs,evidence:changedEvidence}));
  assert.deepEqual(proofRows(),beforeRetry);
  const pairingFile=published.file;
  assert.ok(pairingFile.length>112);
  const sourceKeyHash=await sponsorCatalog.useIdentity({version:1,scope,deviceId:a.deviceId,purpose:'data',epochId:parent.epochId},
   key=>pairingDigest(sodium,key));
  let newcomerHashes;
  await withOpenedOwnDeviceSetFile({...fileOptions,file:pairingFile,wrappingSecret:nextWrap.privateKey,withKeys:({keys})=>{
   const hashes=keys.map(({key})=>pairingDigest(sodium,key));
   newcomerHashes=hashes;
   assert.equal(new Set(hashes).size,signedCopy.documents.length);
   assert.ok(!hashes.includes(sourceKeyHash));
  }});
  assert.deepEqual(a.rows(),beforePublish);
  const pairedPath=join(pairedDir,'peer.sqlite');
  let pairedDb=new DatabaseSync(pairedPath),pairedFault=0;
  t.after(()=>{pairedDb.close();rmSync(pairedDir,{recursive:true});});
  const pairedConnection={executeSync(sql,params=[]){
   const statement=pairedDb.prepare(sql);
   return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])};
  }};
  const pairedStorage=openSQLiteStorage(pairedConnection,boundary=>{
   if(boundary==='household-own-device-set'&&pairedFault>0&&--pairedFault===0)throw Error('injected');
  });
  const pairedRows=()=>pairedDb.prepare('SELECT key,value FROM loro_records ORDER BY key').all();
  const pairedParent={...parentRecord,revision:0};
  must(await pairedStorage.retainPublicHouseholdParent(pairedParent));
  const pairedMaster=testMaster(),pairedKeys=pairedStorage.localKeys(pairedMaster,sodium);
  await pairedKeys.provision('paired-set-master');
  const pairedOptions={...fileOptions,storage:pairedStorage,parentRecord:pairedParent,
   keys:pairedKeys,deviceId:peer.transcript.responder.deviceId,wrappingSecret:nextWrap.privateKey,signingSecret:nextRecipient.privateKey};
  const pairedName='paired-recipient-fixture';
  function openPairedDatabase(name){
   const db=new DatabaseSync(join(pairedDir,`${name}.sqlite`));
   return {executeSync(sql,params=[]){
    const statement=db.prepare(sql);
    return {rows:sql.startsWith('SELECT')?statement.all(...params):(statement.run(...params),[])};
   },close:()=>db.close()};
  }
  const openPairedJoin=()=>openNativeHouseholdPersistence({name:pairedName,openDatabase:openPairedDatabase,
   workspaceRun:openSQLiteTransaction(pairedConnection),master:pairedMaster,storage:pairedStorage,provider:a.provider,
   sodium,deviceId:pairedOptions.deviceId,paired:{keys:pairedKeys,LoroDoc,useWrapping:use=>use(nextWrap.privateKey)}});
  let pairedJoin=openPairedJoin();
  t.after(()=>pairedJoin.close());
  const {operationId:pairedEnrollmentId}=householdReceiverIds(sodium,scope,pairedOptions.deviceId);
  const pairedEnrollment={scope,pin:a.root.head,operationId:pairedEnrollmentId,confirmedParent:pairedParent.acceptedParent};
  await pairedJoin.pins.save({version:1,scope,pin:a.root.head,head:pairedParent.acceptedParent});
  await pairedJoin.prepareJoinedSequences(pairedEnrollment);
  const pairedBefore=pairedRows();
  pairedFault=signedCopy.documents.reduce((count,document)=>count+4+2*document.identities.length,5);
  await assert.rejects(installOwnDeviceSetFile({...pairedOptions,file:pairingFile}),/IO/);
  assert.equal(pairedFault,0);
  pairedDb.close();pairedDb=new DatabaseSync(pairedPath);
  assert.deepEqual(pairedRows(),pairedBefore);
  assert.deepEqual(await installOwnDeviceSetFile({...pairedOptions,file:pairingFile}),
   {scope,head:signedCopy.head,replayed:false});
  await assert.rejects(pairedJoin.selection.select(scope,signedCopy.head),/INCOMPLETE_ENROLLMENT/);
  (await pairedJoin.finalizeJoinedSequences(pairedEnrollment)).sequences.close();
  await pairedJoin.selection.select(scope,signedCopy.head);
  for(const doc of signedCopy.documents){
   const saved=must(await pairedStorage.reopenDocument(scope.id,doc.targetDocumentId));
   assert.deepEqual(saved.bytes,doc.copy.snapshot);
   assert.equal(saved.revision,0);
  }
  pairedDb.close();pairedDb=new DatabaseSync(pairedPath);
  pairedJoin.close();pairedJoin=openPairedJoin();
  const pairedSelection=await pairedJoin.selection.openSelected();
  assert.equal(pairedSelection.resolved.scope.branchHead,signedCopy.head);
  assert.equal(pairedSelection.installedSet.operationId,evidence.transcript.sessionId);
  const reserved=await pairedSelection.sequences.reserve(scope.id,'paired-before-restart');
  pairedSelection.sequences.close();
  const again=await pairedJoin.selection.openSelected();
  assert.deepEqual(await again.sequences.reserve(scope.id,'paired-before-restart'),reserved);
  again.sequences.close();
  await assert.rejects(pairedJoin.finalizeJoinedSequences({...pairedEnrollment,confirmedParent:'0'.repeat(64)}),/INVALID_ADMISSION/);
  const pairedPinDb=openPairedDatabase(`${pairedName}-pairing`),pairedPinRun=openSQLiteTransaction(pairedPinDb);
  const pairedPinSlot=JSON.stringify(['pin',scope.id]);
  try{
   const savedPin=await pairedPinRun(false,tx=>tx.get(pairedPinSlot));
   const badPin=await pairedMaster.wrap('workspace-master',new TextEncoder().encode(JSON.stringify({
    version:1,scope,pin:a.root.head,head:'0'.repeat(64)
   })),new TextEncoder().encode(`creative-cooking/household-pin/v1/${scope.id}`));
   await pairedPinRun(true,tx=>tx.put(pairedPinSlot,badPin));
   await assert.rejects(pairedJoin.selection.openSelected(),/INVALID_ADMISSION/);
   await pairedPinRun(true,tx=>tx.put(pairedPinSlot,savedPin));
  }finally{pairedPinDb.close()}
  rmSync(join(pairedDir,`${pairedName}-${pairedEnrollmentId}.sqlite`));
  await assert.rejects(pairedJoin.selection.openSelected(),/MISSING_SEQUENCES/);
  await assert.rejects(pairedJoin.finalizeJoinedSequences(pairedEnrollment),/MISSING_SEQUENCES/);
  const enrollmentSlot=JSON.stringify(['native-household-enrollment',scope.id]);
  const savedEnrollment=pairedDb.prepare('SELECT value FROM loro_records WHERE key=?').get(enrollmentSlot).value;
  pairedDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(
   JSON.stringify({...JSON.parse(savedEnrollment),stage:'pending'}),enrollmentSlot);
  await assert.rejects(pairedJoin.finalizeJoinedSequences(pairedEnrollment),/MISSING_SEQUENCES/);
  const missingCounter=openPairedDatabase(`${pairedName}-${pairedEnrollmentId}`);
  try{
   assert.deepEqual(missingCounter.executeSync("SELECT name FROM sqlite_master WHERE type='table'").rows,[]);
  }finally{missingCounter.close()}
  // A pre-upgrade active enrollment never had an independent activation record.
  const activationSlot=JSON.stringify(['native-household-activation',scope.id]);
  const savedActivation=pairedDb.prepare('SELECT value FROM loro_records WHERE key=?').get(activationSlot).value;
  pairedDb.prepare('DELETE FROM loro_records WHERE key=?').run(activationSlot);
  rmSync(join(pairedDir,`${pairedName}-${pairedEnrollmentId}.sqlite`));
  await assert.rejects(pairedJoin.finalizeJoinedSequences(pairedEnrollment),/MISSING_SEQUENCES/);
  const preUpgradeCounter=openPairedDatabase(`${pairedName}-${pairedEnrollmentId}`);
  try{
   assert.deepEqual(preUpgradeCounter.executeSync("SELECT name FROM sqlite_master WHERE type='table'").rows,[]);
  }finally{preUpgradeCounter.close()}
  pairedDb.prepare('INSERT INTO loro_records(key,value) VALUES (?,?)').run(activationSlot,savedActivation);
  pairedDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(savedEnrollment,enrollmentSlot);
  const reopenOptions={storage:pairedStorage,scope,operationId:evidence.transcript.sessionId,pin:fileOptions.pin,
   provider:fileOptions.provider,sodium,LoroDoc,keys:pairedKeys,wrappingSecret:nextWrap.privateKey};
  const reopenedSet=await reopenOwnDeviceSet(reopenOptions);
  assert.equal(reopenedSet.head,signedCopy.head);
  assert.equal(reopenedSet.documents.length,signedCopy.documents.length);
  const targetSlot=JSON.stringify(['document',scope.id,signedCopy.documents[0].targetDocumentId]);
  const targetValue=pairedDb.prepare('SELECT value FROM loro_records WHERE key=?').get(targetSlot).value;
  const damagedTarget=JSON.parse(targetValue);
  damagedTarget.revision=1;
  damagedTarget.bytes=JSON.parse(JSON.stringify(damagedTarget.bytes));
  pairedDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify({...damagedTarget,bytes:[]}),targetSlot);
  await assert.rejects(reopenOwnDeviceSet(reopenOptions));
  pairedDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(targetValue,targetSlot);
  const pairedAfter=pairedRows();
  assert.deepEqual(await installOwnDeviceSetFile({...pairedOptions,file:pairingFile}),
   {scope,head:signedCopy.head,replayed:true});
  const resealed=sealDeviceCopy(sodium,fileDomain,evidence.hash,evidence.transcript.responder,sponsorKeys.signingSecret,
   openDeviceCopy(sodium,fileDomain,pairingFile,evidence.hash,evidence.transcript,nextWrap.privateKey));
  await assert.rejects(installOwnDeviceSetFile({...pairedOptions,file:resealed}),/CONFLICT/);
  await assert.rejects(installOwnDeviceSetFile({...pairedOptions,file:pairingFile,
   keys:pairedStorage.localKeys(testMaster(),sodium)}),/LOCKED/);
  assert.deepEqual(pairedRows(),pairedAfter);
  const receiptSlot=JSON.stringify(['household-own-device-set',scope.id,evidence.transcript.sessionId]);
  const {value:receiptValue}=pairedDb.prepare('SELECT value FROM loro_records WHERE key=?').get(receiptSlot);
  const damagedReceipt=JSON.parse(receiptValue);
  damagedReceipt.recipient.signature='0'.repeat(128);
  pairedDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(damagedReceipt),receiptSlot);
  const damagedRows=pairedRows();
  await assert.rejects(installOwnDeviceSetFile({...pairedOptions,file:pairingFile}),/INVALID_PROOF/);
  assert.deepEqual(pairedRows(),damagedRows);
  const verifiedCopy=await verifyAuthority(copyTransition.state,a.root.head,a.provider,{pendingOwnDeviceSet:signedCopy.head});
  const child=verifiedCopy.nodes.get(signedCopy.head);
  assert.deepEqual(child.roster,parent.roster);
  assert.deepEqual(child.policy,parent.policy);
  assert.equal(child.devices.length,parent.devices.length+1);
  assert.equal(child.devices.at(-1).adultId,eventV5.subject.adultId);
  await assert.rejects(verifyAuthority(copyTransition.state,a.root.head,a.provider),/UNSUPPORTED_VERSION/);
  await assert.rejects(verifyOwnDeviceSuccessor({...copyArgs,next:copyTransition.next}),/INVALID_AUTHORITY/);
  for(const [changed,error] of [
   [{...eventV5,subject:{...eventV5.subject,copyHash:'0'.repeat(64)}},/INVALID_COPY/],
   [{...eventV5,subject:{...eventV5.subject,baseline:{...eventV5.subject.baseline,historyHash:'0'.repeat(64)}}},/INVALID_COPY/],
   [{...eventV5,subject:{...eventV5.subject,parentRevision:parentRecord.revision+1}},/INVALID_OWN_DEVICE/],
   [{...eventV5,subject:{...eventV5.subject,deviceId:'wrong-recipient'}},/INVALID_OWN_DEVICE/],
   [{...eventV5,frozenAdultRoster:['adult']},/CONTEXT_MISMATCH/],
  ]){
   const {next}=await signedCopyTransition(changed);
   await assert.rejects(verifyOwnDeviceSetSuccessor({...copyArgs,next}),error);
  }
  const admittedCopy=checkedCopy.find(entry=>entry.recipeId===recipeId);
  const laterCopy=checkedCopy.find(entry=>entry.recipeId===added.id);
  assert.ok(admittedCopy.copy.seedSnapshot);
  assert.deepEqual(admittedCopy.copy.sources.find(row=>row.effectId===recipeCommands[0].effectId).policyHashes,
   [accepted.policyHash]);
  assert.ok(admittedCopy.copy.policies.some(row=>row.policyHash===accepted.policyHash));
  assert.equal(laterCopy.copy.seedSnapshot,null);
  for(const file of [bytes,editBytes]){
   const {header}=JSON.parse(dec.decode(file));
   assert.deepEqual(laterCopy.copy.sources.find(row=>row.effectId===header.semanticEffectIds[0]).policyHashes,
    header.disclosurePolicyHashes);
  }
  for(const corrupt of [
   value=>value.documents.pop(),
   value=>value.documents.splice(1,1,value.documents[2]),
   value=>{value.documents[1].copy.snapshot[0]^=1;},
   value=>{value.documents.find(entry=>entry.recipeId===recipeId).copy.sources.find(row=>row.effectId===recipeCommands[0].effectId).policyHashes=[];},
   value=>{value.observation.manifest.parentHead='0'.repeat(64);},
  ]){
   const invalid=structuredClone(capturedCopy.set);
   corrupt(invalid);
   await assert.rejects(()=>verifyCopy(invalid),/INVALID_COPY|INVALID_SOURCE_SET/);
  }
  const allocations=new Map();
  const allocateNext=documentId=>{if(!allocations.has(documentId)){const n=allocations.size+1;
   allocations.set(documentId,{seedId:`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`,peerId:String(1000+n)});}
   return allocations.get(documentId);};
  const nextProjection=await prepareCurrentDocumentSet({runtime:sponsor.runtime,service:sponsor.service,item:nextItem,allocateSeed:allocateNext});
  assert.ok(nextProjection.manifest.entries.some(entry=>entry.recipeId===recipeId));
  assert.ok(nextProjection.manifest.entries.some(entry=>entry.recipeId===added.id));
  const staleGuard=structuredClone(observedInstalled.guard);
  staleGuard.members[0].revision++;
  assert.equal((await a.storage.checkSelectedHouseholdSources(staleGuard)).error.code,'CONFLICT');
  const tamperedObservation=structuredClone(observedInstalled.signed);
  tamperedObservation.manifest.children[0].checkpointHash='0'.repeat(64);
  await assert.rejects(()=>verifySelectedSourceSet({storage:a.storage,scope,pin:a.root.head,
   provider:a.provider,signed:tamperedObservation}),/INVALID_SOURCE_SIGNATURE/);
  publishDb.close();publishDb=new DatabaseSync(join(pairedDir,'sponsor.sqlite'));
  for(const doc of signedCopy.documents)assert.deepEqual(must(await publishStorage.reopenDocument(scope.id,doc.targetDocumentId)).bytes,doc.copy.snapshot);
  const sponsorReopenOptions={...fileOptions,storage:publishStorage,scope,
   operationId:evidence.transcript.sessionId,keys:publishStorage.localKeys(sponsorMaster,sodium)};
  const sponsorRows=()=>publishDb.prepare('SELECT key,value FROM loro_records ORDER BY key').all();
  const publishedRows=sponsorRows();
  const reopenedSponsor=await reopenOwnDeviceSet(sponsorReopenOptions);
  assert.equal(reopenedSponsor.head,signedCopy.head);
  const selectedSponsor=await resolveOriginalHousehold({storage:publishStorage,scope,pin:a.root.head,
   provider:a.provider,deviceId:a.deviceId,sodium,LoroDoc,paired:{keys:sponsorReopenOptions.keys}});
  assert.equal(selectedSponsor.resolved.scope.branchHead,signedCopy.head);
  assert.equal(selectedSponsor.installedSet.operationId,evidence.transcript.sessionId);
  assert.deepEqual(reopenedSponsor.file,published.file);
  assert.deepEqual(published.establishedRecipients.map(entry=>entry.recipientDeviceId),establishedIds);
  const retainedSponsor=must(await publishStorage.readHouseholdOwnDeviceSetRetained(scope,evidence.transcript.sessionId));
  assert.deepEqual(published.establishedRecipients,retainedSponsor.sponsor.establishedRecipients.entries);
  const sponsorHashes=[];
  for(const document of reopenedSponsor.documents)await sponsorReopenOptions.keys.use(document.keyOperationId,document.identity,
   key=>sponsorHashes.push(pairingDigest(sodium,key)));
  assert.deepEqual(sponsorHashes,newcomerHashes);
  for(const [index,recipient] of establishedRecipients.entries()){
   const material=establishedMaterials.get(recipient.deviceId);
   await withOpenedEstablishedOwnDeviceTransition({...fileOptions,sodium,provider:a.provider,evidence:establishedEvidence[index],
    file:published.establishedRecipients[index].ciphertext,wrappingSecret:material.secret,withKeys:({keys})=>{
     assert.deepEqual(keys.map(({documentId})=>documentId),signedCopy.documents.map(document=>document.targetDocumentId));
     assert.deepEqual(keys.map(({key})=>pairingDigest(sodium,key)),sponsorHashes);
    }});
  }
  {
   const material=establishedMaterials.get(establishedRecipients[0].deviceId);
   const args={...fileOptions,sodium,provider:a.provider,evidence:establishedEvidence[0],
    file:published.establishedRecipients[0].ciphertext,wrappingSecret:material.secret,withKeys:()=>assert.fail('unexpected callback')};
   const wrongParent=structuredClone(fileOptions.parentRecord);wrongParent.authorizationSnapshot='wrong';
   await assert.rejects(()=>withOpenedEstablishedOwnDeviceTransition({...args,parentRecord:wrongParent}));
   const badProof=structuredClone(args.evidence);badProof.messages.offers.initiator.signature='00'.repeat(64);
   await assert.rejects(()=>withOpenedEstablishedOwnDeviceTransition({...args,evidence:badProof}));
   await assert.rejects(()=>withOpenedEstablishedOwnDeviceTransition({...args,evidence:establishedEvidence[1]}));
   const tampered=args.file.slice();tampered[tampered.length-1]^=1;
   await assert.rejects(()=>withOpenedEstablishedOwnDeviceTransition({...args,file:tampered}));
  }
  for(const mutate of [saved=>{saved.sponsor.establishedRecipients.entries[0].ciphertext[0]^=1},
   saved=>{delete saved.sponsor.establishedRecipients},saved=>{saved.sponsor.establishedRecipients.entries[0].ceremonyGuardId+='x'}]){
   const changed=structuredClone(retainedSponsor);mutate(changed);
   const storage={...publishStorage,readHouseholdOwnDeviceSetRetained:async()=>({ok:true,value:changed})};
   await assert.rejects(reopenOwnDeviceSet({...sponsorReopenOptions,storage}));
  }
  assert.deepEqual(reopenedSponsor.establishedRecipients,published.establishedRecipients);
  assert.deepEqual(reopenedSponsor.documents.map(({documentId,identity})=>[documentId,identity.deviceId]),
   signedCopy.documents.map(doc=>[doc.targetDocumentId,a.deviceId]));
  assert.deepEqual(sponsorRows(),publishedRows);
  const sponsorReceiptSlot=JSON.stringify(['household-own-device-set',scope.id,evidence.transcript.sessionId]);
  const sponsorReceiptRow=publishedRows.find(row=>row.key===sponsorReceiptSlot);
  const alteredSponsorReceipt=JSON.parse(sponsorReceiptRow.value);
  alteredSponsorReceipt.sponsor.keyHashes[0]='0'.repeat(64);
  publishDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify(alteredSponsorReceipt),sponsorReceiptSlot);
  await assert.rejects(reopenOwnDeviceSet(sponsorReopenOptions),/INVALID_PROOF/);
  await assert.rejects(resolveOriginalHousehold({storage:publishStorage,scope,pin:a.root.head,
   provider:a.provider,deviceId:a.deviceId,sodium,LoroDoc,paired:{keys:sponsorReopenOptions.keys}}),/INVALID_PROOF/);
  publishDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(sponsorReceiptRow.value,sponsorReceiptSlot);
  pairedDb.prepare('UPDATE loro_records SET value=? WHERE key=?').run(receiptValue,receiptSlot);
  const openPaired=async (storage,deviceId,keys,signingSecret,useWrapping)=>{
   const installedSet={operationId:evidence.transcript.sessionId,paired:{keys,useWrapping}};
   const resolved=await resolveInstalledSetAuthority({...fileOptions,storage,scope,authorDevice:deviceId,
    ...installedSet});
   const runtime=await openWorkspaceHouseholdRuntime({storage,resolved,installedSet,pin:a.root.head,provider:a.provider,sodium,
    keys:enable(keys,signingSecret),signing:{operationId:'test-signing',publicKey:sodium.to_hex(signingSecret.subarray(32))},
    LoroDoc,decodeImportBlobMeta});
   const service=disclosureService({storage,scope,rootPin:a.root.head,provider:a.provider,deviceId,installedSet:{...installedSet,sodium,LoroDoc}});
   return {runtime,service,householdContent:bindHouseholdContent({runtime,sequences,disclosure:service,shoppingRecipeCopies:true}),files:cookingFiles({runtime,service,recipeCatalogVersion:1})};
  };
  const pairedSponsorKeys=publishStorage.localKeys(sponsorMaster,sodium);
  await assert.rejects(()=>resolveRuntimeAuthority(pairedStorage,scope,a.root.head,a.provider,pairedOptions.deviceId),
   /UNSUPPORTED_VERSION/);
  await assert.rejects(()=>openPaired(pairedStorage,pairedOptions.deviceId,pairedKeys,nextRecipient.privateKey,
   async()=>reopenedSet),/INVALID_AUTHORITY_CONFIG/);
  const pairedSponsor=await openPaired(publishStorage,a.deviceId,pairedSponsorKeys,sponsorKeys.signingSecret);
  const pairedRecipient=await openPaired(pairedStorage,pairedOptions.deviceId,pairedKeys,nextRecipient.privateKey,
   use=>use(nextWrap.privateKey));
  await assert.rejects(pairedSponsor.runtime.forRecipe('missing-paired-recipe'),/INVALID_RECIPE_DOCUMENT/);
  await assert.rejects(pairedRecipient.runtime.forRecipe('missing-paired-recipe'),/INVALID_RECIPE_DOCUMENT/);
  const copiedSponsorRecipe=await pairedSponsor.runtime.forRecipe(recipeId);
  const copiedRecipientRecipe=await pairedRecipient.runtime.forRecipe(recipeId);
  const copiedRecipe=(await copiedSponsorRecipe.document()).doc;
  const beforePairedEdit=projectCooking(copiedRecipe).recipes[0];
  assert.equal(projectCooking((await copiedRecipientRecipe.document()).doc).recipes[0].title,beforePairedEdit.title);
  const actionId='paired-set-edit',title='Edited after paired workspace reopen';
  const [command]=planRecipeAction({doc:copiedRecipe,before:beforePairedEdit,after:{...beforePairedEdit,title},
   actionId,author:a.deviceId,at});
  await copiedSponsorRecipe.execute({operationId:actionId,command,deviceSequence:sequence++});
  const object=must(await publishStorage.getLocalOperation(scope.id,actionId)).commit.outbound[0].object;
  must(await pairedStorage.stageInbox({scopeId:scope.id,object,source:'paired-edit',expectedCursor:null,cursor:object.id}));
  await copiedRecipientRecipe.importItem({itemId:object.id,bytes:object.bytes});
  assert.equal(projectCooking((await copiedRecipientRecipe.document()).doc).recipes[0].title,title);
  assert.equal(projectCooking((await copiedSponsorRecipe.document()).doc).recipes[0].title,title);
  const appDoc=await pairedSponsor.householdContent.readRecipe(recipeId);
  const appBefore=projectCooking(appDoc.doc).recipes[0],appTitle='Saved through paired app';
  const appCommands=planRecipeAction({doc:appDoc.doc,before:appBefore,after:{...appBefore,title:appTitle},
   actionId:'paired-app-save',author:a.deviceId,at});
  await pairedSponsor.householdContent.execute('paired-app-save',appCommands,recipeId);
  const appObject=must(await publishStorage.getLocalOperation(scope.id,'paired-app-save')).commit.outbound[0].object;
  const appHeader=JSON.parse(new TextDecoder().decode(appObject.bytes)).header;
  assert.equal(appHeader.disclosureIncomplete,true);
  await assert.rejects(()=>pairedRecipient.files.receive(new Uint8Array([1,2,3])));
  await pairedRecipient.files.receive(appObject.bytes);
  assert.equal(projectCooking((await pairedSponsor.householdContent.readRecipe(recipeId)).doc).recipes[0].title,appTitle);
  assert.equal(projectCooking((await pairedRecipient.householdContent.readRecipe(recipeId)).doc).recipes[0].title,appTitle);
  const editedRecipientRows=pairedRows();
  assert.deepEqual(await installOwnDeviceSetFile({...pairedOptions,file:pairingFile}),
   {scope,head:signedCopy.head,replayed:true});
  assert.deepEqual(pairedRows(),editedRecipientRows);
  assert.deepEqual(a.rows(),beforePublish);
  const raceDoc=await sponsor.householdContent.readRecipe(added.id);
  const raceCommands=planRecipeAction({doc:raceDoc.doc,before:edited,after:{...edited,title:'Revision race'},
   actionId:'projection-source-race',author:a.deviceId,at});
  await sponsor.householdContent.execute('projection-source-race',raceCommands,added.id);
  assert.equal((await a.storage.checkSelectedHouseholdSources(observedInstalled.guard)).error.code,'CONFLICT');
  assert.equal((await a.storage.checkSelectedHouseholdSources(capturedCopy.guard)).error.code,'CONFLICT');
  const beforeStalePublish=a.rows();
  await assert.rejects(()=>publishOwnDeviceSet({...fileOptions,next:copyTransition.next,captured:capturedCopy,establishedEvidence,
   signingSecret:sponsorKeys.signingSecret,keys:sponsorCatalog,deviceId:a.deviceId}),/CONFLICT/);
  assert.deepEqual(a.rows(),beforeStalePublish);
  a.provider.verify=previousVerify;
  const beforeReceive=freshRows();
  await assert.rejects(()=>newcomer.files.receive(editBytes),/RECIPE_CREATION_REQUIRED/);
  const tampered=mutate=>{
   const envelope=JSON.parse(dec.decode(bytes));
   mutate(envelope);
   return new TextEncoder().encode(JSON.stringify(envelope));
  };
  for(const mutate of [
   value=>{value.recipeDelivery.version=2;},
   value=>{value.header.branchHead=a.root.head;},
   value=>{value.header.documentGeneration++;},
   value=>{value.header.documentId=sponsor.runtime.scope.documentId;},
   value=>{value.header.documentId=sponsorAuthority.members[1].documentId;},
   value=>{value.recipeDelivery.packets.reverse();},
   value=>{value.recipeDelivery.packets[0][1]=value.recipeDelivery.packets[1][1];},
   value=>{value.encrypted=(value.encrypted[0]==='0'?'1':'0')+value.encrypted.slice(1);},
  ])await assert.rejects(()=>newcomer.files.receive(tampered(mutate)),/INVALID_AUTHORITY|INVALID_PROOF|UNSUPPORTED_VERSION/);
  const opened=await sponsor.runtime.codec.openContent(bytes,sponsorAuthority.signingKeyRefs);
  assert.ok((await newcomer.runtime.document()).doc.getMap('recipe-index').get('legacy'));
  const collision={version:1,kind:'recipe-create',commandId:'root-recipe-collision',effectId:'root-recipe-collision',dependencyEffectIds:[],
   data:{recipe:recipe('legacy','Conflicting child'),author:a.deviceId,at}};
  const collisionDoc=new LoroDoc();
  collisionDoc.setPeerId(sponsor.runtime.scope.authorPeers[a.deviceId]);
  const empty=collisionDoc.oplogVersion();
  apply(collisionDoc,collision);
  const collisionUpdate=collisionDoc.export({mode:'update',from:empty});
  const rootCollision=await sponsor.runtime.authority.recipeDelivery.create(sponsor.runtime,'legacy',worker=>
   worker.codec.sealContent({...opened.header,documentId:worker.scope.documentId,deviceSequence:++sequence,
    semanticEffectIds:[collision.effectId]},new TextEncoder().encode(JSON.stringify({version:1,command:collision,update:[...collisionUpdate]})),
    worker.keyRef,signingRef));
  await assert.rejects(()=>newcomer.files.receive(rootCollision.bytes),/CONFLICT/);
  const collisionStaging=new Set([JSON.stringify(['inbox',scope.id,rootCollision.id]),
   JSON.stringify(['cursor',scope.id,`file:${rootCollision.id}`])]);
  assert.deepEqual(freshRows().filter(({key})=>!collisionStaging.has(key)),beforeReceive);
  const afterCollision=await newcomer.householdContent.readCooking();
  assert.deepEqual(afterCollision.recipes.filter(value=>value.id==='legacy').map(value=>value.title),['legacy']);

  // Pad a fixture header to exercise the wrapper boundary with real inner
  // encryption and real packets. The app cannot emit these synthetic lists.
  const sizeBefore=a.rows();
  const largeRecipe=recipe('delivery-size-boundary','Carrots');
  const sizeAction='delivery-size-boundary';
  const sizeCommands=planRecipeAction({doc:new LoroDoc(),before:null,after:largeRecipe,
   actionId:sizeAction,author:a.deviceId,at});
  const encoder=new TextEncoder();
  const pad=(header,length)=>{
   const ids=Array.from({length:64},(_,index)=>'\0'.repeat(length)+String(index).padStart(2,'0'));
   return {...header,policyHashes:ids,predecessorRefs:ids,semanticEffectIds:ids,sourceEffectIds:ids};
  };
  const encodedSize=header=>encoder.encode(JSON.stringify({kind:'content',header,encrypted:'',signature:'0'.repeat(128)})).length+
   2*(CANDIDATE_LIMIT+sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES+sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  const hash=sodium.crypto_generichash;
  const nearLimit=[];
  sodium.crypto_generichash=(length,bytes,...args)=>{
   if(bytes.length>4*CANDIDATE_LIMIT){
    const [format,purpose,hex]=JSON.parse(dec.decode(bytes));
    if(format==='creative-cooking/k2-candidate/v1'&&purpose==='object-id')nearLimit.push(hex.length/2);
   }
   return hash(length,bytes,...args);
  };
  try{
   await assert.rejects(()=>sponsor.runtime.authority.recipeDelivery.create(sponsor.runtime,largeRecipe.id,worker=>{
    const seal=worker.codec.sealContent;
    worker.codec.sealContent=(header,_payload,ref,signRef)=>{
     const padding=Math.floor((MAX_OBJECT-encodedSize(pad(header,0)))/(6*64*4));
     return seal(pad(header,padding),new Uint8Array(CANDIDATE_LIMIT),ref,signRef);
    };
    return executeAction(worker,sequences,sizeAction,sizeCommands,sponsor.service);
   }),/TOO_LARGE/);
  }finally{sodium.crypto_generichash=hash;}
  assert.equal(nearLimit.length,1);
  assert.ok(nearLimit[0]<=MAX_OBJECT&&nearLimit[0]>MAX_OBJECT-6*64*4);
  assert.deepEqual(a.rows(),sizeBefore);

  const wrongRecipeId='other-member-slot';
  const wrongRecipe=await sponsor.runtime.authority.recipeDelivery.create(sponsor.runtime,wrongRecipeId,worker=>
   worker.codec.sealContent({...opened.header,documentId:worker.scope.documentId},opened.value,worker.keyRef,signingRef));
  await assert.rejects(()=>newcomer.files.receive(wrongRecipe.bytes),/INVALID_RECIPE_DOCUMENT/);
  assert.deepEqual(freshRows().filter(({key})=>!collisionStaging.has(key)),beforeReceive);
  await newcomer.householdContent.createRecipe('competing-create',added);
  const competing=must(await freshStorage.getLocalOperation(scope.id,'competing-create')).commit.outbound[0].object;
  const sponsorBeforeConflict=a.rows();
  await assert.rejects(()=>sponsor.files.receive(competing.bytes),/CONFLICT/);
  assert.deepEqual(a.rows(),sponsorBeforeConflict);
  // Use the other independently admitted recipient for the successful import.
  const existingCatalog=b.storage.localKeys(existingMaster,sodium);
  const openExisting=async()=>openPeer(b.storage,{resolved:await resolveInstalledSetAuthority({...existingOptions,
   operationId,authorDevice:b.deviceId}),installedSet:{operationId}},
   enable(existingCatalog,b.signingTestKey.privateKey,existingWrap.privateKey),sodium.to_hex(b.signingTestKey.publicKey),wrapping);
  let existing=await openExisting();
  await existing.files.receive(recipeBytes);
  await existing.files.receive(pantryBytes);
  for(const object of admittedShoppingObjects)await existing.files.receive(object.bytes);
  const beforeImport=b.rows();
  for(const fault of ['recipe-key','recipe-catalog','import-documents','import']){
   b.faultAt(fault);
   await assert.rejects(()=>existing.files.receive(bytes),/IO/);
   b.reopen();
   assert.equal(must(await b.storage.getInboxApplication(scope.id,creation.id)),null);
   assert.equal(must(await b.storage.reopenDocument(scope.id,newDocumentId)),null);
   const staged=new Set([JSON.stringify(['inbox',scope.id,creation.id]),JSON.stringify(['cursor',scope.id,`file:${creation.id}`])]);
   assert.deepEqual(b.rows().filter(({key})=>!staged.has(key)),beforeImport);
  }
  b.faultAt(null);
  assert.deepEqual(await existing.files.pending(),[{itemId:creation.id,reason:null}]);
  const received=await existing.files.retry(creation.id);
  assert.equal(received.replayed,false);
  assert.deepEqual(await existing.files.receive(bytes),{...received,replayed:true});
  await existing.files.receive(editBytes);
  b.reopen();
  existing=await openExisting();
  const row=must(await b.storage.getInboxApplication(scope.id,creation.id));
  assert.deepEqual(row.outcome,received.outcome);
  assert.equal((await existing.householdContent.readCooking()).recipes.find(r=>r.id===added.id)?.title,edited.title);
  assert.equal((await existing.runtime.document()).doc.getMap('recipe-index').get(added.id),undefined);
  const keySlotFor=(now,before)=>JSON.parse(now.find(({key})=>JSON.parse(key)[0]==='local-key'&&
   !before.some(row=>row.key===key)).key);
  const inspectKey=(catalog,slot)=>catalog.useIdentity({version:1,scope,deviceId:slot[3],purpose:'data',epochId:slot[5]},
   key=>sodium.to_hex(sodium.crypto_generichash(32,key)));
  const newKey=await inspectKey(sponsorCatalog,keySlotFor(afterCreation,beforeCreation));
  assert.equal(await inspectKey(existingCatalog,keySlotFor(b.rows(),beforeImport)),newKey);
  assert.equal(distinctKeys.has(newKey),false);
  assert.equal((await existing.files.receive(bytes)).replayed,true);
  // The recipient now has the actual prior installed set and has imported both
  // source objects present when the sponsor captured the new copy.
  a.provider.verify=(ref,data,signature)=>ref===sodium.to_hex(newcomerSign.publicKey)
   ?sodium.crypto_sign_verify_detached(signature,data,newcomerSign.publicKey):previousVerify(ref,data,signature);
  const existingParent=must(await b.storage.readPairingAuthority(scope));
  assert.deepEqual(existingParent,localParent);
  assert.notEqual(existingParent.authorizationSnapshot,parentRecord.authorizationSnapshot);
  const existingSources=await observeSelectedSourceSet(existing.runtime,{verifyCheckpointHistory:true});
  assert.equal(existingSources.sources.length,signedCopy.documents.length);
  for(const [index,source] of existingSources.sources.entries()){
   const expected=signedCopy.documents[index];
   assert.equal(source.runtime.recipeId,expected.recipeId);
   assert.deepEqual(await policyBaseline(source.doc,a.provider),expected.baseline,`source history ${expected.recipeId ?? 'root'}`);
  }
  const priorSelections=JSON.parse(dec.decode(existingParent.authorityState)).selections;
  let expectedLocalNext,existingKeyHashes;
  await withOpenedEstablishedOwnDeviceTransition({storage:b.storage,provider:a.provider,sodium,LoroDoc,pin:a.root.head,
   parentRecord:existingParent,evidence:establishedProof,file:establishedFile,wrappingSecret:existingWrap.privateKey,
   signingSecret:b.signingTestKey.privateKey,withKeys:result=>{
    expectedLocalNext=result.localNext;existingKeyHashes=result.keys.map(({key})=>pairingDigest(sodium,key));
   }});
  const existingInstall={storage:b.storage,runtime:existing.runtime,provider:a.provider,sodium,LoroDoc,pin:a.root.head,
   parentRecord:existingParent,evidence:establishedProof,file:establishedFile,wrappingSecret:existingWrap.privateKey,
   signingSecret:b.signingTestKey.privateKey,keys:existingCatalog,deviceId:b.deviceId};
  assert.deepEqual(await installEstablishedOwnDeviceSet(existingInstall),{scope,head:signedCopy.head,replayed:false});
  const existingSaved=must(await b.storage.readHouseholdOwnDeviceSetRetained(scope,eventV5.proposalId));
  assert.deepEqual(existingSaved.expected,existingParent);
  assert.deepEqual(existingSaved.next,expectedLocalNext);
  const installedSelections=JSON.parse(dec.decode(existingSaved.next.authorityState)).selections;
  assert.deepEqual(installedSelections.slice(0,-1),priorSelections);
  assert.equal(installedSelections.at(-1).deviceId,b.deviceId);
  const existingReopen=await reopenOwnDeviceSet({storage:b.storage,scope,operationId:eventV5.proposalId,pin:a.root.head,
   provider:a.provider,sodium,LoroDoc,keys:existingCatalog,wrappingSecret:existingWrap.privateKey});
  assert.equal(existingReopen.documents.length,signedCopy.documents.length);
  for(const [index,document] of existingReopen.documents.entries()){
   assert.deepEqual(existingSaved.documents[index].document.bytes,signedCopy.documents[index].copy.snapshot);
   await existingCatalog.use(document.keyOperationId,document.identity,key=>assert.equal(pairingDigest(sodium,key),existingKeyHashes[index]));
  }
  const newSet={operationId:eventV5.proposalId,paired:{keys:existingCatalog,useWrapping:use=>use(existingWrap.privateKey)}};
  const resolvedNew=await resolveInstalledSetAuthority({...fileOptions,storage:b.storage,scope,authorDevice:b.deviceId,...newSet});
  const existingNew=await openPeer(b.storage,{resolved:resolvedNew,installedSet:newSet},
   enable(existingCatalog,b.signingTestKey.privateKey,existingWrap.privateKey),sodium.to_hex(b.signingTestKey.publicKey),wrapping);
  const target=await existingNew.householdContent.readRecipe(added.id);
  const beforeTarget=projectCooking(target.doc).recipes[0];
  const targetCommands=planRecipeAction({doc:target.doc,before:beforeTarget,after:{...beforeTarget,title:'Local retry edit'},
   actionId:'existing-local-retry-edit',author:b.deviceId,at});
  await existingNew.householdContent.execute('existing-local-retry-edit',targetCommands,added.id);
  const beforeExistingRetry=b.rows();
  assert.deepEqual(await installEstablishedOwnDeviceSet(existingInstall),{scope,head:signedCopy.head,replayed:true});
  assert.deepEqual(b.rows(),beforeExistingRetry);
  a.provider.verify=(ref,data,signature)=>ref===sodium.to_hex(newcomerSign.publicKey)
   ?sodium.crypto_sign_verify_detached(signature,data,newcomerSign.publicKey):previousVerify(ref,data,signature);
  const inherited=await sponsor.householdContent.readRecipe(recipeId);
  const liveInherited=projectCooking(inherited.doc).recipes.find(row=>row.id===recipeId);
  const removal=planRecipeAction({doc:inherited.doc,before:liveInherited,after:null,
   actionId:'remove-inherited-for-next-set',author:a.deviceId,at});
  await sponsor.householdContent.execute('remove-inherited-for-next-set',removal,recipeId);
  const redacted=await prepareCurrentDocumentSet({runtime:sponsor.runtime,service:sponsor.service,item:nextItem,allocateSeed:allocateNext});
  assert.equal(redacted.manifest.entries.some(entry=>entry.recipeId===recipeId),false);
  assert.ok(redacted.manifest.catalog.removed.length>0);
  assert.ok(redacted.manifest.entries.some(entry=>entry.recipeId===added.id));
  const publicAuthority=await readAuthority(a.storage,scope,a.root.head,a.provider);
  assert.throws(()=>requirePublicRecipeHistory(publicAuthority.state,new Set(redacted.manifest.entries.map(entry=>entry.recipeId))),/REMOVED_RECIPE_HISTORY/);
  await assert.rejects(()=>exportHouseholdParent({storage:a.storage,scope,pin:a.root.head,provider:a.provider,runtime:sponsor.runtime}),/REMOVED_RECIPE_HISTORY/);
  const redactedRoot=new LoroDoc();redactedRoot.import(redacted.documents[0].seed.snapshot);
  assert.equal(projectCooking(redactedRoot).shopping.items.some(item=>item.recipeId===recipeId),false);
  a.provider.verify=previousVerify;
  const expectedAuthority=await sponsor.runtime.authorize();
  assert.deepEqual(await a.storage.compromise.quarantine(scope.id,b.deviceId,{expectedAuthority,localDeviceId:a.deviceId}),
   {quarantined:true});
  const quarantined=a.rows();
  await assert.rejects(()=>sponsor.files.download(creation.id),/QUARANTINED/);
  await assert.rejects(()=>sponsor.householdContent.createRecipe('quarantined-recipient',recipe('withheld','Carrots')),/QUARANTINED/);
  assert.deepEqual(a.rows(),quarantined);
 });
 newcomerSelection.sequences.close();
 rmSync(join(freshDatabase,`${joinName}-${joinId}.sqlite`));
 await assert.rejects(()=>joinStore.selection.openSelected(),/MISSING_SEQUENCES/);

 // A later delegation must not invalidate the exact installed publication.
 // Both distinct adults sign at the installed head; one signature is insufficient.
 const nextAgreement={version:1,householdId:scope.id,parentHead:eventHash,policyHash:a.root.policyHash,
  roster:['adult','newcomer'],delegation:'currentCooking',sourcePolicyHashes:[a.root.policyHash]};
 const nextSigners=[{adultId:'adult',deviceId:a.deviceId},{adultId:'newcomer',deviceId:newcomerContext.recipientDeviceId}];
 const nextAcceptances=nextSigners.map((signer,index)=>({...signer,signature:sodium.to_hex(sodium.crypto_sign_detached(
  domain('admission-agreement-acceptance',{agreement:nextAgreement,...signer}),
  index===0?a.signingTestKey.privateKey:newcomerSign.privateKey))}));
 const nextSigned={...nextAgreement,acceptances:nextAcceptances};
 const extendedProvider={...a.provider,verify:(ref,bytes,signature)=>ref===sodium.to_hex(newcomerSign.publicKey)
  ?sodium.crypto_sign_verify_detached(signature,bytes,newcomerSign.publicKey):a.provider.verify(ref,bytes,signature)};
 const beforeDelegation=freshRows();
 await assert.rejects(()=>acceptAdmissionAgreement(freshStorage,scope,a.root.head,extendedProvider,
  {...nextAgreement,acceptances:nextAcceptances.slice(0,1)}));
 assert.deepEqual(freshRows(),beforeDelegation);
 freshFault='pairing-authority';
 await assert.rejects(()=>acceptAdmissionAgreement(freshStorage,scope,a.root.head,extendedProvider,nextSigned),/IO/);
 freshFault=null;
 reopenFresh();
 assert.deepEqual(freshRows(),beforeDelegation);
 await acceptAdmissionAgreement(a.storage,scope,a.root.head,extendedProvider,nextSigned);
 assert.deepEqual(await sealHouseholdFile({...sealOptions,provider:extendedProvider}),sealed);
 const retainedHash=await acceptAdmissionAgreement(freshStorage,scope,a.root.head,extendedProvider,nextSigned);
 assert.equal(await acceptAdmissionAgreement(freshStorage,scope,a.root.head,extendedProvider,nextSigned),retainedHash);
 reopenFresh();
 const extended=await resolveInstalledSetAuthority({...newcomerOptions,provider:extendedProvider,operationId,authorDevice:newcomerContext.recipientDeviceId});
 assert.equal(extended.scope.branchHead,eventHash);
 assert.deepEqual(extended.members,newcomerAuthority.members);
 assert.deepEqual((await readInstalledHouseholdDocumentSet({...newcomerOptions,operationId})).publication,
  newcomerSelected.publication);

});

test('parent-format recipe children without catalog entries remain intact and require an explicit upgrade',async t=>{
 const [peer]=await household(t,{onDisk:true});
 const runtime=await peer.runtime.forRecipe('retained-child'),at='2026-01-01T00:00:00Z';
 const command={version:1,kind:'recipe-create',commandId:'old-child',effectId:'old-child',dependencyEffectIds:[],
  data:{recipe:{id:'retained-child',title:'Retained soup',portions:2,ingredients:[],steps:[],stepIds:[]},author:peer.deviceId,at}};
 const commit=peer.storage.commitLocalWithDisclosurePolicy.bind(peer.storage);
 peer.storage.commitLocalWithDisclosurePolicy=(input,policy,active)=>commit(input,policy,active);
 try {
  await commitCookingWithPolicy({runtime,service:peer.service,input:{operationId:'old-child',command,deviceSequence:1}});
 } finally {
  peer.storage.commitLocalWithDisclosurePolicy=commit;
 }
 const retained=peer.rows();
 peer.reopen();
 await assert.rejects(()=>openSelectedRecipeCatalog(peer.runtime),/UNSUPPORTED_VERSION/);
 await assert.rejects(()=>openSelectedRecipeCatalog(peer.runtime,'retained-child'),/UNSUPPORTED_VERSION/);
 assert.equal((await openSelectedRecipeCatalog(peer.runtime,'different-recipe')).children.size,0);
 assert.equal(projectCooking((await runtime.document()).doc).recipes[0].title,'Retained soup');
 assert.deepEqual(peer.rows(),retained);
});
test('incomplete source replay uses the exact retained checkpoint',async t=>{
 const [peer]=await household(t);
 await peer.edit('legacy-source',1,{legacy:true});
 const context=await peer.service.authority();
 const document=peer.runtime.document.bind(peer.runtime);
 peer.runtime.document=async()=>{
  const retained=await document();
  assert.ok(retained.storedBytes?.length);
  retained.doc.export=()=>{throw Error('A newly exported snapshot is not the retained checkpoint');};
  return retained;
 };
 const source=await createSourceVerifier({runtime:peer.runtime,service:peer.service,context,allowIncomplete:true})('legacy-source');
 assert.deepEqual(source,{policies:[],incomplete:true});
});

async function confirmation(receiver,deviceId) {
  const row = (await receiver.trust.list()).find(item => item.deviceId === deviceId);
  assert.ok(row);
  return {deviceId,confirmation:row.confirmation,explicit:true};
}
async function stage(receiver,item,source) {
  const authority = await receiver.runtime.authorize();
  return receiver.storage.stageInbox({scopeId:scope.id,object:{id:item.itemId,bytes:item.bytes},
    source:`${source}:${item.itemId}`,cursor:item.itemId,expectedCursor:null},authority,'device-0');
}

test('same-author file and staged direct work cannot commit after a quarantine transition', {timeout:10000}, async t => {
  const [sender,receiver] = await household(t);
  const prior = await sender.edit('prior',1);
  const saved = await receiver.cooking.receive(prior.bytes);
  const fileItem = await sender.edit('file',3,{preview:true});
  const directItem = await sender.edit('direct',2);
  must(await stage(receiver,directItem,'direct'));
  const first = Promise.withResolvers(), second = Promise.withResolvers(), resume = Promise.withResolvers();
  const storage = receiver.storage, commit = storage.commitImportWithDisclosurePolicy.bind(storage);
  storage.commitImportWithDisclosurePolicy = async (...args) => {
    (args[0].itemId === directItem.itemId ? first : second).resolve();
    await resume.promise;
    return commit(...args);
  };
  const held = assert.rejects(receiver.cooking.applyStaged(directItem),/QUARANTINED/);
  await first.promise;
  const importing = assert.rejects(receiver.cooking.receive(fileItem.bytes),/QUARANTINED/);
  await second.promise;
  const reviewed = await confirmation(receiver,sender.deviceId);
  await receiver.trust.quarantine(reviewed);
  const quarantined = receiver.rows();
  resume.resolve();
  await Promise.all([held,importing]);
  assert.deepEqual(receiver.rows(),quarantined);
  for (const outcome of await receiver.cooking.pending()) assert.equal(outcome.reason,'QUARANTINED');
  assert.equal((await receiver.cooking.pending()).length,2);
  assert.deepEqual(await receiver.cooking.receive(prior.bytes),{outcome:saved.outcome,replayed:true});
  assert.deepEqual(receiver.rows(),quarantined);
});

test('fresh file staging and legacy application stop at their storage transaction', {timeout:10000}, async t => {
  const [sender,receiver] = await household(t);
  const prior = await sender.edit('prior',1,{legacy:true});
  must(await stage(receiver,prior,'direct'));
  const saved = await receiver.runtime.importItem(prior);
  const legacy = await sender.edit('legacy',2,{legacy:true});
  must(await stage(receiver,legacy,'direct'));
  const file = await sender.edit('file',3);
  const storage = receiver.storage, reviewed = await confirmation(receiver,sender.deviceId);
  const stageInbox = storage.stageInbox.bind(storage);
  const commitImport = storage.commitImport.bind(storage);
  const verifiedFile = Promise.withResolvers(), verifiedLegacy = Promise.withResolvers(), resume = Promise.withResolvers();
  storage.stageInbox = async (...args) => {
    verifiedFile.resolve();
    await resume.promise;
    return stageInbox(...args);
  };
  storage.commitImport = async (...args) => {
    verifiedLegacy.resolve();
    await resume.promise;
    return commitImport(...args);
  };
  const fileBlocked = assert.rejects(receiver.cooking.receive(file.bytes),/QUARANTINED/);
  const legacyBlocked = assert.rejects(receiver.runtime.importItem(legacy),/QUARANTINED/);
  await Promise.all([verifiedFile.promise,verifiedLegacy.promise]);
  await receiver.trust.quarantine(reviewed);
  const quarantined = receiver.rows();
  resume.resolve();
  await Promise.all([fileBlocked,legacyBlocked]);
  assert.deepEqual(receiver.rows(),quarantined);
  assert.deepEqual(await receiver.runtime.importItem(prior),{outcome:saved.outcome,replayed:true});
  const changed = new Uint8Array(prior.bytes);
  changed[0] ^= 1;
  await assert.rejects(receiver.runtime.importItem({...prior,bytes:changed}),/CONFLICT/);
  assert.deepEqual(receiver.rows(),quarantined);
});

test('quarantine rejects this device and rechecks household authority within its write transaction', async t => {
  const [sender,receiver] = await household(t);
  const self = await confirmation(receiver,receiver.deviceId);
  const target = await confirmation(receiver,sender.deviceId);
  const before = receiver.rows();
  await assert.rejects(receiver.trust.quarantine(self),/INVALID_QUARANTINE_DEVICE/);
  await assert.rejects(receiver.trust.quarantine({...target,deviceId:'unknown'}),/STALE_DEVICE_CONFIRMATION/);
  await assert.rejects(receiver.trust.quarantine({...target,explicit:false}),/STALE_DEVICE_CONFIRMATION/);
  assert.deepEqual(receiver.rows(),before);

  const storage = receiver.storage, record = must(await storage.readPairingAuthority(scope));
  const quarantine = storage.compromise.quarantine.bind(storage.compromise);
  storage.compromise.quarantine = async (...args) => {
    must(await storage.compareAndSwapPairingAuthority({expectedRevision:record.revision,record:{...record,revision:record.revision+1}}));
    return quarantine(...args);
  };
  await assert.rejects(receiver.trust.quarantine(target),/STALE_AUTHORITY/);
  assert.equal(await storage.compromise.isQuarantined(scope.id,sender.deviceId),false);
  assert.equal((await receiver.trust.list()).length,2);
});

test('signed report verifies exact bytes and durable retries without cooking side effects',async t => {
  const [reporter,receiver] = await household(t);
  const suspect = await receiver.edit('suspect operation',1);
  await reporter.cooking.receive(suspect.bytes);
  const dependent = {
    version:1,kind:'pantry-field',commandId:'dependent',effectId:'dependent',dependencyEffectIds:['suspect operation'],
    data:{itemId:'suspect operation',field:'preference',value:5,author:reporter.deviceId,at:'2026-01-01T00:00:00Z'}
  };
  await reporter.runtime.execute({operationId:'dependent',deviceSequence:1,command:dependent});
  const normalRows = peer => peer.rows().filter(row=>!['compromise-review','compromise-frozen-original'].includes(JSON.parse(row.key)[0]));
  const beforeReporter = normalRows(reporter), beforeReceiver = receiver.rows();
  const api = peer => householdCompromise({runtime:peer.runtime,withCurrent:use=>use(0),sha256:evidenceSha256});
  const source = api(reporter), destination = api(receiver);
  const origin = (await source.open()).confirmation, target = (await destination.open()).confirmation;
  const draft = await source.prepare(origin,receiver.deviceId);
  assert.deepEqual(normalRows(reporter),beforeReporter);
  const reviewId = await source.sign(draft,{kind:'operation',ref:suspect.itemId});
  let file;
  await source.share(origin,reviewId,async bytes=>{file=bytes;});
  assert.deepEqual(normalRows(reporter),beforeReporter);

  const decoded=decodeReportFile(file);
  const wrongSignature=structuredClone(decoded.report);
  wrongSignature.signature=(wrongSignature.signature[0]==='0'?'1':'0')+wrongSignature.signature.slice(1);
  await assert.rejects(destination.receive(target,encodeReportFile(wrongSignature,decoded.manifest,decoded.objects)),/INVALID_REPORT_SIGNATURE/);
  const wrongBoundary=structuredClone(decoded.report);
  wrongBoundary.payload.boundary.ref=decoded.objects.find(o=>o.objectId!==suspect.itemId).objectId;
  await assert.rejects(destination.receive(target,encodeReportFile(wrongBoundary,decoded.manifest,decoded.objects)),/INVALID_REPORT_SIGNATURE/);
  const changed = new Uint8Array(file);
  changed[changed.length-1]^=1;
  await assert.rejects(destination.receive(target,changed),/MANIFEST_MISMATCH/);
  await assert.rejects(destination.receive(target,encodeReportFile(decoded.report,[...decoded.manifest].reverse(),[...decoded.objects].reverse())),/MANIFEST_MISMATCH/);
  assert.deepEqual(receiver.rows(),beforeReceiver);

  const healthyStorage = receiver.storage.compromise;
  for(const failedWrite of [1,2]){
    let writes=0;
    const failing = new CompromiseReviews(healthyStorage.run,()=>{if(++writes===failedWrite)throw Error('FAULT');});
    receiver.storage.compromise=failing;
    await assert.rejects(api(receiver).receive(target,file),/FAULT/);
    assert.equal(writes,failedWrite);
    assert.deepEqual(receiver.rows(),beforeReceiver);
  }
  const authorityKey=JSON.stringify(['pairing-authority','household',scope.id]);
  let originalAuthority;
  const raced = new CompromiseReviews(async (write,use)=>{
    if(write)await healthyStorage.run(true,async tx=>{
      originalAuthority=await tx.get(authorityKey);
      await tx.put(authorityKey,{...originalAuthority,revision:originalAuthority.revision+1});
    });
    return healthyStorage.run(write,use);
  });
  receiver.storage.compromise=raced;
  await assert.rejects(api(receiver).receive(target,file),/STALE_AUTHORITY/);
  assert.equal(receiver.rows().some(row=>JSON.parse(row.key)[0]==='compromise-review'),false);
  await healthyStorage.run(true,tx=>tx.put(authorityKey,originalAuthority));
  assert.deepEqual(receiver.rows(),beforeReceiver);
  receiver.storage.compromise=healthyStorage;
  assert.deepEqual(await destination.receive(target,file),{reviewId,replayed:false});
  assert.deepEqual(normalRows(receiver),beforeReceiver);
  const saved=receiver.rows();
  const reopened=api(receiver), reopenedToken=(await reopened.open()).confirmation;
  assert.deepEqual(await reopened.receive(reopenedToken,file),{reviewId,replayed:true});
  assert.deepEqual(receiver.rows(),saved);
  const view=await reopened.inspect(reopenedToken,reviewId);
  assert.equal(view.count,2);
  assert.deepEqual(view.rows.map(({category,authorDevice})=>[category,authorDevice]).sort(),[
    ['dependent',reporter.deviceId],['suspect',receiver.deviceId]
  ]);
  assert.equal(view.rows.find(row=>row.objectId===suspect.itemId).boundary,true);
  await receiver.edit('later evidence',2);
  assert.deepEqual(await reopened.inspect(reopenedToken,reviewId),view);
  assert.equal(await receiver.storage.compromise.isQuarantined(scope.id,reporter.deviceId),false);

  const originalKey=JSON.stringify(['compromise-frozen-original',scope.id,reviewId]);
  await healthyStorage.run(true,async tx=>{
    const snapshot=await tx.get(originalKey);
    snapshot.objects[0][0]^=1;
    snapshot.checkpoint=Uint8Array.of(1);
    await tx.put(originalKey,snapshot);
  });
  const incomplete=await reopened.inspect(reopenedToken,reviewId);
  assert.equal(incomplete.count,2);
  assert.equal(incomplete.rows.length,1);
  assert.equal(incomplete.missing.length,1);
  assert.equal(incomplete.checkpointUnavailable,true);
  assert.equal(incomplete.rows[0].category,'suspect');
  await assert.rejects(reopened.receive(reopenedToken,file),/CONFLICT/);
});

test('force report preflight before crypto and reject a stale boundary or file selection',async t => {
  const [reporter,receiver]=await household(t);
  let selected=0, unauthorizedCalls=0;
  const api = householdCompromise({runtime:reporter.runtime,withCurrent:use=>use(selected)});
  const token=(await api.open()).confirmation;
  const draft=await api.prepare(token,receiver.deviceId);
  assert.equal(draft.checkpoint,'Pinned household starting checkpoint');
  selected++;
  await assert.rejects(api.sign(draft,{kind:'checkpoint'}),/STALE_REPORT_SELECTION/);
  assert.equal((await api.open()).reports.length,0);
  selected--;
  const first = await api.sign(draft,{kind:'checkpoint'});
  let file;
  await api.share(token,first,async bytes=>{file=bytes;});
  const destination=householdCompromise({runtime:receiver.runtime,withCurrent:use=>use(selected)});
  const target=(await destination.open()).confirmation;
  selected++;
  const original=receiver.rows();
  await assert.rejects(destination.receive(target,file),/STALE_REPORT_SELECTION/);
  assert.deepEqual(receiver.rows(),original);
  const freshTarget=(await destination.open()).confirmation;
  assert.deepEqual(await destination.receive(freshTarget,file),{reviewId:first,replayed:false});
  const inspected=await destination.inspect(freshTarget,first);
  assert.equal(inspected.checkpointLabel,'Pinned household starting checkpoint');
  assert.equal(inspected.count,0);

  const secondDraft=await api.prepare((await api.open()).confirmation,receiver.deviceId);
  const second=await api.sign(secondDraft,{kind:'checkpoint'});
  let newFile;
  await api.share((await api.open()).confirmation,second,async bytes=>{newFile=bytes;});

  const authorize = receiver.runtime.authorization.bind(receiver.runtime);
  receiver.runtime.authorization = async ()=>{unauthorizedCalls++;return authorize();};
  await assert.rejects(destination.receive(target,new Uint8Array(REPORT_FILE_LIMIT+1)),/INVALID_REPORT_FILE_SIZE/);
  const slots=receiver.storage.compromise;
  await slots.run(true,async tx=>{
    for(let i=0;i<15;i++)await tx.put(JSON.stringify(['compromise-frozen-original',scope.id,`existing-${i}`]),[]);
  });
  const capacity = receiver.rows();
  await assert.rejects(destination.receive(freshTarget,newFile),/REPORT_CAPACITY/);
  await assert.rejects(destination.prepare(freshTarget,reporter.deviceId),/REPORT_CAPACITY/);
  assert.equal(unauthorizedCalls,0);
  assert.deepEqual(await destination.receive(freshTarget,file),{reviewId:first,replayed:true});
  assert.deepEqual(receiver.rows(),capacity);
});

test('clean draft rechecks the selected document and exact frozen bytes before a durable retry',async t => {
  const [author,suspect]=await household(t);
  const original=await suspect.edit('original saffron',1);
  await author.cooking.receive(original.bytes);
  const api=householdCompromise({runtime:author.runtime,withCurrent:use=>use(0)});
  const token=(await api.open()).confirmation;
  const proposal=await api.prepare(token,suspect.deviceId);
  const id=await api.sign(proposal,{kind:'operation',ref:original.itemId});
  const stale=await api.inspect(token,id);
  await author.edit('later oregano',1);
  const afterEdit=author.rows();
  await assert.rejects(api.saveCleanDraft(stale,['original saffron']),/STALE_DOCUMENT/);
  assert.deepEqual(author.rows(),afterEdit);

  const fresh=await api.inspect(token,id);
  const store=author.storage.compromise;
  const key=JSON.stringify(['compromise-frozen-original',scope.id,id]);
  const frozen=await store.run(false,tx=>tx.get(key));
  const damaged=structuredClone(frozen);
  damaged.objects[0][0]^=1;
  await store.run(true,tx=>tx.put(key,damaged));
  const afterDamage=author.rows();
  await assert.rejects(api.saveCleanDraft(fresh,['original saffron']),/STALE_EVIDENCE/);
  assert.deepEqual(author.rows(),afterDamage);
  assert.equal((await api.inspect(token,id)).canSave,false);
  await store.run(true,tx=>tx.put(key,frozen));

  const result=await api.saveCleanDraft(fresh,['original saffron']);
  assert.deepEqual(result.draft.pantry,['original saffron']);
  assert.equal(result.draft.included[0].objectId,original.itemId);
  const saved=author.rows();
  assert.deepEqual(saved.filter(row=>JSON.parse(row.key)[0]!=='compromise-review'),
    afterEdit.filter(row=>JSON.parse(row.key)[0]!=='compromise-review'));
  assert.deepEqual(await api.saveCleanDraft(fresh,['original saffron']),result);
  await assert.rejects(api.saveCleanDraft(fresh,[]),/STALE_REVIEW/);
  assert.deepEqual(author.rows(),saved);
  await author.edit('after saved draft',2);
  const changedDocument=author.rows();
  await assert.rejects(api.saveCleanDraft(fresh,['original saffron']),/STALE_DOCUMENT/);
  const rechecked=await author.runtime.document();
  const retryDraft=async()=>store.finalizeHistorical({runtime:author.runtime,reviews:store,scopeId:scope.id,reviewId:id,
    expected:await store.get(scope.id,id),expectedDocumentRevision:rechecked.revision,selectedEffectIds:['original saffron']});
  await assert.rejects(retryDraft(),/DRAFT_SOURCE_CHANGED/);
  assert.deepEqual(author.rows(),changedDocument);
  assert.deepEqual((await api.inspect(token,id)).draft,result.draft);

  const draftKey=JSON.stringify(['compromise-review',scope.id,id]);
  const savedDraft=await store.get(scope.id,id);
  const legacyDraft=structuredClone(savedDraft);
  delete legacyDraft.draft.publicationBaseRevision;
  await store.run(true,tx=>tx.put(draftKey,legacyDraft));
  const beforeLegacyRetry=author.rows();
  await assert.rejects(retryDraft(),/DRAFT_SOURCE_CHANGED/);
  assert.deepEqual(author.rows(),beforeLegacyRetry);
  await store.run(true,tx=>tx.put(draftKey,savedDraft));
});

test('saved reports at a legacy policy head remain readable without enabling reconstruction',async t=>{
  const [author,suspect]=await household(t);
  const original=await suspect.edit('legacy saffron',1,{legacy:true});
  const {runtime:parent,storage,deviceId}=author;
  const {provider,rootPin:pin}=parent.authority;
  const {signingKeyRefs}=await parent.authorization();
  const event={version:1,kind:'changePolicy',householdId:scope.id,parentHead:pin,proposalId:'legacy-rule',
    authorDeviceId:deviceId,policyHash:parent.scope.policyHashes[0],nextPolicy:{kind:'fixed',fixedCount:1},subject:null,
    suiteId:parent.scope.suiteId,generation:1,epochId:parent.scope.epochId,frozenAdultRoster:['adult']};
  const signature=(label,value)=>provider.sign(signingKeyRefs[deviceId],domain(label,value)).then(sodium.to_hex);
  const eventHash=sodium.to_hex(await provider.hash(domain('event',event)));
  const approval={version:1,householdId:scope.id,eventHash,parentHead:pin,policyHash:event.policyHash,
    generation:event.generation,epochId:event.epochId,adultId:'adult',deviceId};
  const approvals=[{...approval,signature:await signature('approval-signature',approval)}];
  const head=await observeSuccessor(storage,scope,pin,provider,{event,authorSignature:await signature('event-signature',event),approvals});
  const selection={from:pin,to:head,deviceId,index:0};
  await writeFixtureSelection(storage,scope,pin,provider,{...selection,
    signature:await signature('select-head',{root:pin,householdId:scope.id,...selection})});
  const resolved=await resolveRuntimeAuthority(storage,scope,pin,provider,deviceId);
  const runtime=new OfflineRuntime({storage,codec:parent.codec,LoroDoc,decodeImportBlobMeta,scope:resolved.scope,
    keyRef:parent.keyRef,authority:{...parent.authority,selectionIndex:resolved.selectionIndex}});
  const {header,value}=await parent.codec.openContent(original.bytes,signingKeyRefs);
  const object=await parent.codec.sealContent({...header,branchHead:head,policyHashes:runtime.scope.policyHashes,
    documentId:runtime.scope.documentId},value,runtime.keyRef,signingKeyRefs[suspect.deviceId]);
  const reviewId=crypto.randomUUID(),checkpoint=new Uint8Array(),checkpointHash=await evidenceSha256(checkpoint);
  const objects=[{sourceId:'inbox',objectId:object.id,bytes:object.bytes}];
  const manifest=[{sourceId:'inbox',objectId:object.id,bytes:object.bytes.length,hash:await evidenceSha256(object.bytes)}];
  const authority=await runtime.authorize();
  const context={kind:'household',scopeId:scope.id,authorityHead:head,authorityRevision:authority.record.revision,
    authoritySnapshot:authority.record.authorizationSnapshot,checkpointHash};
  const payload={version:1,reportId:reviewId,reviewId,scopeId:scope.id,scopeKind:'household',head,
    reporterDevice:deviceId,suspectDeviceIds:[suspect.deviceId],checkpointHash,manifestHash:await manifestDigest(manifest),
    boundary:{kind:'operation',ref:object.id}};
  const report={payload,signature:sodium.to_hex(await provider.sign(signingKeyRefs[deviceId],reportMessage(payload)))};
  await storage.compromise.freeze({reviewId,runtime,context,report,objects,checkpointBytes:checkpoint,isolated:true,requireStored:false});
  const api=householdCompromise({runtime,withCurrent:use=>use(0)}),token=(await api.open()).confirmation;
  const before=author.rows(),view=await api.inspect(token,reviewId);
  assert.equal(view.unsupported,true);
  assert.equal(view.canSave,false);
  assert.equal(view.checkpointUnavailable,false);
  assert.deepEqual(view.missing,[]);
  assert.deepEqual(view.rows.map(row=>[row.effectId,row.category,row.selectable]),[['legacy saffron','suspect',false]]);
  await assert.rejects(api.saveCleanDraft(view,['legacy saffron']),/STALE_REVIEW/);
  assert.deepEqual(author.rows(),before);
});

test('checkpoint report authentication and limits precede document reads, and overlapping effects stay ambiguous',async t=>{
  const [reporter,receiver]=await household(t);
  const suspect=await receiver.edit('checkpoint overlap',1);
  await reporter.cooking.receive(suspect.bytes);
  await reporter.runtime.execute({operationId:'depends',deviceSequence:1,command:{
    version:1,kind:'pantry-field',commandId:'depends',effectId:'depends',dependencyEffectIds:['checkpoint overlap'],
    data:{itemId:'checkpoint overlap',field:'preference',value:5,author:reporter.deviceId,at:'2026-01-01T00:00:00Z'}
  }});
  const api=peer=>householdCompromise({runtime:peer.runtime,withCurrent:use=>use(0)});
  const source=api(reporter),destination=api(receiver);
  const origin=(await source.open()).confirmation,target=(await destination.open()).confirmation;
  const draft=await source.prepare(origin,receiver.deviceId);
  const reviewId=await source.sign(draft,{kind:'checkpoint'});
  let file;
  await source.share(origin,reviewId,async bytes=>{file=bytes});

  // Model the verified projection boundary at the runtime/storage interface.
  const checkpointDoc=await receiver.runtime.document();
  const seed={snapshot:new Uint8Array(REVIEW_LIMITS.bytes),seed:{identities:[{effectId:'checkpoint overlap'}]}};
  let documentReads=0;
  receiver.storage.readProjectionSeed=async()=>({ok:true,value:seed});
  receiver.runtime.document=async()=>{documentReads++;return checkpointDoc};
  const {report,manifest,objects}=decodeReportFile(file);
  const bad={...report,signature:(report.signature[0]==='0'?'1':'0')+report.signature.slice(1)};
  const original=receiver.rows();
  await assert.rejects(destination.receive(target,encodeReportFile(bad,manifest,objects)),/INVALID_REPORT_SIGNATURE/);
  await assert.rejects(destination.receive(target,file),/TOO_LARGE/);
  assert.equal(documentReads,0);
  assert.deepEqual(receiver.rows(),original);

  seed.snapshot=new Uint8Array(1);
  await assert.rejects(destination.receive(target,file),/CHECKPOINT_MISMATCH/);
  assert.deepEqual(receiver.rows(),original);
  seed.snapshot=new Uint8Array();
  await destination.receive(target,file);
  const {rows}=await destination.inspect(target,reviewId);
  assert.equal(rows.find(row=>row.objectId===suspect.itemId).category,'suspect');
  assert.deepEqual(rows.filter(row=>row.effectId==='depends').map(row=>[row.category,row.missingDependencies]),[['other',1]]);
});
