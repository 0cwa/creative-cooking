import {publishOwnDeviceSet,captureOwnDeviceCopySet,installOwnDeviceSetFile,reopenOwnDeviceSet,sealOwnDeviceSetFile,verifyOwnDeviceCopySet,verifyOwnDeviceSetSuccessor,withOpenedOwnDeviceSetFile} from '../pairing/household-own-device-set.mjs';
import {openDeviceCopy,pairingDigest,sealDeviceCopy} from '../pairing/personal-copy.mjs';
import {verifyOwnDeviceSuccessor} from '../pairing/household-own-device.mjs';
import {ownDeviceSignal} from '../authority/own-device.mjs';
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
import {openWorkspaceHouseholdRuntime,resolveOriginalHousehold} from './workspace-household-runtime.mjs';
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
import {prepareCurrentDocumentSet,requirePublicRecipeHistory,verifyCurrentDocumentSet,verifyCurrentDocumentSetSource} from '../projection/current-document-set.mjs';
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
async function household(t,{onDisk=false}={}) {
  await sodium.ready;
  const dataKey = sodium.randombytes_buf(32);
  const signing = [sodium.crypto_sign_keypair(),sodium.crypto_sign_keypair()];
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
    runtime:{documentId:'cooking',authorPeers:{'device-0':'1','device-1':'2'},acceptedRecipients:['device-0','device-1']}
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
      deviceId,storage,runtime,trust,cooking,service,root,provider,connection,signingTestKey:signing[index],
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
 const siblings=await edit(a,sibling,'sibling-create',recipe('sibling','Spare carrot'));
 const legacy=await edit(a,a.runtime,'legacy-recipe',recipe('legacy','Onion'));
 await send(a,b,'sibling-create');
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
 await edit(a,inserted,'source-set-catalog-race',{...recipe(omittedRecipeId,'Third carrot'),
  ingredients:[{id:omittedIngredientId,name:'Third carrot',amount:'1 cup'}]});
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
 const prepare=()=>prepareCurrentDocumentSet({runtime:a.runtime,service:a.service,item:admissionItem,allocateSeed});
 const prepared=await prepare();
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
   authorizationSnapshot:authority.authorizationSnapshot,signaling:[signal(context)],
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
 await sponsor.files.receive(await newcomer.files.download(pantryObjectId));
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
  const [copy]=objects;
  const auth=await sponsor.runtime.authorization();
  const opened=await sponsor.runtime.codec.openContent(copy.bytes,auth.signingKeyRefs);
  assert.equal(opened.header.disclosureIncomplete,true);
  assert.deepEqual(opened.header.disclosurePolicyHashes,[accepted.policyHash]);
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
  const beforeSetWrite=a.rows();
  a.faultAt('household-own-device-set');
  assert.equal((await a.storage.commitHouseholdOwnDeviceSet(publication)).error.code,'IO');
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
  const published=await publishOwnDeviceSet({...fileOptions,storage:publishStorage,next:copyTransition.next,captured:capturedCopy,
   signingSecret:sponsorKeys.signingSecret,keys:publishStorage.localKeys(sponsorMaster,sodium),deviceId:a.deviceId});
  assert.equal(published.head,signedCopy.head);
  const pairingFile=published.file;
  assert.ok(pairingFile.length>112);
  const sourceKeyHash=await sponsorCatalog.useIdentity({version:1,scope,deviceId:a.deviceId,purpose:'data',epochId:parent.epochId},
   key=>pairingDigest(sodium,key));
  await withOpenedOwnDeviceSetFile({...fileOptions,file:pairingFile,wrappingSecret:nextWrap.privateKey,withKeys:({keys})=>{
   const hashes=keys.map(({key})=>pairingDigest(sodium,key));
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
  await assert.rejects(()=>publishOwnDeviceSet({...fileOptions,next:copyTransition.next,captured:capturedCopy,
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
