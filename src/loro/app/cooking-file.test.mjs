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
import {acceptAdmissionAgreement,initializeAuthority,observeSuccessor,policyId,resolveRuntimeAuthority,rootPin} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {writeFixtureSelection} from '../authority/chain-test-fixture.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {testProvider} from '../crypto/test-provider.mjs';
import {commitCookingWithPolicy} from '../disclosure/cooking.mjs';
import {createSourceVerifier} from '../disclosure/source-proof.mjs';
import {acceptInitialPolicy,prepareInitialPolicy} from '../disclosure/setup.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {householdLocalTrust} from './household-local-trust.mjs';
import {executeAction} from './action.mjs';
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
import {prepareCurrentDocumentSet,verifyCurrentDocumentSet,verifyCurrentDocumentSetSource} from '../projection/current-document-set.mjs';
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
    const storage = openSQLiteStorage({executeSync(sql,params = []) {
      const statement = db.prepare(sql);
      return {rows:sql.startsWith('SELECT') ? statement.all(...params) : (statement.run(...params),[])};
    }}, boundary => {if (boundary === fault) throw Error('injected failure');});
    const deviceId = `device-${index}`;
    await initializeAuthority(storage,root,root.head,provider);
    const resolved = await resolveRuntimeAuthority(storage,scope,root.head,provider,deviceId);
    const runtime = new OfflineRuntime({storage,codec:candidateCodec(provider),LoroDoc,decodeImportBlobMeta,
      scope:resolved.scope,keyRef:root.epochId,authority:{rootPin:root.head,provider}});
    const service = disclosureService({storage,scope,rootPin:root.head,provider,deviceId});
    const cooking = cookingFiles({runtime,service});
    const trust = householdLocalTrust({runtime,withCurrent:use => use(0)});
    return {
      deviceId,storage,runtime,trust,cooking,service,root,provider,
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

test('pinned recipe documents retain competing encrypted edits independently and roll back failed writes',async t=>{
 const [a,b]=await household(t,{onDisk:true});
 const files=peer=>cookingFiles({runtime:peer.runtime,service:peer.service,recipeCatalogVersion:1});
 const recipes=(runtime)=>runtime.document().then(({doc})=>projectCooking(doc).recipes);
 const at='2026-01-01T00:00:00Z';
 const makeRecipe=(id,title)=>({id,title,portions:2,ingredients:[{id:'i',name:'Carrot'}],steps:['Slice'],stepIds:['s'],createdAt:at,updatedAt:at});
 const change=async(peer,runtime,actionId,patch)=>{
  const {doc}=await runtime.document(),before=projectCooking(doc).recipes.find(x=>x.id===patch.id)??null;
  return planRecipeAction({doc,before,after:{...before,...patch},actionId,author:peer.deviceId,at});
 };
 const execute=(peer,runtime,id,commands)=>executeAction(runtime,{reserve:async(_scope,key)=>sequences.get(key)??sequences.set(key,++sequence).get(key)},id,commands,peer.service);
 let sequence=0;
 const sequences=new Map();
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
 const duplicateChild=await b.runtime.forRecipe('legacy');
 const duplicateCreate=await change(b,duplicateChild,'duplicate-child',makeRecipe('legacy','Duplicate child recipe'));
 await assert.rejects(()=>execute(b,duplicateChild,'duplicate-child',duplicateCreate),/CONFLICT/);
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

 const create=await change(a,ar,'create',makeRecipe('r','Soup'));
 await assert.rejects(()=>execute(a,other,'wrong-recipe',create),/INVALID_RECIPE_DOCUMENT/);
 const beforeCreate=a.rows();
 for(const fault of ['recipe-catalog','disclosure-local']){
  a.faultAt(fault);
  await assert.rejects(()=>execute(a,ar,'create',create),/IO/);
  assert.equal((await ar.document()).revision,null);
  assert.equal(must(await a.storage.getLocalOperation(scope.id,'create')),null);
  assert.equal((await openSelectedRecipeCatalog(a.runtime)).children.size,0);
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
 await assert.rejects(()=>execute(a,ar,'create',create),/CONFLICT/);
 assert.equal((await openSelectedRecipeCatalog(a.runtime)).children.size,0);
 assert.equal((await ar.document()).revision,null);
 await execute(a,ar,'create',create);
 const [initial]=await exported(a,'create');
 const savedCreate=must(await a.storage.getLocalOperation(scope.id,'create')).commit.outbound[0].object.id;
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
 const retainedCreate=await execute(a,ar,'create',create);
 assert.equal(retainedCreate.replayed,true);
 assert.deepEqual(await exported(a,'create'),[initial]);
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
  {...opened.header,documentGeneration:0},
  {...opened.header,epochId:'old-epoch'},
 ]){
  const forged=await ar.codec.sealContent(header,opened.value,ar.keyRef,signing);
  await assert.rejects(()=>files(b).receive(forged.bytes),/INVALID_AUTHORITY|INVALID_RECIPE_DOCUMENT/);
 }
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
test('selected recipe shopping copies authenticate causal fields and commit across durable peers',async t=>{
 const [a,b]=await household(t,{onDisk:true});
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
 const inserted=await a.runtime.forRecipe('third');
 await edit(a,inserted,'source-set-catalog-race',recipe('third','Third carrot'));
 assert.equal((await checkGuard(beforeInsert)).error.code,'CONFLICT');
 const afterInsert=await observeSelectedSourceSet(a.runtime);
 assert.equal(afterInsert.signed.manifest.catalog.revision,3);
 assert.equal(afterInsert.signed.manifest.root.revision,beforeInsert.root.revision);
 const head=must(await a.storage.readPairingAuthority(scope));
 const staleSingleDocument=await a.storage.compareAndSwapPairingAuthority({expectedRevision:head.revision,
  record:{...head,revision:head.revision+1,acceptedParent:'different-head'}});
 assert.equal(staleSingleDocument.error,'UNSUPPORTED_VERSION');
 assert.deepEqual(must(await a.storage.readPairingAuthority(scope)),head);

 const {doc:thirdDoc}=await inserted.document();
 await save(a,inserted,'remove-entire-child',planRecipeAction({doc:thirdDoc,before:projectCooking(thirdDoc).recipes[0],
  after:null,actionId:'remove-entire-child',author:a.deviceId,at}));
 await edit(a,sibling,'first-sibling-title',{id:'sibling',title:'SUPERSEDED_SIBLING_TITLE'});
 await edit(a,sibling,'replace-sibling-title',{id:'sibling',title:'New sibling title'});
 const beforeIngredient=projectCooking((await ar.document()).doc).recipes[0];
 await edit(a,ar,'ingredient-canary',{id:recipeId,
  ingredients:[...beforeIngredient.ingredients,{id:'removed-ingredient',name:'HIDDEN_INGREDIENT_TEXT'}]});
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
  for(const canary of ['HIDDEN_INGREDIENT_TEXT','removed-ingredient','Third carrot',
   'SUPERSEDED_SIBLING_TITLE','recipe-intentions','recipeSource']){
   assert.equal(ops.includes(canary),false,canary);
  }
  return doc;
 });
 const links=items=>items.map(({id,recipeId,ingredientId,displayQuantity})=>({id,recipeId,ingredientId,displayQuantity}));
 assert.deepEqual(links(projectCooking(fresh[0]).shopping.items),links((await shopping(a.runtime)).items));
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
