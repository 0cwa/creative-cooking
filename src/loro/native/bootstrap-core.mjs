import {householdCompromise} from '../app/household-compromise.mjs';
import {householdLocalTrust} from '../app/household-local-trust.mjs';
import {bindHouseholdContent} from '../app/household-content.mjs';
import {openWorkspaceHouseholdRuntime,resolveOriginalHousehold} from '../app/workspace-household-runtime.mjs';
import {openSQLiteStorage,openSQLiteTransaction,scheduleSQLite} from '../storage/sqlite.ts';
import {rootPin,policyId,initializeAuthority} from '../authority/chain.mjs';
import {personalRootPin,initializePersonalAuthority,resolvePersonalAuthority} from '../authority/personal.mjs';
import {domain} from '../authority/validator.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {localProvider} from '../app/local-provider.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {householdPairing as bindHouseholdPairing} from '../app/household-pairing.mjs';
import {bootstrapDisclosurePolicy} from '../app/bootstrap-policy.mjs';
import {subscribeActions} from '../app/action.mjs';
import {cookingFiles} from '../app/cooking-file.mjs';
import {openNativeHouseholdPersistence,returnToOriginalHousehold} from './household-persistence.mjs';
import {workspaceRecovery} from '../app/workspace-recovery.mjs';
import {personalPairing} from '../app/personal-pairing.mjs';
import {personalRotation} from '../app/personal-rotation.mjs';
import {openNativeSequences} from './sequences.mjs';
import {initialAdmissionPolicy} from '../app/admission-rule.mjs';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const aad=enc.encode('creative-cooking/native-bootstrap/v1');
const fields=['device','adult','house','personal','houseDoc','personalDoc','houseEpoch','personalEpoch'];
const valid=x=>typeof x==='string'&&/^[a-z0-9-]{1,100}$/.test(x);
const exec=(db,q,p=[])=>db.executeSync(q,p);
const rows=(db,q,p=[])=>exec(db,q,p).rows??[];
function transaction(db,fn){return scheduleSQLite(db,async()=>{exec(db,'BEGIN IMMEDIATE');try{const r=await fn();exec(db,'COMMIT');return r}catch(e){try{exec(db,'ROLLBACK')}catch{}throw e}})}
function check(r){if(!r||r.version!==1||!fields.every(k=>valid(r[k]))||new Set(fields.map(k=>r[k])).size!==fields.length)throw Error('LOCKED');return r}
const decode=bytes=>check(JSON.parse(dec.decode(bytes)));
const serial=new Map();
function serializeOpen(options) {
 const {name,create}=options;
 if(!valid(name)||typeof create!=='boolean')throw Error('MALFORMED');
 const previous=serial.get(name)??Promise.resolve();
 const current=previous.catch(()=>{}).then(()=>open(options));
 serial.set(name,current);
 current.finally(()=>{if(serial.get(name)===current)serial.delete(name)}).catch(()=>{});
 return current;
}
export async function openNativeWorkspaceWith(options) {
 return serializeOpen({...options,initialPolicy:initialAdmissionPolicy(options.policy),returnToOriginal:false});
}
export async function returnToOriginalNativeWorkspaceWith(options) {
 await serializeOpen({...options,create:false,returnToOriginal:true});
}
async function open({name,create,openDatabase,openMaster,sodium,LoroDoc,decodeImportBlobMeta,randomUUID,sha256,openDirect,returnToOriginal,initialPolicy}){
 await sodium.ready;const db=openDatabase(name);let master,sequences,pairing,joinedSequences;
 try {
  master=openMaster(name);
  if(returnToOriginal){
   const existing=rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('loro_bootstrap','loro_records')");
   if(!existing.some(row=>row.name==='loro_bootstrap'))throw Error('MISSING_BOOTSTRAP');
   if(existing.length!==2)throw Error('MISSING_AUTHORITY');
  }else exec(db,'CREATE TABLE IF NOT EXISTS loro_bootstrap (id INTEGER PRIMARY KEY CHECK(id=1), stage TEXT NOT NULL, data BLOB NOT NULL)');
  const storage=openSQLiteStorage(db);
  const load=()=>rows(db,'SELECT stage,data FROM loro_bootstrap WHERE id=1')[0];
  let state=await transaction(db,async()=>{
   let record=load();if(record)return record;
   if(!create)throw Error('MISSING_BOOTSTRAP');
   if(rows(db,'SELECT key FROM loro_records LIMIT 1').length || await master.exists('workspace-master'))throw Error('LOCKED');
   const r={version:1,admissionPolicy:initialPolicy};for(const key of fields)r[key]=sodium.to_hex(sodium.randombytes_buf(16));check(r);
   exec(db,'INSERT INTO loro_bootstrap VALUES (1,?,?)',['reserved',enc.encode(JSON.stringify(r))]);return load();
  });
  if(!['reserved','sealed','ready'].includes(state.stage)||returnToOriginal&&state.stage!=='ready')throw Error('LOCKED');
  let r;
  if(state.stage==='reserved'){
   await transaction(db,async()=>{const now=load();if(now.stage!=='reserved')return;if(rows(db,'SELECT key FROM loro_records LIMIT 1').length||rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('loro_sequence_counters','loro_sequence_allocations')").length)throw Error('LOCKED');const pending=decode(new Uint8Array(now.data));await master.ensure('workspace-master');const wrapped=await master.wrap('workspace-master',enc.encode(JSON.stringify({...pending,stage:'sealed'})),aad);exec(db,'UPDATE loro_bootstrap SET stage=?,data=? WHERE id=1',['sealed',wrapped]);});state=load();
  }
  const ready=state.stage==='ready';if(!['sealed','ready'].includes(state.stage))throw Error('LOCKED');
  try{const decoded=decode(await master.unwrap('workspace-master',new Uint8Array(state.data),aad));if(decoded.stage!==state.stage)throw Error('LOCKED');const {stage,...rest}=decoded;r=rest}catch{throw Error('LOCKED')}
  sequences=await scheduleSQLite(db,()=>openNativeSequences(db,[r.house,r.personal],!ready));
  const keys=storage.localKeys(master,sodium);if(ready)await keys.unlock();else await keys.provision('workspace-master');
  const identity=(kind,scopeId,purpose,epochId)=>({version:1,scope:{kind,id:scopeId},deviceId:r.device,purpose,epochId});
  const signing={operationId:'device-signing',identity:identity('personal',r.personal,'device-signing',r.personalEpoch)},wrapping={operationId:'device-wrapping',identity:identity('personal',r.personal,'device-wrapping',r.personalEpoch)},houseKey={operationId:'household-data',identity:identity('household',r.house,'data',r.houseEpoch)},personalKey={operationId:'personal-data',identity:identity('personal',r.personal,'data',r.personalEpoch)};
  let publicKey,wrappingPublicKey;
  if(ready){publicKey=await keys.use(signing.operationId,signing.identity,secret=>{const pair=sodium.crypto_sign_seed_keypair(secret.slice(0,32));pair.privateKey.fill(0);return pair.publicKey});wrappingPublicKey=await keys.use(wrapping.operationId,wrapping.identity,secret=>sodium.crypto_scalarmult_base(secret));await keys.use(houseKey.operationId,houseKey.identity,()=>{});await keys.use(personalKey.operationId,personalKey.identity,()=>{});}
  else {publicKey=(await keys.generate(signing.operationId,signing.identity)).publicKey;wrappingPublicKey=(await keys.generate(wrapping.operationId,wrapping.identity)).publicKey;await keys.generate(houseKey.operationId,houseKey.identity);await keys.generate(personalKey.operationId,personalKey.identity)}
  const signingRef=sodium.to_hex(publicKey),provider=localProvider(sodium,keys,{signing:{...signing,publicKey:signingRef},content:{[r.houseEpoch]:houseKey,[r.personalEpoch]:personalKey}});
  const policy=initialAdmissionPolicy(r.admissionPolicy),root={householdId:r.house,head:'',policyHash:await policyId(provider,policy),generation:1,epochId:r.houseEpoch,roster:[r.adult],devices:[{adultId:r.adult,deviceId:r.device,signingKeyRef:signingRef,active:true}],policy,runtime:{documentId:r.houseDoc,authorPeers:{[r.device]:'1'},acceptedRecipients:[r.device]}};root.head=await rootPin(provider,root);
  const personalRoot={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',scopeId:r.personal,ownerId:r.adult,signerDeviceId:r.device,devices:[{deviceId:r.device,ownerId:r.adult,signingKeyRef:signingRef,peerId:'2',active:true}],documentId:r.personalDoc,generation:1,epochId:r.personalEpoch},pin=await personalRootPin(provider,personalRoot),signature=sodium.to_hex(await provider.sign(signingRef,domain('personal-root-signature',personalRoot)));
  const ensure=async(scope,initialize)=>{const old=await storage.readPairingAuthority(scope);if(!old.ok)throw Error(old.error);if(!old.value){if(ready)throw Error('MISSING_AUTHORITY');try{await initialize()}catch(e){const raced=await storage.readPairingAuthority(scope);if(!raced.ok||!raced.value)throw e}}};
  await ensure({kind:'household',id:r.house},()=>initializeAuthority(storage,root,root.head,provider));
  await ensure({kind:'personal',id:r.personal},()=>initializePersonalAuthority(storage,{kind:'personal',id:r.personal},pin,provider,{version:1,root:personalRoot,signature}));
  const originalHouse=await resolveOriginalHousehold({storage,scope:{kind:'household',id:r.house},pin:root.head,
   provider,deviceId:r.device,sodium,LoroDoc});
  const originalPersonal={scopeId:r.personal,pin},personalSelection=await storage.readPersonalSelection(r.device);
  if(!personalSelection.ok)throw Error(personalSelection.error);
  const selectedPersonal=personalSelection.value??originalPersonal;
  const personal=await resolvePersonalAuthority(storage,{kind:'personal',id:selectedPersonal.scopeId},selectedPersonal.pin,provider,r.device);
  await keys.useIdentity(identity('personal',selectedPersonal.scopeId,'data',personal.scope.epochId),()=>{});
  const workspaceRun=openSQLiteTransaction(db);
  if(returnToOriginal){
   await returnToOriginalHousehold(name,workspaceRun);
   sequences.close();db.close();master.close();
   return;
  }
  const runtime=(resolved,kind,rootPin)=>{const p=localProvider(sodium,keys,{signing:{...signing,publicKey:signingRef},content:(epoch,fn)=>keys.useIdentity(identity(kind,resolved.scope.scopeId,'data',epoch),fn)});return new OfflineRuntime({storage,codec:candidateCodec(p),LoroDoc,decodeImportBlobMeta,scope:resolved.scope,keyRef:resolved.scope.epochId,authority:{kind,rootPin,provider,selectionIndex:resolved.selectionIndex}})};
  pairing=openNativeHouseholdPersistence({name,openDatabase,workspaceRun,master,storage,provider,sodium,deviceId:r.device});
  const {selection,pins,store,prepareJoinedSequences,finalizeJoinedSequences}=pairing;
  const selected=await selection.openSelected();
  joinedSequences=selected?.sequences;
  const activeScope=selected?.scope??{kind:'household',id:r.house},activePin=selected?.pin??root.head;
  const {resolved:house,installedSet}=selected??originalHouse;
  const household=await openWorkspaceHouseholdRuntime({storage,resolved:house,installedSet,pin:activePin,provider,
   sodium,keys,signing:{...signing,publicKey:signingRef},wrapping,LoroDoc,decodeImportBlobMeta});
  const disclosure=disclosureService({storage,scope:activeScope,rootPin:activePin,provider,deviceId:r.device,
   installedSet:installedSet?{...installedSet,sodium,LoroDoc}:null});
  const selectedId=selected?.scope.id??null;
  const withCurrent=use=>selection.withCurrent(selectedId,use);
  const active=fn=>(...args)=>withCurrent(()=>fn(...args));
  const activeMethods=methods=>Object.fromEntries(Object.entries(methods).map(([name,fn])=>[name,active(fn)]));
  const policyStatus=await withCurrent(()=>bootstrapDisclosurePolicy(storage,activeScope.id,disclosure));
  const selectionControls={available:selection.available,select:selection.select,clear:selection.clear};
  const householdPairing=bindHouseholdPairing({
   name,sodium,storage,master,provider,store,scope:activeScope,pin:activePin,deviceId:r.device,adultId:house.adultId,
   runtime:household,service:disclosure,pins,keys,signing,wrapping,signingKey:signingRef,
   wrappingPublicKey:sodium.to_hex(wrappingPublicKey),selection:selectionControls,selectedHousehold:!!selected,LoroDoc,
   prepareJoinedSequences,finalizeJoinedSequences,randomUUID,withCurrent,sha256
  });
  const originalRecipeDocuments=!selected&&!installedSet;
  const cooking=cookingFiles({runtime:household,service:disclosure,
   recipeCatalogVersion:installedSet||originalRecipeDocuments?1:null,allowRecipeSources:false});
  let direct;
  try {
   direct=await openDirect?.({
    runtime:household,provider,cooking,assertSelected:()=>selection.assertCurrent(selectedId),
    withSelected:withCurrent
   });
  } catch { /* Direct transfer is optional. Offline storage and file exchange stay available. */ }
  if(!ready)await transaction(db,async()=>{const now=load();if(!now||!['sealed','ready'].includes(now.stage))throw Error('LOCKED');const decoded=decode(await master.unwrap('workspace-master',new Uint8Array(now.data),aad));if(decoded.stage!==now.stage)throw Error('LOCKED');const {stage,...current}=decoded;if(JSON.stringify(current)!==JSON.stringify(r))throw Error('LOCKED');if(now.stage==='sealed'){const complete=await master.wrap('workspace-master',enc.encode(JSON.stringify({...r,stage:'ready'})),aad);exec(db,'UPDATE loro_bootstrap SET stage=?,data=? WHERE id=1',['ready',complete])}});
  const recovery=workspaceRecovery({sodium,keys,run:storage.recoveryTransaction,storage,master,masterId:'workspace-master',scopeId:selectedPersonal.scopeId,deviceId:r.device,pin:selectedPersonal.pin,provider});
  const rotatePersonal=personalRotation({sodium,storage,keys,provider,LoroDoc,deviceId:r.device,
   signing,wrapping,signingKey:signingRef,wrappingKey:sodium.to_hex(wrappingPublicKey),
   selected:selectedPersonal,selection:personalSelection.value,recoveryImport:null,randomUUID});
  const pairPersonal=personalPairing({sodium,storage,recipient:storage.recipient,store,provider,master,keys,
   signing,wrapping,signingKey:signingRef,wrappingKey:sodium.to_hex(wrappingPublicKey),deviceId:r.device,
   original:originalPersonal,selected:selectedPersonal,selection:personalSelection.value,LoroDoc,randomUUID});
  const householdContent=bindHouseholdContent({runtime:household,withCurrent,sequences:joinedSequences??sequences,disclosure,originalRecipeDocuments});
  const installedRecipeIds=installedSet?house.members.flatMap(member=>member.recipeId===null?[]:[member.recipeId]):undefined;
  return {
   personalRotation:rotatePersonal,personalPairing:pairPersonal,
   householdCompromise:householdCompromise({runtime:household,withCurrent,sha256,randomUUID,randomBytes:size=>sodium.randombytes_buf(size)}),
   householdLocalTrust:householdLocalTrust({runtime:household,withCurrent}),
   authorizeHousehold:active(()=>household.authorize()),
   household:{
    scope:structuredClone(household.scope),
    document:active(()=>household.document()),
    listOutboundObjects:active(()=>storage.listOutboundObjects(activeScope.id)),
    subscribe:listener=>subscribeActions(household,listener)
   },
   personal:runtime(personal,'personal',selectedPersonal.pin),householdPairing,cookingFiles:activeMethods(cooking),direct,
   householdContent,installedRecipeIds,executeHouseholdAction:householdContent.execute,
   disclosure:activeMethods(disclosure),disclosureProvider:activeMethods(provider),needsDisclosureSetup:!selected&&policyStatus.needsSetup,
   needsDisclosureRenewal:policyStatus.needsRenewal||!!selected&&policyStatus.needsSetup,
   deviceId:r.device,wrappingPublicKey:sodium.to_hex(wrappingPublicKey),recovery,
   sequences:{reserve:(scopeId,operationId)=>{
    if(scopeId!==selectedPersonal.scopeId)throw Error('INVALID_AUTHORITY');
    return sequences.reserve(r.personal,operationId);
   }},
   close:()=>{joinedSequences?.close();pairing.close();sequences.close();db.close();master.close()}
  };
 }catch(e){joinedSequences?.close();pairing?.close();sequences?.close();db.close();master?.close();throw e}
}
