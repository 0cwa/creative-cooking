/** Research baseline handoff only: engine operations/causality are NOT translated. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as E from './engines.mjs';
import { fingerprint, importV1, namespace, validateDocument } from './schema.mjs';
import { serializeBackupEnvelope } from '../../src/storage/backupFormat.ts';
import { DEFAULT_STATE } from '../../src/domain/defaults.ts';
import { makeEnvelope, verifyEnvelope } from './durable.mjs';

const space = namespace('personal', 'engine-exit-fixture');
const state = structuredClone(DEFAULT_STATE);
const when = '2026-10-12T00:00:00Z';
state.pantry = [1,2].map(n => ({id:'carrot-'+n,name:'carrot',preference:n===1?2:5,createdAt:when,updatedAt:when}));
state.recipes = [{id:'r1',title:'Toast',portions:2,ingredients:[{name:'bread',amount:'2 slices'}],steps:['Toast bread.','Serve.'],createdAt:when,updatedAt:when}];
state.chatMessages = [{id:'m1',role:'user',content:'Toast tonight?',createdAt:when}];
state.activeConversationId = 'c1';
const baseline = importV1(serializeBackupEnvelope(state,when), space).document;
const recipeId = Object.keys(baseline.recipes)[0];
const ids = {recipeId,stepId:baseline.recipes[recipeId].stepOrder[1]};

function capsule(active) {
  const logicalDocument = E.read(active.engine,active.doc,space);
  validateDocument(logicalDocument,space);
  const fullSnapshot = Buffer.from(E.snapshot(active.engine,active.doc));
  const body = {
    format:'creative-cooking-baseline-handoff-research',version:1,schemaVersion:2,
    logicalDocument,reviewLedger:structuredClone(active.reviewLedger),
    source:{engine:active.engine,engineVersion:E.ENGINE_VERSIONS[active.engine],
      epoch:active.epoch,frontier:E.frontier(active.engine,active.doc)},
    archives:[...active.archives,{engine:active.engine,epoch:active.epoch,
      fullSnapshotBase64:fullSnapshot.toString('base64'),digest:fingerprint([...fullSnapshot])}],
    limitation:'Source operations and causal frontiers remain opaque archived evidence; target begins new causal history.'
  };
  return {...body,digest:fingerprint(body)};
}
function handoff(bundle,targetEngine) {
  const {digest,...body} = JSON.parse(JSON.stringify(bundle));
  assert.equal(digest,fingerprint(body),'corrupted handoff');
  assert.equal(body.format,'creative-cooking-baseline-handoff-research');
  assert.equal(body.version,1);assert.equal(body.schemaVersion,2);
  validateDocument(body.logicalDocument,space);
  const doc = E.load(targetEngine,E.snapshot(targetEngine,E.seed(targetEngine,body.logicalDocument)));
  assert.deepEqual(E.read(targetEngine,doc,space),body.logicalDocument);
  // Production activation MUST authenticate membership/cutover and atomically persist
  // baseline + ledger + epoch. This process-local experiment proves neither.
  return {engine:targetEngine,epoch:randomUUID(),doc,
    reviewLedger:structuredClone(body.reviewLedger),archives:body.archives};
}
function receive(active,frame) {
  // Crucial even after switching back: engine/schema/space alone are insufficient.
  assert.equal(frame.replicationEpoch,active.epoch,'OLD_REPLICATION_EPOCH');
  verifyEnvelope(frame.update,active.engine,space);
  const candidate = E.apply(active.engine,active.doc,frame.update.payload);
  E.read(active.engine,candidate,space);
  active.doc = candidate;
}

const results=[];
for(const sourceEngine of ['automerge','loro']) {
  const targetEngine=sourceEngine==='automerge'?'loro':'automerge';
  const seed=E.seed(sourceEngine,baseline);
  const phone=E.edit(sourceEngine,E.fork(sourceEngine,seed,'phone'),'phone','portions',ids,4);
  const tablet=E.edit(sourceEngine,E.fork(sourceEngine,seed,'tablet'),'tablet','portions',ids,6);
  let doc=E.merge(sourceEngine,phone,tablet);
  doc=E.edit(sourceEngine,doc,'receiver','reorder',ids);
  doc=E.edit(sourceEngine,doc,'receiver','stepEdit',ids,'Serve with herbs.');
  doc=E.edit(sourceEngine,doc,'receiver','delete',ids);
  const evidence=E.actualAlternatives(sourceEngine,doc,recipeId,'portions');
  assert.deepEqual(evidence.values.slice().sort(),[4,6]);
  const ledger=[{id:'review:'+fingerprint({sourceEngine,recipeId,operations:evidence.operationIds.slice().sort()}),
    sourceEngine,entityId:recipeId,path:['portions'],status:'unresolved',
    alternatives:evidence.values.map((value,i)=>({value,sourceOperationId:evidence.operationIds[i]})),
    sourceFrontier:evidence.frontier,completeness:'source-fixture-only'}];
  const original={engine:sourceEngine,epoch:randomUUID(),doc,reviewLedger:ledger,archives:[]};
  const first=capsule(original), target=handoff(first,targetEngine);
  assert.notEqual(target.epoch,original.epoch);
  assert.deepEqual(target.reviewLedger,ledger);
  const logical=E.read(sourceEngine,doc,space);
  assert.equal(logical.recipes[recipeId].deleted,true);
  const lateDoc=E.edit(sourceEngine,E.fork(sourceEngine,doc,'resolver'),'resolver','title',ids,'Late old-epoch title');
  const oldFrames=E.incremental(sourceEngine,doc,lateDoc).map(bytes=>({replicationEpoch:original.epoch,update:makeEnvelope(sourceEngine,space,bytes)}));
  for(const frame of oldFrames) assert.throws(()=>receive(target,frame),/OLD_REPLICATION_EPOCH/);
  const second=capsule(target), returned=handoff(second,sourceEngine);
  assert.deepEqual(E.read(sourceEngine,returned.doc,space),logical);
  assert.deepEqual(returned.reviewLedger,ledger);
  assert.equal(returned.archives.length,2);
  // Same-engine old frames must still fail after switching back.
  for(const frame of oldFrames) assert.throws(()=>receive(returned,frame),/OLD_REPLICATION_EPOCH/);
  const future=E.edit(sourceEngine,E.fork(sourceEngine,returned.doc,'resolver'),'resolver','title',ids,'New epoch title');
  for(const bytes of E.incremental(sourceEngine,returned.doc,future))
    receive(returned,{replicationEpoch:returned.epoch,update:makeEnvelope(sourceEngine,space,bytes)});
  assert.equal(E.read(sourceEngine,returned.doc,space).recipes[recipeId].title,'New epoch title');
  // Fresh target causal history cannot prove resolution of source-engine alternatives.
  assert.equal(returned.reviewLedger[0].status,'unresolved');
  const corrupt=structuredClone(first);corrupt.reviewLedger[0].status='resolved';
  assert.throws(()=>handoff(corrupt,targetEngine),/corrupted handoff/);
  results.push({direction:sourceEngine+'→'+targetEngine+'→'+sourceEngine,status:'PASS',
    checks:['full logical stable IDs/order/values/tombstones preserved','duplicate pantry identities preserved',
      'original unresolved evidence/provenance/frontier unchanged','full binary source archives retained',
      'old epoch frames rejected including after same-engine return','new epoch changes accepted',
      'tampered checkpoint rejected'],sourceFrontier:evidence.frontier,
    originalReviewEvidence:ledger,sourceBinaryBytes:Buffer.from(first.archives[0].fullSnapshotBase64,'base64').length,
    targetHasIndependentHistory:true});
}
mkdirSync(new URL('./artifacts/',import.meta.url),{recursive:true});
writeFileSync(new URL('./artifacts/engine-exit-results.json',import.meta.url),JSON.stringify({
  engineVersions:E.ENGINE_VERSIONS,results,
  nonclaims:['No lossless internal-operation translation','No old/new epoch delta bridge',
    'No real fleet cutover/key authorization','No platform atomic activation','No native engine runtime proof'],
  fleetPolicy:'Freeze old epoch writes, collect known peers to chosen source frontier, archive history, activate fresh epoch; unavailable peers later require explicit old-epoch edit export/review. Do not silently discard or replay them.'
},null,2)+'\n');
console.log(JSON.stringify({pass:results.length,fail:0,artifact:'artifacts/engine-exit-results.json'}));
