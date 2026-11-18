import {householdCompromise} from './household-compromise.mjs';
import {CompromiseReviews,REVIEW_LIMITS} from '../compromise/review.mjs';
import {decodeReportFile,encodeReportFile,REPORT_FILE_LIMIT} from '../compromise/report-file.mjs';
import {evidenceSha256,manifestDigest,reportMessage} from '../compromise/report.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {cookingFiles} from './cooking-file.mjs';
import {MAX_OBJECT} from '../transport/adapter.mjs';
import {DatabaseSync} from 'node:sqlite';
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';
import sodium from 'libsodium-wrappers';
import {initializeAuthority,observeSuccessor,policyId,resolveRuntimeAuthority,rootPin} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {writeFixtureSelection} from '../authority/chain-test-fixture.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {testProvider} from '../crypto/test-provider.mjs';
import {commitCookingWithPolicy} from '../disclosure/cooking.mjs';
import {createSourceVerifier} from '../disclosure/source-proof.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {householdLocalTrust} from './household-local-trust.mjs';
import {executeAction} from './action.mjs';
import {planRecipeAction} from './recipe-actions.mjs';
import {planRecipeRestore,readRecipeHistory} from '../domain/recipe-history.mjs';
import {projectCooking} from '../domain/app-projection.mjs';
import {projectCurrentSeed} from '../compromise/current-seed.mjs';
import {recipeDocumentId} from '../domain/recipe-document.mjs';
import {replayAuthenticated} from '../domain/replay.mjs';
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
async function household(t) {
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
  return Promise.all(signing.map(async (_pair,index) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
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
 const [a,b]=await household(t);
 const files=peer=>cookingFiles({runtime:peer.runtime,service:peer.service,recipeDocuments:true});
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
 a.faultAt('disclosure-local');
 await assert.rejects(()=>execute(a,ar,'create',create),/IO/);
 assert.equal((await ar.document()).revision,null);
 assert.equal(must(await a.storage.getLocalOperation(scope.id,'create')),null);
 assert.deepEqual(a.rows(),beforeCreate);
 a.faultAt(null);
 await execute(a,ar,'create',create);
 const [initial]=await exported(a,'create');
 await assert.rejects(()=>b.cooking.receive(initial),/INVALID_AUTHORITY/);
 await files(b).receive(initial);
 const unrelated=await change(a,other,'unrelated',makeRecipe('unrelated','Unrelated canary'));
 await execute(a,other,'unrelated',unrelated);
 const [unrelatedBytes]=await exported(a,'unrelated');
 await files(b).receive(unrelatedBytes);
 const otherB=await b.runtime.forRecipe('unrelated');
 const unrelatedBefore=must(await b.storage.reopenBranchDocument(await b.runtime.authorize(),otherB.scope.documentId));
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

 const {doc}=await (await b.runtime.forRecipe('r')).document();
 const history=readRecipeHistory(doc,'r');
 const loser=history.find(row=>row.field==='title'&&row.status==='competing');
 assert.ok(loser);
 assert.throws(()=>planRecipeRestore({doc,recipeId:'r',effectId:loser.effectId,expectedHead:'stale'}),/history changed/);
 const restore=planRecipeRestore({doc,recipeId:'r',effectId:loser.effectId,expectedHead:loser.head,actionId:'restore',author:b.deviceId,at});
 await execute(b,br,'restore',[restore]);
 for(const bytes of await exported(b,'restore')) await files(a).receive(bytes);
 assert.equal((await recipes(await a.runtime.forRecipe('r')))[0].title,loser.value);
 assert.equal((await recipes(br))[0].title,loser.value);

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
