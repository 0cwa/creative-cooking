import {authorityBytes,snapshotId} from '../authority/chain.mjs';
import {policyBaseline,verifyRetainedPolicyBaseline} from '../authority/policy-baseline.mjs';
import {domain} from '../authority/validator.mjs';
import {MAX_SELECTED_CHILDREN,MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';
import {observeSelectedSourceSet,selectedSourceHash,verifySelectedSourceSet} from '../projection/selected-sources.mjs';
import {recipeDocumentId} from '../domain/recipe-document.mjs';
import {exact,inspectOwnDeviceSnapshot,must,ownDeviceCopyHash,sameOwnDevice,verifyOwnDeviceDocumentCopy,verifyOwnDeviceSuccessor} from './household-own-device.mjs';
import {makeKeyPackage,verifyStoredKeyPackage,withOpenedKeyPackage} from './key-package.mjs';
import {MAX_PERSONAL_PAIRING_FILE,openDeviceCopy,pairingDigest,sealDeviceCopy,verifyDeviceCopyFile} from './personal-copy.mjs';

const fileDomain='household-own-device-set-file';

const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const validPeerId=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
const copyFields=['recipeId','documentId','revision','baseline','copy'];
const payloadFields=['snapshot','seed','seedSnapshot','sources','policies'];
const commitment=(provider,sodium,set)=>selectedSourceHash(provider,'household-own-device-copy-set-v1',{
 version:set.version,peerId:set.peerId,observation:set.observation,
 documents:set.documents.map(({copy,...entry})=>({...entry,hash:ownDeviceCopyHash(sodium,copy)})),
});

/** Capture household-only history at the selected head. The caller must carry
 * the guard into the transaction that publishes the signed copy. */
export async function captureOwnDeviceCopySet({runtime,service,sodium,peerId,seedId}) {
 if(!validPeerId(peerId)||Object.values(runtime.scope.authorPeers).includes(peerId))throw Error('INVALID_COPY');
 const {provider}=runtime.authority,{storage,LoroDoc}=runtime;
 const {signed:observation,sources,guard}=await observeSelectedSourceSet(runtime);
 const {expectedAuthority}=guard;
 const disclosure=await service.authority();
 const documents=[];
 let total=0;
 for(const source of sources){
  const {recipeId,scope:{documentId}}=source.runtime;
  const retained=must(await storage.readProjectionSeed(expectedAuthority,documentId));
  const snapshot=source.bytes??new LoroDoc().export({mode:'snapshot'});
  const seedSnapshot=retained?.snapshot??null;
  total+=snapshot.length+(seedSnapshot?.length??0);
  if(total>MAX_SELECTED_SET_BYTES)throw Error('TOO_LARGE');
  const seed=retained?.seed??{seedId,identities:[]};
  const {doc,identities}=inspectOwnDeviceSnapshot({LoroDoc,snapshot,peerId,seed,seedSnapshot});
  const policies=new Map();
  const rows=must(await storage.readOwnDeviceSourcePolicies(expectedAuthority,documentId,identities.map(row=>row.effectId)));
  for(const hash of new Set(rows.flatMap(row=>row.policyHashes))){
   for(let next=hash;next&&!policies.has(next);){
    const policy=await service.validateStored(next,disclosure);
    policies.set(next,policy);
    if(policies.size>64)throw Error('TOO_LARGE');
    next=policy.policy.predecessor;
   }
  }
  documents.push({recipeId,documentId,revision:source.revision,baseline:await policyBaseline(doc,provider),
   copy:{snapshot,seed,seedSnapshot,sources:rows,policies:[...policies.values()].sort((a,b)=>a.policyHash<b.policyHash?-1:1)}});
 }
 const set={version:1,peerId,observation,documents};
 const copyHash=await commitment(provider,sodium,set);
 must(await storage.checkSelectedHouseholdSources(guard));
 return {set,copyHash,guard};
}

/** Verify an encrypted copy against an independently retained parent and the
 * copy commitment and sponsor from the signed own-device event. This verifies
 * policy attestations; it confers no independent disclosure provenance. */
export async function verifyOwnDeviceCopySet({storage,scope,pin,provider,sodium,LoroDoc,set,copyHash,authorDevice,peerId}) {
 scope=structuredClone(scope);
 if(!validPeerId(peerId)||!exact(set,['version','peerId','observation','documents'])||set.version!==1||set.peerId!==peerId||
    !Array.isArray(set.documents)||!set.documents.length||set.documents.length>MAX_SELECTED_CHILDREN+1)throw Error('INVALID_COPY');
 let total=0;
 for(const entry of set.documents){
  if(!exact(entry,copyFields)||!exact(entry.copy,payloadFields)||
     !(entry.copy.snapshot instanceof Uint8Array)||
     !(entry.copy.seedSnapshot===null||entry.copy.seedSnapshot instanceof Uint8Array))throw Error('INVALID_COPY');
  total+=entry.copy.snapshot.length+(entry.copy.seedSnapshot?.length??0);
  if(total>MAX_SELECTED_SET_BYTES)throw Error('TOO_LARGE');
 }
 set=structuredClone(set);
 const {manifest,state,selected}=await verifySelectedSourceSet({storage,scope,pin,provider,signed:set.observation});
 if(set.observation.deviceId!==authorDevice||Object.values(selected.runtime.authorPeers).includes(peerId)||
    set.documents.length!==manifest.children.length+1)throw Error('INVALID_COPY');
 const sources=[{...manifest.root,recipeId:null},...manifest.children];
 const result=[];
 const effects=new Set(),commands=new Set();
 for(const [index,{recipeId,documentId,revision,baseline,copy}] of set.documents.entries()){
  const expected=sources[index];
  if(documentId!==expected.documentId||recipeId!==expected.recipeId||revision!==expected.revision||
     (expected.checkpointHash===null
       ?baseline?.frontiers?.length!==0||copy.seedSnapshot!==null
       :await selectedSourceHash(provider,'projection-source-snapshot',hex(copy.snapshot))!==expected.checkpointHash))throw Error('INVALID_COPY');
  const identities=await verifyOwnDeviceDocumentCopy({sodium,provider,LoroDoc,copy,pin,parentState:state,
   authorDevice,householdId:scope.id,peerId,baseline});
  for(const {effectId,commandId} of identities){
   if(effects.has(effectId)||commands.has(commandId))throw Error('INVALID_COPY');
   effects.add(effectId);
   commands.add(commandId);
  }
  result.push({recipeId,documentId,revision,baseline,copy,identities});
 }
 if(await commitment(provider,sodium,set)!==copyHash)throw Error('INVALID_COPY');
 return result;
}

/** A verified candidate transition. Persisting it requires a separate atomic
 * installer for all derived documents and their keys. */
export async function verifyOwnDeviceSetSuccessor({storage,pin,provider,sodium,LoroDoc,parentRecord,next,proposal,set}) {
 ({parentRecord,next,proposal,set}=structuredClone({parentRecord,next,proposal,set}));
 const checked=await verifyOwnDeviceSuccessor({sodium,provider,pin,parentRecord,next,proposal,eventVersion:5});
 const {event}=checked.item, subject=event.subject;
 const manifest=set?.observation?.manifest;
 if(manifest?.parentHead!==event.parentHead||manifest.authorizationSnapshot!==subject.parentSnapshot||
    manifest.authorityRevision!==subject.parentRevision)throw Error('INVALID_COPY');
 const documents=await verifyOwnDeviceCopySet({storage,scope:parentRecord.scope,pin,provider,sodium,LoroDoc,set,
  copyHash:subject.copyHash,authorDevice:event.authorDeviceId,peerId:subject.peerId});
 if(!sameOwnDevice(sodium,documents[0].baseline,subject.baseline))throw Error('INVALID_COPY');
 const target={scopeId:event.householdId,branchHead:checked.head,documentId:subject.documentId,
  documentGeneration:event.generation,epochId:event.epochId};
 const targetIds=new Set();
 const copies=await Promise.all(documents.map(async document=>({
  ...document,targetDocumentId:document.recipeId===null?target.documentId:await recipeDocumentId(target,pin,provider,document.recipeId)
 })));
 for(const {targetDocumentId} of copies){
  if(targetIds.has(targetDocumentId))throw Error('INVALID_COPY');
  targetIds.add(targetDocumentId);
 }
 return {...checked,documents:copies};
}

async function keyContexts(provider,{context,documents}) {
 return Promise.all(documents.map(async ({targetDocumentId})=>({
  ...context,projectionId:targetDocumentId,
  releaseId:await selectedSourceHash(provider,'household-own-device-document-release-v1',{
   sessionId:context.releaseId,head:context.grantHash,copyHash:context.manifestHash,documentId:targetDocumentId
  }),
 })));
}

function requireLocalEvidence(sodium,checked,evidence) {
 if(!sameOwnDevice(sodium,checked.proof,{transcript:evidence.transcript,guard:evidence.guard,messages:evidence.messages}))
  throw Error('INVALID_PROOF');
}

async function targetKeyIdentity(provider,scope,pin,checked,documentId,deviceId) {
 const epochId=await selectedSourceHash(provider,'household-own-device-key-slot-v1',{
  scope,pin,head:checked.head,epochId:checked.context.epochId,documentId
 });
 const keyOperationId=await selectedSourceHash(provider,'household-own-device-key-operation-v1',{epochId,deviceId});
 return {keyOperationId,identity:{version:1,scope,deviceId,purpose:'data',epochId}};
}

function sponsorReceipt(scope,pin,checked,fileHash,keyHashes) {
 return domain('household-own-device-set-publication',{scope,pin,fileHash,keyHashes,head:checked.head,
  deviceId:checked.context.senderDevice,operationId:checked.context.releaseId,
  guardId:checked.proof.guard.guardId,copyHash:checked.context.manifestHash});
}

/** The caller must commit the checked copy and source guard before sharing the file. */
export async function sealOwnDeviceSetFile({signingSecret,useSourceKey,evidence,next,set,...options}) {
 const {sodium,provider}=options;
 ({evidence,next,set}=structuredClone({evidence,next,set}));
 const secret=new Uint8Array(signingSecret);
 try{
  const checked=await verifyOwnDeviceSetSuccessor({...options,next,set,proposal:evidence});
  requireLocalEvidence(sodium,checked,evidence);
  if(hex(secret.subarray(32))!==checked.context.senderSigningKey)throw Error('INVALID_KEY');
  const contexts=await keyContexts(provider,checked);
  const packets=[];
  for(const [index,document] of checked.documents.entries()){
   const context=contexts[index];
   const packet=await useSourceKey({documentId:document.documentId,recipeId:document.recipeId},
    key=>makeKeyPackage(sodium,context,key,secret));
   verifyStoredKeyPackage(sodium,packet,context);
   packets.push(new Uint8Array(packet));
  }
  return sealDeviceCopy(sodium,fileDomain,checked.context.transcriptHash,checked.proof.transcript.responder,secret,
   {version:1,head:checked.head,item:checked.item,selection:checked.selection,set,packets});
 }finally{secret.fill(0)}
}

/** Publish the captured set atomically before returning its encrypted file. */
export async function publishOwnDeviceSet({storage,provider,sodium,LoroDoc,pin,parentRecord,next,captured,evidence,signingSecret,useSourceKey,keys,deviceId}) {
 ({parentRecord,next,evidence}=structuredClone({parentRecord,next,evidence}));
 const {set,guard}=structuredClone(captured);
 const checked=await verifyOwnDeviceSetSuccessor({storage,provider,sodium,LoroDoc,pin,parentRecord,next,set,proposal:evidence});
 requireLocalEvidence(sodium,checked,evidence);
 if(deviceId!==checked.context.senderDevice)throw Error('INVALID_KEY');
 const keyHashes=new Map();
 const file=await sealOwnDeviceSetFile({storage,provider,sodium,LoroDoc,pin,parentRecord,next,set,evidence,signingSecret,
  useSourceKey:(source,use)=>useSourceKey(source,key=>{keyHashes.set(source.documentId,hex(sodium.crypto_generichash(32,key)));return use(key)})});
 const documents=[];
 for(const document of checked.documents){
  const documentId=document.targetDocumentId;
  const {keyOperationId,identity}=await targetKeyIdentity(provider,parentRecord.scope,pin,checked,documentId,deviceId);
  const localKey=await useSourceKey({documentId:document.documentId,recipeId:document.recipeId},key=>{if(hex(sodium.crypto_generichash(32,key))!==keyHashes.get(document.documentId))throw Error('INVALID_KEY');return keys.preparePairedDataKey(keyOperationId,identity,key)});
  documents.push({recipeId:document.recipeId,sourceDocumentId:document.documentId,documentId,bytes:document.copy.snapshot,
   identities:document.identities,sources:document.copy.sources,policies:document.copy.policies,localKey});
 }
 const orderedHashes=checked.documents.map(document=>keyHashes.get(document.documentId));
 const receipt=sponsorReceipt(parentRecord.scope,pin,checked,pairingDigest(sodium,file),orderedHashes);
 const signature=sodium.crypto_sign_detached(receipt,signingSecret);
 if(!sodium.crypto_sign_verify_detached(signature,receipt,checked.proof.transcript.initiator.signingPublicKey))
  throw Error('INVALID_KEY');
 must(await storage.commitHouseholdOwnDeviceSet({operationId:evidence.transcript.sessionId,guardId:checked.proof.guard.guardId,
  expected:parentRecord,next,guard,copyHash:checked.context.manifestHash,file,documents,
  sponsor:{deviceId,set,keyHashes:orderedHashes,signature:hex(signature)}}));
 return {scope:parentRecord.scope,head:checked.head,file};
}

/** Verify the file and open the complete key set before invoking the installer. */
export async function withOpenedOwnDeviceSetFile({file,wrappingSecret,evidence,withKeys,...options}) {
 const {sodium,provider}=options;
 if(!(file instanceof Uint8Array)||file.length<=112||file.length>MAX_PERSONAL_PAIRING_FILE)throw Error('INVALID_FILE');
 const secret=new Uint8Array(wrappingSecret);
 try{
  evidence=structuredClone(evidence);
  if(hex(sodium.crypto_scalarmult_base(secret))!==hex(evidence.transcript.responder.wrappingPublicKey))
   throw Error('INVALID_KEY');
  const contents=openDeviceCopy(sodium,fileDomain,file,evidence.hash,evidence.transcript,secret);
  const fileHash=pairingDigest(sodium,file);
  if(!exact(contents,['version','head','item','selection','set','packets'])||contents.version!==1)
   throw Error('INVALID_FILE');
  const {item,head,selection,set,packets}=contents;
  const parentRecord=structuredClone(options.parentRecord);
  const parent=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(parentRecord.authorityState));
  const nextState={...parent,events:[...parent.events,item],selections:[...parent.selections,selection],activeHead:head};
  const next={scope:parentRecord.scope,revision:parentRecord.revision+1,acceptedParent:head,
   authorityState:authorityBytes(nextState),authorizationSnapshot:await snapshotId(provider,nextState)};
  const checked=await verifyOwnDeviceSetSuccessor({...options,parentRecord,next,set,proposal:evidence});
  requireLocalEvidence(sodium,checked,evidence);
  const contexts=await keyContexts(provider,checked);
  if(!Array.isArray(packets)||packets.length!==contexts.length)throw Error('INVALID_KEY_PACKAGE');
  for(const [index,context] of contexts.entries())verifyStoredKeyPackage(sodium,packets[index],context);
  const keys=[];
  const open=index=>index===contexts.length
   ? withKeys({checked,next,set,packets,keys,fileHash})
   : withOpenedKeyPackage(sodium,packets[index],contexts[index],secret,key=>{
     keys.push({documentId:contexts[index].projectionId,key});
     return open(index+1);
    });
  return await open(0);
 }finally{secret.fill(0)}
}

/** Install a verified file against the recipient's independently confirmed parent. */
export async function installOwnDeviceSetFile({storage,provider,sodium,LoroDoc,pin,parentRecord,evidence,file,wrappingSecret,signingSecret,keys,deviceId}) {
 if(!(file instanceof Uint8Array)||file.length<=112||file.length>MAX_PERSONAL_PAIRING_FILE)throw Error('INVALID_FILE');
 ({parentRecord,evidence,file}=structuredClone({parentRecord,evidence,file}));
 const scope=parentRecord.scope,operationId=evidence.transcript.sessionId,fileHash=pairingDigest(sodium,file);
 const secret=new Uint8Array(wrappingSecret),signer=new Uint8Array(signingSecret);
 const readReceipt=async()=>must(await storage.readHouseholdOwnDeviceSetReceipt(scope,operationId));
 const same=(a,b)=>sameOwnDevice(sodium,a,b);
 async function install(prior) {
  if(prior){
   if(prior.recipient.fileHash!==fileHash||prior.recipient.deviceId!==deviceId||!same(prior.expected,parentRecord))
    throw Error('CONFLICT');
  }
  // The transaction rechecks the exact selected record, including on replay.
  const parentView={readPairingAuthority:async requested=>({ok:true,value:same(requested,scope)?parentRecord:null})};
  return withOpenedOwnDeviceSetFile({storage:parentView,provider,sodium,LoroDoc,pin,parentRecord,evidence,file,
   wrappingSecret:secret,withKeys:async({checked,next,keys:opened})=>{
    if(checked.context.recipientDevice!==deviceId)throw Error('INVALID_KEY');
    const receipt=domain('household-own-device-set-receipt',{scope,pin,operationId,deviceId,fileHash,
     head:checked.head,guardId:checked.proof.guard.guardId,parent:parentRecord.authorizationSnapshot,copyHash:checked.context.manifestHash});
    const signature=prior?.recipient.signature??hex(sodium.crypto_sign_detached(receipt,signer));
    if(!sodium.crypto_sign_verify_detached(sodium.from_hex(signature),receipt,checked.proof.transcript.responder.signingPublicKey))
     throw Error('INVALID_PROOF');
    const documents=[];
    for(const [index,document] of checked.documents.entries()){
     const {documentId,key}=opened[index];
     const {keyOperationId,identity}=await targetKeyIdentity(provider,scope,pin,checked,documentId,deviceId);
     const localKey=await keys.preparePairedDataKey(keyOperationId,identity,key);
     documents.push({recipeId:document.recipeId,sourceDocumentId:document.documentId,
      documentId,bytes:document.copy.snapshot,identities:document.identities,sources:document.copy.sources,policies:document.copy.policies,localKey});
    }
    const {replayed}=must(await storage.commitHouseholdOwnDeviceSet({operationId,guardId:checked.proof.guard.guardId,
     expected:parentRecord,next,copyHash:checked.context.manifestHash,file,documents,recipient:{deviceId,fileHash,signature}}));
    return {scope,head:checked.head,replayed};
   }});
 }
 try{
  let prior=await readReceipt();
  if(!prior&&!same(must(await storage.readPairingAuthority(scope)),parentRecord)){
   prior=await readReceipt();
   if(!prior)throw Error('STALE_AUTHORITY');
  }
  try{return await install(prior)}
  catch(error){
   if(prior||!['CONFLICT','LOCKED'].includes(error.message))throw error;
   const committed=await readReceipt();
   if(!committed)throw error;
   return await install(committed);
  }
 }finally{secret.fill(0);signer.fill(0)}
}

/** Reopen only a complete, still-current paired household copy. */
export async function reopenOwnDeviceSet({storage,scope,operationId,pin,provider,sodium,LoroDoc,keys,wrappingSecret}) {
 scope=structuredClone(scope);
 const saved=must(await storage.readHouseholdOwnDeviceSetRetained(scope,operationId));
 if(!saved)throw Error('INVALID_AUTHORITY');
 const checked=await verifyOwnDeviceSuccessor({sodium,provider,pin,parentRecord:saved.expected,next:saved.next,eventVersion:5});
 const evidence={...checked.proof,hash:checked.context.transcriptHash};
 const fileHash=pairingDigest(sodium,saved.file);
 if(operationId!==checked.context.releaseId||saved.guardId!==checked.proof.guard.guardId||
    saved.copyHash!==checked.context.manifestHash)throw Error('INVALID_PROOF');
 const parentView={readPairingAuthority:async requested=>({ok:true,value:sameOwnDevice(sodium,requested,scope)?saved.expected:null})};
 const options={storage:parentView,provider,sodium,LoroDoc,pin,parentRecord:saved.expected};
 async function verifyDocuments(opened,deviceId,verifyKey){
   if(saved.documents.length!==opened.documents.length)throw Error('INVALID_COPY');
   const identities=[];
   for(const [index,doc] of opened.documents.entries()){
    const retained=saved.documents[index],documentId=doc.targetDocumentId;
    if(!sameOwnDevice(sodium,{recipeId:doc.recipeId,sourceDocumentId:doc.documentId,documentId},
      {recipeId:retained.recipeId,sourceDocumentId:retained.sourceDocumentId,documentId:retained.documentId})||
      !sameOwnDevice(sodium,retained.sources,doc.copy.sources))throw Error('INVALID_COPY');
    if(!Number.isSafeInteger(retained.document.revision)||retained.document.revision<0||!(retained.document.bytes instanceof Uint8Array))throw Error('INVALID_COPY');
    if(retained.document.revision===0&&!sameOwnDevice(sodium,retained.document.bytes,doc.copy.snapshot))throw Error('INVALID_COPY');
    await verifyRetainedPolicyBaseline(LoroDoc,retained.document,doc.baseline,provider);
    const {keyOperationId,identity}=await targetKeyIdentity(provider,scope,pin,opened,documentId,deviceId);
    await keys.use(keyOperationId,identity,key=>{if(!verifyKey(key,index))throw Error('INVALID_KEY')});
    const {seed,seedSnapshot}=doc.copy;
    identities.push({recipeId:doc.recipeId,documentId,keyOperationId,identity,
     seed:seedSnapshot===null?null:{seed,snapshot:seedSnapshot}});
   }
   if(!sameOwnDevice(sodium,must(await storage.readPairingAuthority(scope)),saved.next))throw Error('STALE_AUTHORITY');
   return structuredClone({head:opened.head,item:opened.item,selection:opened.selection,documents:identities,record:saved.next});
 }
 if(saved.sponsor){
  const {deviceId,set,keyHashes,signature}=saved.sponsor;
  const sender=checked.proof.transcript.initiator.signingPublicKey;
  if(deviceId!==checked.context.senderDevice||!sodium.crypto_sign_verify_detached(sodium.from_hex(signature),
    sponsorReceipt(scope,pin,checked,fileHash,keyHashes),sender))throw Error('INVALID_PROOF');
  verifyDeviceCopyFile(sodium,fileDomain,saved.file,evidence.hash,sender);
  const opened=await verifyOwnDeviceSetSuccessor({...options,next:saved.next,set,proposal:evidence});
  const result=await verifyDocuments(opened,deviceId,(key,index)=>hex(sodium.crypto_generichash(32,key))===keyHashes[index]);
  return {...result,file:new Uint8Array(saved.file)};
 }
 const {deviceId,signature}=saved.recipient;
 const receipt=domain('household-own-device-set-receipt',{scope,pin,operationId,deviceId,fileHash,
  head:checked.head,guardId:checked.proof.guard.guardId,parent:saved.expected.authorizationSnapshot,copyHash:checked.context.manifestHash});
 if(deviceId!==checked.context.recipientDevice||saved.recipient.fileHash!==fileHash||
    !sodium.crypto_sign_verify_detached(sodium.from_hex(signature),receipt,checked.proof.transcript.responder.signingPublicKey))throw Error('INVALID_PROOF');
 return withOpenedOwnDeviceSetFile({...options,evidence,file:saved.file,wrappingSecret,
  withKeys:({checked:opened,keys:packetKeys})=>verifyDocuments(opened,deviceId,
   (key,index)=>sameOwnDevice(sodium,key,packetKeys[index].key))});
}
