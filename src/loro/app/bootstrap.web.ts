import {householdPairing as bindHouseholdPairing} from './household-pairing.mjs';
import {prepareJoinedSequences,finalizeJoinedSequences} from './joined-sequences.web.ts';
import {householdSelection} from './household-selection.web.ts';
import {bootstrapDisclosurePolicy} from './bootstrap-policy.mjs';
import {openHouseholdPins} from './household-pins.web.ts';
import {openSessionStore} from '../pairing/session-indexeddb.mjs';
import {createGuardianPreparation} from './guardians/guardian-preparation.mjs';
import {workspaceRecovery} from './workspace-recovery.mjs';
import {ownerGuardians,pinHolder,holderFingerprint,exportGuardianAuthority,acceptGuardianAuthority,initializeGuardianHolder,holderGuardians} from './guardians/guardian-workflow.mjs';
import sodium from 'libsodium-wrappers';
import initLoro, { LoroDoc, decodeImportBlobMeta } from 'loro-crdt/web/loro_wasm.js';
import {openIndexedDBStorage} from '../storage/indexeddb.ts';
import {openBrowserMaster} from '../storage/browser-master.ts';
import {rootPin,policyId,initializeAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {personalRootPin,initializePersonalAuthority,resolvePersonalAuthority} from '../authority/personal.mjs';
import {domain} from '../authority/validator.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
import {localProvider} from './local-provider.mjs';
import {openSequences} from './sequences.web.ts';
import {cookingFiles} from './cooking-file.mjs';
import {cookingDirect} from '../transport/cooking-direct.mjs';
import {disclosureService} from '../disclosure/service.mjs';

const enc=new TextEncoder();
const aad=enc.encode('creative-cooking/fresh-local-bootstrap/v1');
const request=<T,>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
const validName=(s:unknown):s is string=>typeof s==='string'&&/^[a-z0-9-]{1,100}$/.test(s);
// Each explicitly created workspace receives a new random namespace. Reopening
// never generates replacement identity material for an existing namespace.
export async function openLocalWorkspace(name:string,create=false) {
 if(!validName(name)||typeof create!=='boolean')throw Error('MALFORMED');
 const locks=globalThis.navigator?.locks;
 if(!locks||typeof locks.request!=='function')throw Error('LOCK_UNAVAILABLE');
 return locks.request(`creative-cooking/bootstrap/v1/${name}`,{mode:'exclusive'},()=>openLockedWorkspace(name,create));
}
// The reservation is read only after acquiring the namespace lock. A queued
// opener therefore observes establishment before choosing any creation path.
async function openLockedWorkspace(name:string,create:boolean) {
 await sodium.ready;await initLoro(new URL('./loro_wasm_bg.wasm?v=1.17.1',import.meta.url));
 const master=await openBrowserMaster(`${name}-master`);
 const db=await openIndexedDBStorage(`${name}-records`);
 const opening=indexedDB.open(`${name}-bootstrap`,1);opening.onupgradeneeded=()=>opening.result.createObjectStore('metadata');const meta=await request(opening);
 let sequences:Awaited<ReturnType<typeof openSequences>> | undefined;
 let ceremonyStore:any;
 let householdPins:any;
 let joinedSequences:any;
 try {
  const read=async()=>{const tx=meta.transaction('metadata','readonly');return request(tx.objectStore('metadata').get('reservation'))};
  let wrapped=await read();
  if(!wrapped) {
   if(!create)throw Error('MISSING_BOOTSTRAP');
   await master.ensure('workspace-master');
   const random=()=>crypto.randomUUID();
   const reservation={version:1,stage:'reserved',device:random(),adult:random(),house:random(),personal:random(),houseDoc:random(),personalDoc:random(),houseEpoch:random(),personalEpoch:random()};
   const candidate=await master.wrap('workspace-master',enc.encode(JSON.stringify(reservation)),aad);
   wrapped=await new Promise((resolve,reject)=>{const tx=meta.transaction('metadata','readwrite'),store=tx.objectStore('metadata'),get=store.get('reservation');let value:any;get.onsuccess=()=>{value=get.result??candidate;if(!get.result)store.put(candidate,'reservation')};tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);tx.onerror=()=>{}});
  }
  let r:any;try{r=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await master.unwrap('workspace-master',wrapped,aad)))}catch{throw Error('LOCKED')}
  if(r?.version!==1||!['reserved','ready'].includes(r.stage)||!['device','adult','house','personal','houseDoc','personalDoc','houseEpoch','personalEpoch'].every(k=>typeof r[k]==='string'&&validName(r[k])))throw Error('LOCKED');
  const ready=r.stage==='ready';
  sequences=await openSequences(name,[r.house,r.personal],!ready);
  const keys=db.localKeys(master,sodium);await keys.provision('workspace-master');
  const identity=(kind:'personal'|'household',scopeId:string,purpose:'device-signing'|'device-wrapping'|'data',epochId:string)=>({version:1 as const,scope:{kind,id:scopeId},deviceId:r.device,purpose,epochId});
  const signing={operationId:'device-signing',identity:identity('personal',r.personal,'device-signing',r.personalEpoch)};
  const wrapping={operationId:'device-wrapping',identity:identity('personal',r.personal,'device-wrapping',r.personalEpoch)};
  const houseKey={operationId:'household-data',identity:identity('household',r.house,'data',r.houseEpoch)};
  const personalKey={operationId:'personal-data',identity:identity('personal',r.personal,'data',r.personalEpoch)};
  let publicKey:Uint8Array,wrappingPublicKey:Uint8Array;
  if(ready){publicKey=await keys.use(signing.operationId,signing.identity,secret=>{const pair=sodium.crypto_sign_seed_keypair(secret.slice(0,32));pair.privateKey.fill(0);return pair.publicKey;});wrappingPublicKey=await keys.use(wrapping.operationId,wrapping.identity,secret=>sodium.crypto_scalarmult_base(secret));await keys.use(houseKey.operationId,houseKey.identity,()=>undefined);await keys.use(personalKey.operationId,personalKey.identity,()=>undefined);}
  else {const generated=await keys.generate(signing.operationId,signing.identity);publicKey=generated.publicKey!;wrappingPublicKey=(await keys.generate(wrapping.operationId,wrapping.identity)).publicKey!;await keys.generate(houseKey.operationId,houseKey.identity);await keys.generate(personalKey.operationId,personalKey.identity);}
  const signingRef=sodium.to_hex(publicKey);
  const provider=localProvider(sodium,keys,{signing:{...signing,publicKey:signingRef},content:{[r.houseEpoch]:houseKey,[r.personalEpoch]:personalKey}});
  const policy={kind:'allMinusOne',fixedCount:null};
  const root={householdId:r.house,head:'',policyHash:await policyId(provider,policy),generation:1,epochId:r.houseEpoch,roster:[r.adult],devices:[{adultId:r.adult,deviceId:r.device,signingKeyRef:signingRef,active:true}],policy,runtime:{documentId:r.houseDoc,authorPeers:{[r.device]:'1'},acceptedRecipients:[r.device]}};
  root.head=await rootPin(provider,root);
  const personalRoot={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',scopeId:r.personal,ownerId:r.adult,signerDeviceId:r.device,devices:[{deviceId:r.device,ownerId:r.adult,signingKeyRef:signingRef,peerId:'2',active:true}],documentId:r.personalDoc,generation:1,epochId:r.personalEpoch};
  const pin=await personalRootPin(provider,personalRoot),signature=sodium.to_hex(await provider.sign(signingRef,domain('personal-root-signature',personalRoot)));
  const ensure=async(scope:any,initialize:()=>Promise<void>)=>{const existing=await db.storage.readPairingAuthority(scope);if(!existing.ok)throw Error(existing.error);if(!existing.value){if(ready)throw Error('MISSING_AUTHORITY');try{await initialize()}catch(error){const raced=await db.storage.readPairingAuthority(scope);if(!raced.ok||!raced.value)throw error;}}};
  await ensure({kind:'household',id:r.house},()=>initializeAuthority(db.storage,root,root.head,provider));
  await ensure({kind:'personal',id:r.personal},()=>initializePersonalAuthority(db.storage,{kind:'personal',id:r.personal},pin,provider,{version:1,root:personalRoot,signature}));
  if(!ready){const completed=await master.wrap('workspace-master',enc.encode(JSON.stringify({...r,stage:'ready'})),aad);await new Promise<void>((resolve,reject)=>{const tx=meta.transaction('metadata','readwrite');tx.objectStore('metadata').put(completed,'reservation');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.onerror=()=>{}})}
  const originalHouse=await resolveRuntimeAuthority(db.storage,{kind:'household',id:r.house},root.head,provider,r.device),personal=await resolvePersonalAuthority(db.storage,{kind:'personal',id:r.personal},pin,provider,r.device);
  const runtime=(resolved:any,kind:'personal'|'household',rootPin:string)=>{
   const scopedProvider=localProvider(sodium,keys,{signing:{...signing,publicKey:signingRef},content:(epochId:string,fn:any)=>keys.useIdentity(identity(kind,resolved.scope.scopeId,'data',epochId),fn)});
   return new OfflineRuntime({storage:db.storage,codec:candidateCodec(scopedProvider),LoroDoc,decodeImportBlobMeta,scope:resolved.scope,keyRef:resolved.scope.epochId,authority:{kind,rootPin,provider}});
  };
  householdPins=await openHouseholdPins(name,master);
  const selection=householdSelection({name,meta,master,pins:householdPins,storage:db.storage,provider,sodium,deviceId:r.device}),selected=await selection.openSelected();joinedSequences=selected?.sequences;
  const activeScope=selected?.scope??{kind:'household',id:r.house},activePin=selected?.pin??root.head,house=selected?.resolved??originalHouse;
  const disclosure=disclosureService({storage:db.storage,scope:activeScope,rootPin:activePin,provider,deviceId:r.device});
  const householdRuntime=runtime(house,'household',activePin);
  const cooking=cookingFiles({runtime:householdRuntime,service:disclosure});
  const selectedId=selected?.scope.id??null;
  const direct=typeof globalThis.RTCPeerConnection==='function'?cookingDirect({runtime:householdRuntime,provider,cooking,assertSelected:()=>selection.assertCurrent(selectedId),withSelected:(use:()=>Promise<unknown>)=>selection.withCurrent(selectedId,use)}):null;
  const bootstrapPolicy=await bootstrapDisclosurePolicy(db.storage,activeScope.id,disclosure);
  ceremonyStore=await openSessionStore(`${name}-household-ceremonies`);
  const householdPairing=bindHouseholdPairing({name,sodium,storage:db.storage,master,provider,store:ceremonyStore,scope:activeScope,pin:activePin,deviceId:r.device,adultId:r.adult,runtime:householdRuntime,service:disclosure,pins:householdPins,keys,signing,wrapping,signingKey:signingRef,wrappingPublicKey:sodium.to_hex(wrappingPublicKey),selection,selectedHousehold:!!selected,LoroDoc,prepareJoinedSequences,finalizeJoinedSequences});
  const recovery=workspaceRecovery({sodium,keys,run:db.recoveryTransaction,storage:db.storage,master,masterId:'workspace-master',scopeId:r.personal,deviceId:r.device,pin,provider});
  const guardianOwner=ownerGuardians({sodium,run:db.recoveryTransaction,storage:db.storage,authorityProvider:provider,scopeId:r.personal,owner:r.adult,deviceId:r.device,pin,keys,signing,master,masterId:'workspace-master'});
  const guardianTrustStores:any[]=[];
  const guardians={holder:async(holder:string)=>{const identity=await initializeGuardianHolder({keys,scopeId:r.personal,deviceId:r.device,holder});let trust:any=null,ownerPin='';const requireTrust=()=>{if(!trust)throw Error('VERIFY_OWNER_FIRST');return trust};return {exportHolderBundle:async()=>identity.bundle,fingerprint:(bundle:any)=>holderFingerprint(sodium,bundle),acceptAuthority:async(bundle:any,confirmedPin:string)=>{if(!/^[0-9a-f]{64}$/.test(confirmedPin))throw Error('INVALID_AUTHORITY');const next=await openIndexedDBStorage(`guardian-trust-${name}-${confirmedPin}`);try{await acceptGuardianAuthority({storage:next.storage,authorityProvider:provider,bundle,confirmedPin})}catch(e){next.close();throw e}if(trust)trust.close();trust=next;ownerPin=confirmedPin;guardianTrustStores.push(next)},pin:(bundle:any,fingerprint:string)=>pinHolder({sodium,run:requireTrust().recoveryTransaction,bundle,confirmedFingerprint:fingerprint}),accept:(message:any)=>holderGuardians({sodium,run:requireTrust().recoveryTransaction,storage:trust.storage,authorityProvider:provider,pin:ownerPin,holder,keys,signing:identity.signing,wrapping:identity.wrapping}).accept(message),contribute:(owner:string,generation:number)=>holderGuardians({sodium,run:requireTrust().recoveryTransaction,storage:trust.storage,authorityProvider:provider,pin:ownerPin,holder,keys,signing:identity.signing,wrapping:identity.wrapping}).contribute({owner,generation})}},fingerprint:(bundle:any)=>holderFingerprint(sodium,bundle),pin:(bundle:any,fingerprint:string)=>pinHolder({sodium,run:db.recoveryTransaction,bundle,confirmedFingerprint:fingerprint}),exportAuthority:()=>exportGuardianAuthority({storage:db.storage,authorityProvider:provider,scopeId:r.personal,pin,deviceId:r.device}),prepare:createGuardianPreparation({run:db.recoveryTransaction,owner:r.adult,workspaceName:name,createGeneration:guardianOwner.createGeneration,locks:globalThis.navigator.locks}),acknowledge:async(message:any,ack:any)=>{const slot=JSON.stringify(['recovery-generation-operation','app-pending',r.adult]);const pending:any=await db.recoveryTransaction(false,(tx:any)=>tx.get(slot));if(!pending)throw Error('MISSING_DRAFT');await guardianOwner.acknowledge({operationId:pending.operationId,message,holder:ack.holder,signature:ack.signature});return guardianOwner.custodyStatus({operationId:pending.operationId,message})}};
  return {recovery,guardians,householdPairing,cookingFiles:cooking,direct,household:householdRuntime,personal:runtime(personal,'personal',pin),disclosure,disclosureProvider:provider,needsDisclosureSetup:!selected&&bootstrapPolicy.needsSetup,needsDisclosureRenewal:bootstrapPolicy.needsRenewal||!!selected&&bootstrapPolicy.needsSetup,deviceId:r.device,wrappingPublicKey:sodium.to_hex(wrappingPublicKey),sequences:selected?{reserve:(scopeId:string,operationId:string)=>scopeId===activeScope.id?joinedSequences.reserve(scopeId,operationId):sequences!.reserve(scopeId,operationId)}:sequences,close:()=>{joinedSequences?.close();householdPins?.close();ceremonyStore?.close();for(const store of guardianTrustStores)store.close();sequences?.close();db.close();master.close();meta.close()}};
 } catch(error) {joinedSequences?.close();householdPins?.close();ceremonyStore?.close();sequences?.close();db.close();master.close();meta.close();throw error}
}
