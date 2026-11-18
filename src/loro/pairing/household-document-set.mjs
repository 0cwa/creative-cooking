import {authorityBytes,encodeEvidence,snapshotId,verifyAuthority} from '../authority/chain.mjs';
import {verifyCurrentDocumentSet,verifyCurrentDocumentSetSource} from '../projection/current-document-set.mjs';
import {domain} from '../authority/validator.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {admissionPackage} from './household-admission-package.mjs';
import {verifyPublicParent} from './household-recipient-proof.mjs';
import {durableSession} from './durable-session.mjs';
import {makeKeyPackage,verifyStoredKeyPackage,withOpenedKeyPackage} from './key-package.mjs';
import {loadLoroDoc} from '../app/loro-document.mjs';
import {policyBaseline,verifyRetainedPolicyBaseline} from '../authority/policy-baseline.mjs';

const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const decoder=new TextDecoder('utf-8',{fatal:true});
const wire=value=>value instanceof Uint8Array?Array.from(value):Array.isArray(value)?value.map(wire):
  value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,wire(entry)])):value;
const same=(a,b)=>{
  const left=authorityBytes(wire(a)),right=authorityBytes(wire(b));
  return left.length===right.length&&left.every((byte,index)=>byte===right[index]);
};
const must=result=>{if(!result.ok)throw Error(result.error.code??result.error);return result.value;};
const cloneSecrets=keys=>({signingSecret:new Uint8Array(keys.signingSecret),wrappingSecret:new Uint8Array(keys.wrappingSecret)});
const clearSecrets=keys=>{keys.signingSecret.fill(0);keys.wrappingSecret.fill(0);};
const expectedAuthority=record=>({version:2,scope:record.scope,record:{revision:record.revision,
  acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}});

async function writeOrReplay(storage,scopeId,operationId,write,replay){
  const read=async()=>must(await storage.getProjectionPublication(scopeId,operationId));
  const prior=await read();
  if(prior)return replay(prior);
  try{return await write();}
  catch(error){
    const committed=await read();
    if(!committed)throw error;
    return replay(committed);
  }
}

async function nextAuthority({pin,provider,parentState,record,item,selection}) {
  const {grant,manifest,operationId}=item.admission??{};
  if (manifest?.version!==5 || operationId!==item.event.proposalId || grant?.admissionEventHash!==selection?.to ||
    selection.from!==record.acceptedParent || selection.deviceId!==item.admission.localDeviceId) throw Error('INVALID_AUTHORITY');
  const state={...parentState,events:[...parentState.events,item],selections:[...parentState.selections,selection],activeHead:selection.to};
  const verified=await verifyAuthority(state,pin,provider);
  const next={scope:record.scope,revision:record.revision+1,acceptedParent:state.activeHead,
    authorizationSnapshot:await snapshotId(provider,state),authorityState:authorityBytes(state)};
  return {next,parent:verified.nodes.get(record.acceptedParent),selected:verified.nodes.get(state.activeHead)};
}

async function contextsFor({sodium,provider,parent,record,item,recipientDevice}) {
  const {context,proof,kind,guardId}=await admissionPackage({sodium,provider,parent,
    authorizationSnapshot:record.authorizationSnapshot,item,recipientDevice});
  const contexts=[context];
  for(const {documentId} of item.admission.manifest.entries.slice(1)){
    contexts.push({...context,projectionId:documentId,releaseId:await selectedSourceHash(provider,'household-child-key-release-v1',
      {manifestHash:context.manifestHash,rootReleaseId:context.releaseId,documentId})});
  }
  return {contexts,proof,kind,guardId};
}

async function localIdentity(provider,scope,deviceId,manifest,documentId,keyOperationId) {
  if(documentId===manifest.newDocumentId) return {operationId:keyOperationId,
    identity:{version:1,scope,deviceId,purpose:'data',epochId:manifest.newEpochId}};
  const epochId=await selectedSourceHash(provider,'household-child-key-slot-v1',
    {rootPin:manifest.rootPin,householdId:scope.id,epochId:manifest.newEpochId,documentId});
  const operationId=await selectedSourceHash(provider,'household-child-key-operation-v1',{epochId,keyOperationId});
  return {operationId,identity:{version:1,scope,deviceId,purpose:'data',epochId}};
}

async function checkSession(sodium,sessionStore,keys,evidence,role) {
  const {transcript,guard,oob,messages}=evidence;
  const keysPinned=transcript[role];
  if(hex(keys.signingSecret.subarray(32))!==hex(keysPinned.signingPublicKey) ||
    hex(sodium.crypto_scalarmult_base(keys.wrappingSecret))!==hex(keysPinned.wrappingPublicKey)) throw Error('INVALID_KEY');
  const local=await durableSession(sodium,sessionStore,keys,transcript,guard,role,oob).evidence();
  if(local.hash!==oob.hash || !same(local.messages,messages)) throw Error('INVALID_PROOF');
}

function checkPackets(sodium,packets,contexts) {
  if(!Array.isArray(packets)||packets.length!==contexts.length)throw Error('INVALID_KEY_PACKAGE');
  for(const [index,context] of contexts.entries()){
    const packet=packets[index];
    if(!packet || Object.keys(packet).sort().join(',')!=='bytes,id,recipientDevice' ||
      packet.id!==context.releaseId || packet.recipientDevice!==context.recipientDevice)throw Error('INVALID_KEY_PACKAGE');
    verifyStoredKeyPackage(sodium,packet.bytes,context);
  }
}

function savedDocuments(publication,LoroDoc) {
  const manifest=JSON.parse(decoder.decode(publication.manifest.bytes));
  return publication.documents.map((document,index)=>{
    const retained=publication.documentSet.seeds[index];
    const entry=manifest.entries[index];
    const doc=new LoroDoc();
    doc.import(document.bytes);
    return {documentId:document.documentId,seed:{version:1,seedId:retained.seed.seedId,peerId:entry.peerId,
      snapshot:document.bytes,identities:retained.seed.identities,purchaseIds:Object.keys(doc.getMap('purchases').toJSON()).sort()},
      policyBundle:retained.policySeed?.bundle??null};
  });
}

async function proofAtParent({storage,scope,pin,provider,LoroDoc,item,selection,documents}) {
  const old=await verifyPublicParent(storage,scope,pin,provider);
  const {grant,manifest}=item.admission??{};
  const checked=await verifyCurrentDocumentSet({storage,scope,pin,provider,
    item:{event:item.event,authorSignature:item.authorSignature,approvals:item.approvals},grant,manifest,documents,LoroDoc});
  if(!same(old.record,checked.record))throw Error('CONFLICT');
  return {...checked,...await nextAuthority({pin,provider,parentState:old.state,record:old.record,item,selection})};
}

async function receiptBytes(provider,publication){
  const packets=[];
  for(const packet of publication.packages){
    packets.push({id:packet.id,hash:await selectedSourceHash(provider,'household-recipient-packet',Array.from(packet.bytes))});
  }
  const local=publication.localKey.record;
  return domain('household-recipient-receipt',{version:2,scopeId:publication.expectedAuthority.scope.id,
    operationId:publication.operationId,keyOperationId:local.operationId,recipientDevice:local.identity.deviceId,
    guardId:publication.guardIds[0],parentHead:publication.expectedAuthority.record.acceptedParent,
    authorizationSnapshot:publication.expectedAuthority.record.authorizationSnapshot,acceptedHead:publication.admissionEventHash,
    manifestHash:publication.manifest.id,grantHash:publication.grantHash,epochId:publication.epochId,packets});
}

function forStorage({checked,item,documents,operationId,guardIds,mode,packets,keys,pendingEdits}){
  const {manifest,grant}=item.admission;
  return {version:1,operationId,guardIds,
    expectedAuthority:expectedAuthority(checked.record),nextAuthority:checked.next,admissionEventHash:checked.eventHash,
    grantHash:checked.grantHash,manifest:{id:grant.projectionManifestHash,bytes:authorityBytes(manifest)},epochId:manifest.newEpochId,
    documents:documents.map(({documentId,seed})=>({documentId,generation:manifest.newGeneration,bytes:seed.snapshot})),
    packages:packets,localKey:{record:keys[0].record,catalog:keys[0].catalog},pendingEdits,
    documentSet:{version:1,mode,recipientSignature:null,catalog:manifest.entries.slice(1).map(({recipeId,documentId})=>({recipeId,documentId})),
      seeds:documents.map(({documentId,seed,policyBundle},index)=>({documentId,seed:{seedId:seed.seedId,identities:seed.identities},
        policySeed:policyBundle===null?null:{bundle:policyBundle,bundleHash:manifest.entries[index].policyBundleHash}})),
      childKeys:keys.slice(1).map(key=>key.record)}};
}

async function parentFromPublication({scope,pin,provider,publication}) {
  if(!publication?.documentSet)throw Error('MISSING_PUBLICATION');
  const nextState=JSON.parse(decoder.decode(publication.nextAuthority.authorityState));
  const item=nextState.events.at(-1),selection=nextState.selections.at(-1);
  const parentState={...nextState,events:nextState.events.slice(0,-1),
    selections:nextState.selections.slice(0,-1),activeHead:item.event.parentHead};
  await verifyAuthority(parentState,pin,provider);
  const record={scope,...publication.expectedAuthority.record,authorityState:authorityBytes(parentState)};
  if(record.acceptedParent!==parentState.activeHead||record.authorizationSnapshot!==await snapshotId(provider,parentState)){
    throw Error('INVALID_AUTHORITY');
  }
  const parentStorage={readPairingAuthority:async()=>({ok:true,value:record})};
  return {parentStorage,parentState,nextState,item,selection};
}

/** Verify the durable admission, installed catalog, exact projection and signed
 * key packets. The default cooking runtime remains gated at this format. */
export async function readInstalledHouseholdDocumentSet({sodium,storage,scope,pin,provider,operationId,LoroDoc}) {
  await sodium.ready;
  const publication=must(await storage.getProjectionPublication(scope.id,operationId));
  const {parentStorage,parentState,nextState,item,selection}=await parentFromPublication({scope,pin,provider,publication});
  LoroDoc??=await loadLoroDoc();
  const documents=savedDocuments(publication,LoroDoc);
  const checked=await proofAtParent({storage:parentStorage,scope,pin,provider,LoroDoc,item,selection,documents});
  const {mode}=publication.documentSet;
  const localDevice=publication.localKey.record.identity.deviceId;
  const rootKey=publication.localKey.record,localKeys=[rootKey,...publication.documentSet.childKeys];
  for(const [index,document] of documents.entries()){
    const key=await localIdentity(provider,scope,localDevice,item.admission.manifest,document.documentId,rootKey.operationId);
    if(localKeys[index].operationId!==key.operationId||!same(localKeys[index].identity,key.identity)) throw Error('INVALID_KEY');
  }
  const recipients=mode==='recipient'?[localDevice]:
    checked.selected.runtime.acceptedRecipients.filter(device=>device!==item.admission.localDeviceId);
  if(mode==='publisher'&&localDevice!==item.admission.localDeviceId)throw Error('INVALID_AUTHORITY');
  const contexts=[],guards=[];
  for(const recipientDevice of recipients){
    const result=await contextsFor({sodium,provider,parent:checked.parent,record:checked.record,item,recipientDevice});
    contexts.push(...result.contexts);
    guards.push(result.guardId);
  }
  checkPackets(sodium,publication.packages,contexts);
  if(mode==='recipient'&&!sodium.crypto_sign_verify_detached(publication.documentSet.recipientSignature,
    await receiptBytes(provider,publication),sodium.from_hex(contexts[0].recipientSigningKey))) throw Error('INVALID_RECEIPT');
  if(!same(guards.sort(),publication.guardIds) || !same(checked.next,publication.nextAuthority) ||
    publication.grantHash!==checked.grantHash || publication.manifest.id!==item.admission.grant.projectionManifestHash ||
    !same(publication.manifest.bytes,authorityBytes(item.admission.manifest)))throw Error('INVALID_AUTHORITY');
  for(const {documentId,seed} of documents){
    const retained=must(await storage.reopenDocument(scope.id,documentId));
    if(!retained)throw Error('CORRUPT');
    if(retained.revision===0){
      if(retained.bytes.length!==seed.snapshot.length||
        retained.bytes.some((byte,index)=>byte!==seed.snapshot[index]))throw Error('CORRUPT');
      continue;
    }
    const baseline=new LoroDoc();
    baseline.import(seed.snapshot);
    try{
      await verifyRetainedPolicyBaseline(LoroDoc,retained,await policyBaseline(baseline,provider),provider);
    }catch{throw Error('CORRUPT');}
  }
  return {mode,parentState,state:nextState,documents,item,selection,publication};
}

/** Create a resolver only after independently verifying the installed set.
 * Callers must separately authorize the signer and object against the current
 * authenticated catalog before using opened content in the application. */
export async function installedDocumentSetContent(args, keys) {
  const checked=await readInstalledHouseholdDocumentSet(args);
  const manifest=checked.item.admission.manifest;
  const branchHead=checked.selection.to;
  const records=[checked.publication.localKey.record,...checked.publication.documentSet.childKeys];
  const entries=new Map(manifest.entries.map((entry,index)=>[entry.documentId,records[index]]));
  const scopeId=args.scope.id, epochId=manifest.newEpochId, generation=manifest.newGeneration;
  return (ref,fn,header)=>{
    if(!header || ref!==epochId || header.scopeId!==scopeId || header.branchHead!==branchHead ||
      header.epochId!==epochId || header.documentGeneration!==generation || !entries.has(header.documentId))
      throw Error('INVALID_AUTHORITY');
    const entry=entries.get(header.documentId);
    return keys.use(entry.operationId,entry.identity,fn);
  };
}

/** Explicit complete-set candidate. Binding and writing all selected documents
 * precede access to the recipient-specific file/release. */
export async function publishHouseholdDocumentSet({storage,scope,pin,provider,sodium,sessionStore,keys,master,
  runtime,service,item,grant,manifest,documents,selection,localDeviceId,ceremonies,existingCeremonies,keyOperationId}){
  if(storage!==runtime.storage || pin!==runtime.authority.rootPin || provider!==runtime.authority.provider ||
    localDeviceId!==runtime.scope.authorDevice) throw Error('INVALID_AUTHORITY');
  ({item,grant,manifest,documents,selection,ceremonies,existingCeremonies}=structuredClone({
    item,grant,manifest,documents,selection,ceremonies,existingCeremonies}));
  const secrets=cloneSecrets(keys);
  try{
    await sodium.ready;
    const operationId=item.event.proposalId;
    const admission={grant,manifest,localDeviceId,operationId,
      ceremonies:encodeEvidence(ceremonies),existingCeremonies:encodeEvidence(existingCeremonies)};
    const packed={...item,admission};
    const replay=async()=>{
      const saved=await readInstalledHouseholdDocumentSet({sodium,storage,scope,pin,provider,operationId,LoroDoc:runtime.LoroDoc});
      if(saved.mode!=='publisher'||!same(packed,saved.item)||!same(selection,saved.selection)||
        !same(documents,saved.documents)||saved.publication.localKey.record.operationId!==keyOperationId) throw Error('CONFLICT');
      return {operationId,replayed:true,head:saved.state.activeHead};
    };
    return await writeOrReplay(storage,scope.id,operationId,async()=>{
      const checked=await proofAtParent({storage,scope,pin,provider,LoroDoc:runtime.LoroDoc,item:packed,selection,documents});
      const source=await verifyCurrentDocumentSetSource({runtime,service,item,manifest,documents});
      if(!same(source.expectedAuthority,expectedAuthority(checked.record)))throw Error('CONFLICT');
      const pendingEdits=must(await storage.listBranchLocalOperations(source.expectedAuthority));
      const recipients=checked.selected.runtime.acceptedRecipients.filter(device=>device!==localDeviceId);
      if(!recipients.length||recipients.length*documents.length>128)throw Error('TOO_LARGE');
      const routes=[];
      for(const recipientDevice of recipients){
        const result=await contextsFor({sodium,provider,parent:checked.parent,record:checked.record,item:packed,recipientDevice});
        await checkSession(sodium,sessionStore,secrets,result.proof,'initiator');
        routes.push(result);
      }
      const localKeys=storage.localKeys(master,sodium),prepared=[];
      for(const [index,{documentId}] of documents.entries()){
        const {operationId,identity}=await localIdentity(provider,scope,localDeviceId,manifest,documentId,keyOperationId);
        prepared.push(await localKeys.prepareForAtomicInstall(operationId,identity,key=>routes.map(({contexts})=>{
          const context=contexts[index];
          return {id:context.releaseId,recipientDevice:context.recipientDevice,
            bytes:makeKeyPackage(sodium,context,key,secrets.signingSecret)};
        })));
      }
      const {encodeHouseholdDocumentSetFile}=await import('./household-file.mjs');
      for(const [index] of routes.entries()){
        const packets=prepared.map(key=>key.packets[index]);
        encodeHouseholdDocumentSetFile({version:1,item:packed,selection,documents,packets}).fill(0);
      }
      const packets=routes.flatMap((_,index)=>prepared.map(key=>key.packets[index]));
      const publication=forStorage({checked,item:packed,documents,operationId,guardIds:routes.map(route=>route.guardId).sort(),
        mode:'publisher',keys:prepared,packets,pendingEdits});
      const committed=await storage.publishProjection(publication,undefined,source);
      return {...must(committed),operationId,head:checked.eventHash};
    },replay);
  }finally{clearSecrets(secrets);}
}

/** Recipient-specific proof and signed packages for an already committed set.
 * The caller must transport this payload encrypted to the ceremony recipient. */
export async function householdDocumentSetRelease({sodium,storage,scope,pin,provider,operationId,recipientDevice,LoroDoc}){
  const saved=await readInstalledHouseholdDocumentSet({sodium,storage,scope,pin,provider,operationId,LoroDoc});
  const current=must(await storage.readPairingAuthority(scope));
  if(saved.mode!=='publisher'||!same(current,saved.publication.nextAuthority))throw Error('STALE_AUTHORITY');
  const packets=saved.publication.packages.filter(packet=>packet.recipientDevice===recipientDevice);
  if(packets.length!==saved.documents.length)throw Error('UNAUTHORIZED_DEVICE');
  return {version:1,item:saved.item,selection:saved.selection,documents:saved.documents,packets};
}

/** Independently verify the selected parent, admission, completed local
 * ceremony and every document/key binding before writing any selected state. */
export async function installHouseholdDocumentSet({sodium,storage,scope,pin,provider,recipientDevice,sessionStore,keys,
  master,keyOperationId,confirmedParent,release,LoroDoc}){
  release=structuredClone(release);
  if(!release || Object.keys(release).sort().join(',')!=='documents,item,packets,selection,version'||release.version!==1){
    throw Error('INVALID_DOCUMENT_SET');
  }
  const secrets=cloneSecrets(keys);
  try{
    await sodium.ready;
    const {item,selection,documents,packets}=release;
    const {manifest,operationId}=item?.admission??{};
    if(!manifest||typeof operationId!=='string'||typeof confirmedParent!=='string')throw Error('INVALID_DOCUMENT_SET');
    const verifyInput=async parentStorage=>{
      const checked=await proofAtParent({storage:parentStorage,scope,pin,provider,LoroDoc,item,selection,documents});
      if(checked.record.acceptedParent!==confirmedParent)throw Error('INVALID_AUTHORITY');
      const route=await contextsFor({sodium,provider,parent:checked.parent,record:checked.record,item,recipientDevice});
      await checkSession(sodium,sessionStore,secrets,route.proof,'responder');
      checkPackets(sodium,packets,route.contexts);
      return {checked,...route};
    };
    const localKeys=storage.localKeys(master,sodium);
    const replay=async prior=>{
      const saved=await readInstalledHouseholdDocumentSet({sodium,storage,scope,pin,provider,operationId,LoroDoc});
      const installed=saved.publication;
      if(saved.mode!=='recipient'||!same(item,saved.item)||!same(selection,saved.selection)||!same(documents,saved.documents)||
        !same(packets,installed.packages)||installed.localKey.record.operationId!==keyOperationId||
        installed.localKey.record.identity.deviceId!==recipientDevice) throw Error('CONFLICT');
      const {parentStorage}=await parentFromPublication({scope,pin,provider,publication:prior});
      const {contexts,checked}=await verifyInput(parentStorage);
      const retainedKeys=[installed.localKey.record,...installed.documentSet.childKeys];
      for(const [index,packet] of packets.entries()){
        const {operationId,identity}=retainedKeys[index];
        await withOpenedKeyPackage(sodium,packet.bytes,contexts[index],secrets.wrappingSecret,key=>
          localKeys.use(operationId,identity,retained=>{
            if(retained.length!==key.length||retained.some((byte,index)=>byte!==key[index]))throw Error('LOCKED');
          }));
      }
      return {replayed:true,head:checked.eventHash};
    };
    return await writeOrReplay(storage,scope.id,operationId,async()=>{
      const {checked,contexts,guardId}=await verifyInput(storage);
      const prepared=[],seenKeys=new Set();
      for(const [index,packet] of packets.entries()){
        const context=contexts[index],documentId=documents[index].documentId;
        const {operationId,identity}=await localIdentity(provider,scope,recipientDevice,manifest,documentId,keyOperationId);
        prepared.push(await withOpenedKeyPackage(sodium,packet.bytes,context,secrets.wrappingSecret,async key=>{
          const fingerprint=await selectedSourceHash(provider,'household-admission-key-distinctness',hex(key));
          if(seenKeys.has(fingerprint))throw Error('INVALID_KEY_PACKAGE');
          seenKeys.add(fingerprint);
          return localKeys.preparePairedDataKey(operationId,identity,key);
        }));
      }
      const publication=forStorage({checked,item,documents,operationId,guardIds:[guardId],mode:'recipient',
        keys:prepared,packets,pendingEdits:[]});
      publication.documentSet.recipientSignature=sodium.crypto_sign_detached(await receiptBytes(provider,publication),secrets.signingSecret);
      return {...must(await storage.publishProjection(publication)),head:checked.eventHash};
    },replay);
  }finally{clearSecrets(secrets);}
}
