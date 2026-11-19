import {checkAdmissionAgreement,checkGrantSignatures} from '../authority/grant.mjs';
import {isPolicyDocumentId,validateSuccessor} from '../authority/validator.mjs';
import {authorityBytes} from '../authority/chain.mjs';
import {verifyCurrentSeed,projectCurrentSeed} from '../compromise/current-seed.mjs';
import {MAX_SELECTED_CHILDREN,MAX_SELECTED_SET_BYTES,MAX_SELECTED_SOURCE_BYTES} from '../contracts/runtime-storage.ts';
import {preparePolicyProjection,verifyPolicyProjection} from '../disclosure/policy-seed.mjs';
import {isRecipeDocumentId,recipeDocumentId} from '../domain/recipe-document.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {observeSelectedSourceSet,selectedSourceHash,verifySelectedSourceSet} from './selected-sources.mjs';

const version = 5;
const contentClasses = ['pantry','recipe','shopping'];
const exact = (value,fields) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field=>Object.hasOwn(value,field));
const validId = value => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 256;
const validDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const validSeedId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const validPeerId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const hex = bytes => Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const sameBytes = (left,right) => left.length===right.length && left.every((byte,index)=>byte===right[index]);
const same = (a,b) => sameBytes(authorityBytes(a),authorityBytes(b));

function documentScope(parent,documentId=parent.runtime.documentId,head=parent.head,epochId=parent.epochId,generation=parent.generation) {
  return {scopeId:parent.householdId,documentId,branchHead:head,epochId,documentGeneration:generation};
}

function newRoot(parent,event,nodes) {
  const subject=event.subject;
  if (isRecipeDocumentId(subject.documentId) || isPolicyDocumentId(subject.documentId) ||
    [...nodes.values()].some(node=>node.epochId===subject.newEpochId || node.runtime.documentId===subject.documentId)) {
    throw Error('INVALID_DOCUMENT_SET');
  }
  return subject;
}

async function admissionEvent(parent,item,provider) {
  if (item?.event?.version!==2 || item.event.kind!=='inviteAdult') throw Error('INVALID_ADMISSION');
  const checked=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
  if (checked.reason!=='ADMISSION_AND_PROJECTION_REQUIRED') throw Error(checked.reason ?? 'INVALID_ADMISSION');
  return checked.eventHash;
}

/** Structural association for authority replay. An install must additionally
 * authenticate the document bytes, provenance, ceremony and key packages. */
export async function checkCurrentDocumentSetManifest({pin,parent,item,eventHash,manifest,provider}) {
  return checkOrderedDocumentSetManifest({pin,parent,item,eventHash,manifest,provider,format:version,hashField:'admissionEventHash'});
}

async function checkOrderedDocumentSetManifest({pin,parent,item,eventHash,manifest,provider,format,hashField}) {
  const subject=item.event.subject;
  if (!exact(manifest,['version','rootPin','householdId','parentHead','authorizationSnapshot',hashField,
    'newDocumentId','newEpochId','newGeneration','sourceSetHash','catalog','entries']) ||
    manifest.version!==format || manifest.rootPin!==pin || manifest.householdId!==parent.householdId ||
    manifest.parentHead!==parent.head || !validDigest(manifest.authorizationSnapshot) ||
    manifest[hashField]!==eventHash || manifest.newDocumentId!==subject.documentId ||
    manifest.newEpochId!==subject.newEpochId || manifest.newGeneration!==subject.newGeneration ||
    !validDigest(manifest.sourceSetHash) || !exact(manifest.catalog,['sourceRevision','sourceHash','targetRevision','removed']) ||
    !validRevision(manifest.catalog.sourceRevision) || !validDigest(manifest.catalog.sourceHash) ||
    !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length>MAX_SELECTED_CHILDREN+1 ||
    manifest.catalog.targetRevision!==manifest.entries.length-1 ||
    !Array.isArray(manifest.catalog.removed) || manifest.catalog.removed.length>MAX_SELECTED_CHILDREN ||
    manifest.catalog.sourceRevision!==manifest.catalog.targetRevision+manifest.catalog.removed.length ||
    manifest.catalog.sourceRevision>MAX_SELECTED_CHILDREN) {
    throw Error('INVALID_DOCUMENT_SET');
  }
  for (const [index,commitment] of manifest.catalog.removed.entries()) {
    if (!validDigest(commitment) || index && manifest.catalog.removed[index-1]>=commitment) throw Error('INVALID_DOCUMENT_SET');
  }
  const target=documentScope(parent,subject.documentId,eventHash,subject.newEpochId,subject.newGeneration);
  const usedPeers=new Set([...Object.values(parent.runtime.authorPeers),...subject.devices.map(device=>device.peerId)]);
  const usedSeeds=new Set();
  const usedDocuments=new Set();
  for (const [index,entry] of manifest.entries.entries()) {
    if (!exact(entry,['recipeId','sourceDocumentId','sourceRevision','sourceHash','documentId','snapshotHash','policyBundleHash','seedId','peerId']) ||
      !validDigest(entry.snapshotHash) || !validSeedId(entry.seedId) || !validPeerId(entry.peerId) ||
      usedSeeds.has(entry.seedId) || usedPeers.has(entry.peerId) || usedDocuments.has(entry.documentId)) throw Error('INVALID_DOCUMENT_SET');
    usedSeeds.add(entry.seedId);
    usedPeers.add(entry.peerId);
    usedDocuments.add(entry.documentId);
    if (index===0) {
      if (entry.recipeId!==null || entry.sourceDocumentId!==parent.runtime.documentId || entry.documentId!==target.documentId ||
        !(entry.sourceRevision===null && entry.sourceHash===null && entry.policyBundleHash===null ||
          validRevision(entry.sourceRevision) && validDigest(entry.sourceHash) && validDigest(entry.policyBundleHash))) {
        throw Error('INVALID_DOCUMENT_SET');
      }
      continue;
    }
    if (!validId(entry.recipeId) || index>1 && manifest.entries[index-1].recipeId>=entry.recipeId ||
      !validRevision(entry.sourceRevision) || !validDigest(entry.sourceHash) || !validDigest(entry.policyBundleHash) ||
      entry.sourceDocumentId!==await recipeDocumentId(documentScope(parent),pin,provider,entry.recipeId) ||
      entry.documentId!==await recipeDocumentId(target,pin,provider,entry.recipeId)) throw Error('INVALID_DOCUMENT_SET');
  }
  return target;
}

/** The legacy public authority bundle includes earlier manifests verbatim. */
export function requirePublicRecipeHistory(state,liveRecipeIds) {
  for(const {admission} of state.events) {
    if(admission?.manifest?.version===5&&admission.manifest.entries.some(({recipeId})=>
      recipeId!==null&&!liveRecipeIds.has(recipeId))) throw Error('REMOVED_RECIPE_HISTORY');
  }
}

async function digestManifest(provider,manifest) {
  return selectedSourceHash(provider,'projection-manifest',manifest);
}

// Project only captured, authenticated documents. Target recipe IDs depend on the
// eventual authority event and are deliberately not derived here.
async function projectCapturedSet({runtime,service,provider,sources,source,allocateSeed}) {
  const entries=[],documents=[],removed=[];
  const omittedRecipeIds=new Set();
  const childRecipeIngredients=new Map();
  // Bind omitted children to the source without disclosing their recipe IDs.
  for(const [index,captured] of sources.slice(1).entries()){
    const recipeId=captured.runtime.recipeId;
    const recipe=captured.doc.getMap(`recipe:${encodeURIComponent(recipeId)}`);
    if(recipe.get('removed')===true||recipe.get('removedAt')){
      omittedRecipeIds.add(recipeId);
      removed.push(await selectedSourceHash(provider,'removed-recipe-source-v1',source.children[index]));
      continue;
    }
    const ingredients=new Set();
    const indexed=captured.doc.getMap(`recipe-ingredient-index:${encodeURIComponent(recipeId)}`).toJSON();
    for(const ingredientId of Object.keys(indexed)){
      const ingredient=captured.doc.getMap(`recipe-ingredient:${encodeURIComponent(JSON.stringify([recipeId,ingredientId]))}`);
      if(ingredient.get('removed')!==true&&!ingredient.get('removedAt'))ingredients.add(ingredientId);
    }
    childRecipeIngredients.set(recipeId,ingredients);
  }
  let projectedBytes=0;
  for (const [index,captured] of sources.entries()) {
    const recipeId=captured.runtime.recipeId;
    if(omittedRecipeIds.has(recipeId))continue;
    const allocation=await allocateSeed(captured.runtime.scope.documentId);
    if (!allocation) throw Error('SOURCE_CHANGED');
    const {seedId,peerId}=allocation;
    if (!validSeedId(seedId) || !validPeerId(peerId)) throw Error('INVALID_SEED');
    const {seed,bundle, bundleHash}=captured.bytes===null ? {
      seed:projectCurrentSeed({LoroDoc:runtime.LoroDoc,source:new runtime.LoroDoc().export({mode:'snapshot'}),
        seedId,peerId,schemaVersion:4}),bundle:null,bundleHash:null,
    } : await preparePolicyProjection({runtime:captured.runtime,service,provider,seedId,peerId,version:4,selectedSource:captured,
      ...(recipeId===null?{omittedRecipeIds,childRecipeIngredients}:{})});
    projectedBytes+=seed.snapshot.length;
    if (projectedBytes>MAX_SELECTED_SET_BYTES) throw Error('TOO_LARGE');
    entries.push({recipeId,sourceDocumentId:captured.runtime.scope.documentId,sourceRevision:captured.revision,
      sourceHash:index===0?source.root.checkpointHash:source.children[index-1].checkpointHash,seedId,peerId,
      snapshotHash:await selectedSourceHash(provider,'projection-snapshot',hex(seed.snapshot)),policyBundleHash:bundleHash});
    documents.push({seed,policyBundle:bundle});
  }
  removed.sort();
  return {entries,documents,removed};
}

/** Prepare a grant candidate from the exact selected source. The caller must
 * retain allocation IDs for retries and collect the existing admission quorum. */
export async function prepareCurrentDocumentSet({runtime,service,item,allocateSeed}) {
  item=structuredClone(item);
  const {provider,rootPin:pin}=runtime.authority;
  const {sources,signed,guard}=await observeSelectedSourceSet(runtime);
  const scope=guard.expectedAuthority.scope;
  const {selected:parent,state,record,nodes}=await verifySelectedSourceSet({storage:runtime.storage,scope,pin,provider,signed});
  const eventHash=await admissionEvent(parent,item,provider);
  const subject=newRoot(parent,item.event,nodes);
  const target=documentScope(parent,subject.documentId,eventHash,subject.newEpochId,subject.newGeneration);
  const {manifest:source}=signed;
  const manifest={version,rootPin:pin,householdId:parent.householdId,parentHead:parent.head,
    authorizationSnapshot:record.authorizationSnapshot,admissionEventHash:eventHash,
    newDocumentId:target.documentId,newEpochId:target.epochId,newGeneration:target.documentGeneration,
    sourceSetHash:await selectedSourceHash(provider,'selected-household-source-set-v1',source),
    catalog:{sourceRevision:source.catalog.revision,sourceHash:source.catalog.hash,targetRevision:0,removed:[]},entries:[]};
  const projected=await projectCapturedSet({runtime,service,provider,sources,source,allocateSeed});
  manifest.catalog.targetRevision=projected.documents.length-1;
  manifest.catalog.removed=projected.removed;
  const documents=[];
  for (const [index,entry] of projected.entries.entries()) {
    const documentId=entry.recipeId===null ? target.documentId : await recipeDocumentId(target,pin,provider,entry.recipeId);
    const {seedId,peerId,snapshotHash,policyBundleHash,...sourceEntry}=entry;
    manifest.entries.push({...sourceEntry,documentId,seedId,peerId,snapshotHash,policyBundleHash});
    documents.push({documentId,...projected.documents[index]});
  }
  await checkCurrentDocumentSetManifest({pin,parent,item,eventHash,manifest,provider});
  await verifyDocuments({manifest,documents,provider,pin,state,LoroDoc:runtime.LoroDoc});
  const unchanged=await runtime.storage.checkSelectedHouseholdSources(guard);
  if (!unchanged.ok) throw Error(unchanged.error.code);
  return {manifest,manifestHash:await digestManifest(provider,manifest),documents,source:guard};
}

/** Capture current cooking values for adult removal only. This is unsigned
 * preparation, not an authorization, publication, or suspect-device recovery.
 * The caller must recheck source before use and derive child IDs after signing. */
export async function prepareAdultRemovalProjection({runtime,service,destination,allocateSeed}) {
  destination=structuredClone(destination);
  const {provider,rootPin:pin}=runtime.authority;
  const {sources,signed,guard}=await observeSelectedSourceSet(runtime);
  const {selected:parent,nodes}=await verifySelectedSourceSet({storage:runtime.storage,
    scope:guard.expectedAuthority.scope,pin,provider,signed});
  if (!exact(destination,['parentHead','documentId','epochId','generation']) ||
    destination.parentHead!==parent.head || !validId(destination.documentId) ||
    !validId(destination.epochId) || !validRevision(destination.generation) ||
    destination.generation<=parent.generation || isRecipeDocumentId(destination.documentId) ||
    isPolicyDocumentId(destination.documentId) || [...nodes.values()].some(node=>
      node.epochId===destination.epochId || node.runtime.documentId===destination.documentId)) {
    throw Error('INVALID_DOCUMENT_SET');
  }
  const projected=await projectCapturedSet({runtime,service,provider,sources,source:signed.manifest,allocateSeed});
  const unchanged=await runtime.storage.checkSelectedHouseholdSources(guard);
  if (!unchanged.ok) throw Error(unchanged.error.code);
  return {destination:structuredClone(destination),source:guard,sourceManifest:signed.manifest,...projected};
}

// This is proposal verification only. The parent and ancestry must be verified
// independently by the caller; the result grants no publication authority.
export async function verifyAdultRemovalDocumentSetManifest({pin,parent,nodes,state,provider,item,manifest}) {
  ({parent,nodes,state,item,manifest}=structuredClone({parent,nodes,state,item,manifest}));
  if (!exact(item,['event','authorSignature','approvals']) || item.event?.version!==2 || item.event.kind!=='removeAdult') throw Error('INVALID_REMOVAL');
  const checked=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
  if (!['QUORUM_REQUIRED','ROTATION_DISTRIBUTION_REQUIRED'].includes(checked.reason)) throw Error(checked.reason ?? 'INVALID_REMOVAL');
  if (state.activeHead!==parent.head || manifest?.authorizationSnapshot!==await selectedSourceHash(provider,'authority-state',state)) throw Error('INVALID_DOCUMENT_SET');
  newRoot(parent,item.event,nodes);
  await checkOrderedDocumentSetManifest({pin,parent,item,eventHash:checked.eventHash,manifest,provider,format:6,hashField:'removalEventHash'});
  return {eventHash:checked.eventHash,manifestHash:await digestManifest(provider,manifest),
    approvals:checked.approvals,required:checked.required,complete:checked.reason==='ROTATION_DISTRIBUTION_REQUIRED'};
}

export async function verifyAdultRemovalDocumentSet({pin,parent,nodes,state,provider,item,manifest,documents,LoroDoc}) {
  ({parent,nodes,state,item,manifest,documents}=structuredClone({parent,nodes,state,item,manifest,documents}));
  const checked=await verifyAdultRemovalDocumentSetManifest({pin,parent,nodes,state,provider,item,manifest});
  await verifyDocuments({manifest,documents,provider,pin,state,LoroDoc});
  return checked;
}

/** Prepare a public complete-set proposal from authenticated current sources. */
export async function prepareAdultRemovalDocumentSet({runtime,service,item,allocateSeed}) {
  item=structuredClone(item);
  const {provider,rootPin:pin}=runtime.authority;
  const subject=item?.event?.subject;
  const destination={parentHead:item?.event?.parentHead,documentId:subject?.documentId,
    epochId:subject?.newEpochId,generation:subject?.newGeneration};
  const captured=await prepareAdultRemovalProjection({runtime,service,destination,allocateSeed});
  const {record,state,nodes}=await verifyPublicParent(runtime.storage,captured.source.expectedAuthority.scope,pin,provider);
  const parent=nodes.get(state.activeHead);
  if (!parent || parent.head!==destination.parentHead || record.authorizationSnapshot!==captured.sourceManifest.authorizationSnapshot) throw Error('SOURCE_CHANGED');
  if (!exact(item,['event','authorSignature','approvals']) || item.event?.version!==2 || item.event.kind!=='removeAdult') throw Error('INVALID_REMOVAL');
  const checked=await validateSuccessor(parent,item.event,item.authorSignature,item.approvals,provider);
  if (!['QUORUM_REQUIRED','ROTATION_DISTRIBUTION_REQUIRED'].includes(checked.reason)) throw Error(checked.reason ?? 'INVALID_REMOVAL');
  newRoot(parent,item.event,nodes);
  const target=documentScope(parent,subject.documentId,checked.eventHash,subject.newEpochId,subject.newGeneration);
  const source=captured.sourceManifest;
  const manifest={version:6,rootPin:pin,householdId:parent.householdId,parentHead:parent.head,
    authorizationSnapshot:record.authorizationSnapshot,removalEventHash:checked.eventHash,
    newDocumentId:target.documentId,newEpochId:target.epochId,newGeneration:target.documentGeneration,
    sourceSetHash:await selectedSourceHash(provider,'selected-household-source-set-v1',source),
    catalog:{sourceRevision:source.catalog.revision,sourceHash:source.catalog.hash,
      targetRevision:captured.documents.length-1,removed:captured.removed},entries:[]};
  const documents=[];
  for (const [index,entry] of captured.entries.entries()) {
    const documentId=entry.recipeId===null?target.documentId:await recipeDocumentId(target,pin,provider,entry.recipeId);
    const {seedId,peerId,snapshotHash,policyBundleHash,...sourceEntry}=entry;
    manifest.entries.push({...sourceEntry,documentId,seedId,peerId,snapshotHash,policyBundleHash});
    documents.push({documentId,...captured.documents[index]});
  }
  const result=await verifyAdultRemovalDocumentSet({pin,parent,nodes,state,provider,item,manifest,documents,LoroDoc:runtime.LoroDoc});
  const unchanged=await runtime.storage.checkSelectedHouseholdSources(captured.source);
  if (!unchanged.ok) throw Error(unchanged.error.code);
  return {manifest,documents,source:captured.source,...result};
}

function checkSeedIdentities(seed,state,allEffects,allCommands) {
  const purchases=Object.keys(state.purchases??{}).sort();
  if (!same(seed.purchaseIds,purchases)) throw Error('INVALID_SEED');
  for (const [index,identity] of seed.identities.entries()) {
    const {effectId,commandId}=identity;
    if (allEffects.has(effectId) || allCommands.has(commandId) ||
      (!purchases.includes(effectId) && (effectId!==`seed:${seed.seedId}:${index}` ||
        commandId!==`seed-command:${seed.seedId}:${index}`))) throw Error('INVALID_SEED');
    allEffects.add(effectId);
    allCommands.add(commandId);
  }
}

function checkChildState(state,recipeId) {
  const scoped=encodeURIComponent(recipeId);
  const maps=new Set(['recipe-index','domain-effects',`recipe:${scoped}`,
    `recipe-ingredient-index:${scoped}`,`recipe-step-index:${scoped}`]);
  for (const [kind,prefix] of [['ingredient','recipe-ingredient'],['step','recipe-step']]) {
    for (const member of Object.keys(state[`${prefix}-index:${scoped}`]??{})) {
      const pair=JSON.stringify([recipeId,member]);
      maps.add(`${prefix}:${encodeURIComponent(pair)}`);
      const fields=kind==='ingredient'?['name','amount','needsShopping','position','removed']:['text','position','removed'];
      for (const field of fields) maps.add(`field-head:${encodeURIComponent(JSON.stringify([kind,pair,field]))}`);
    }
  }
  for (const field of ['title','description','portions','notes','createdAt','updatedAt','removed']) {
    maps.add(`field-head:${encodeURIComponent(JSON.stringify(['recipe',recipeId,field]))}`);
  }
  if (!same(Object.keys(state['recipe-index']??{}),[recipeId]) || !state[`recipe:${scoped}`] ||
    Object.keys(state).some(name=>!maps.has(name))) throw Error('INVALID_DOCUMENT_SET');
}

async function verifyDocuments({manifest,documents,provider,pin,state,LoroDoc}) {
  if (!Array.isArray(documents) || documents.length!==manifest.entries.length) throw Error('INVALID_DOCUMENT_SET');
  let bytes=0;
  const effects=new Set(),commands=new Set(),childIds=new Set(manifest.entries.slice(1).map(entry=>entry.recipeId));
  for (const [index,document] of documents.entries()) {
    const entry=manifest.entries[index];
    if (!exact(document,['documentId','seed','policyBundle']) || document.documentId!==entry.documentId ||
      !exact(document.seed,['version','seedId','peerId','snapshot','identities','purchaseIds']) ||
      document.seed.version!==1 || document.seed.seedId!==entry.seedId || document.seed.peerId!==entry.peerId ||
      !(document.seed.snapshot instanceof Uint8Array) || !document.seed.snapshot.length ||
      document.seed.snapshot.length>MAX_SELECTED_SOURCE_BYTES) throw Error('INVALID_DOCUMENT_SET');
    bytes+=document.seed.snapshot.length;
    if (bytes>MAX_SELECTED_SET_BYTES) throw Error('TOO_LARGE');
    const {seed,policyBundle}=document;
    if (await selectedSourceHash(provider,'projection-snapshot',hex(seed.snapshot))!==entry.snapshotHash) {
      throw Error('INVALID_DOCUMENT_SET');
    }
    const checked=verifyCurrentSeed({LoroDoc,snapshot:seed.snapshot,seed,schemaVersion:4,requireComplete:true});
    if (checked.peers.some(peer=>peer!==seed.peerId)) throw Error('INVALID_SEED');
    checkSeedIdentities(seed,checked.state,effects,commands);
    if (entry.recipeId!==null) checkChildState(checked.state,entry.recipeId);
    else if (Object.keys(checked.state['recipe-index']??{}).some(recipeId=>childIds.has(recipeId))) throw Error('INVALID_DOCUMENT_SET');
    if (entry.sourceRevision===null) {
      if (policyBundle!==null || Object.keys(checked.state).length) throw Error('INVALID_DOCUMENT_SET');
      continue;
    }
    if (policyBundle?.version!==4) throw Error('INVALID_DOCUMENT_SET');
    await verifyPolicyProjection({provider,pin,state,seed,bundle:policyBundle,
      expectedBundleHash:entry.policyBundleHash,expectedSourceHead:manifest.parentHead,
      expectedSourceDocument:entry.sourceDocumentId,expectedSourceRevision:entry.sourceRevision,LoroDoc,
      selectedRecipeId:entry.recipeId??undefined,allowEmpty:true});
  }
}

/** Verify a complete current-cooking set against the recipient's independently
 * retained parent and the existing admission agreement and grant signatures. */
export async function verifyCurrentDocumentSetGrant({storage,scope,pin,provider,item,grant,manifest}) {
  ({item,grant,manifest}=structuredClone({item,grant,manifest}));
  const {record,state,nodes}=await verifyPublicParent(storage,scope,pin,provider);
  const parent=nodes.get(record.acceptedParent);
  const eventHash=await admissionEvent(parent,item,provider);
  const subject=newRoot(parent,item.event,nodes);
  await checkCurrentDocumentSetManifest({pin,parent,item,eventHash,manifest,provider});
  const proof=await checkGrantSignatures(parent,grant,provider);
  if (proof.reason!=='ADMISSION_EVIDENCE_REQUIRED' || grant.admissionEventHash!==eventHash ||
    grant.recipientAdult!==subject.adultId || !same(grant.recipientDevices,subject.devices.map(device=>device.deviceId)) ||
    grant.newEpochId!==subject.newEpochId || grant.newDocumentGeneration!==subject.newGeneration ||
    !same(grant.contentClasses,contentClasses) || grant.projectionManifestHash!==await digestManifest(provider,manifest) ||
    manifest.authorizationSnapshot!==record.authorizationSnapshot) throw Error('INVALID_DOCUMENT_SET_GRANT');
  let delegated=false;
  for (const agreement of state.agreements??[]) {
    if (agreement.parentHead!==parent.head || !same(agreement.sourcePolicyHashes,grant.sourcePolicyHashes)) continue;
    const acceptance=await checkAdmissionAgreement(parent,agreement,provider);
    if (acceptance.status==='accepted' && acceptance.delegationHash===grant.delegationHash) {
      delegated=true;
      break;
    }
  }
  if (!delegated) throw Error('DELEGATION_REQUIRED');
  return {record,eventHash,grantHash:proof.grantHash,manifest,state};
}

export async function verifyCurrentDocumentSet({storage,scope,pin,provider,item,grant,manifest,documents,LoroDoc}) {
  documents=structuredClone(documents);
  const {state,...checked}=await verifyCurrentDocumentSetGrant({storage,scope,pin,provider,item,grant,manifest});
  await verifyDocuments({manifest:checked.manifest,documents,provider,pin,state,LoroDoc});
  return {...checked,documents};
}

/** A publisher must rederive the signed draft from the selected source. A
 * valid quorum signature alone cannot establish that a live child was included. */
export async function verifyCurrentDocumentSetSource({runtime,service,item,manifest,documents}) {
  ({item,manifest,documents}=structuredClone({item,manifest,documents}));
  if (!Array.isArray(manifest?.entries) || manifest.entries.length>MAX_SELECTED_CHILDREN+1) throw Error('INVALID_DOCUMENT_SET');
  const allocations=new Map(manifest.entries.map(entry=>[entry.sourceDocumentId,{seedId:entry.seedId,peerId:entry.peerId}]));
  const rebuilt=await prepareCurrentDocumentSet({runtime,service,item,allocateSeed:documentId=>allocations.get(documentId)});
  if (await digestManifest(runtime.authority.provider,manifest)!==rebuilt.manifestHash ||
    !Array.isArray(documents) || documents.length!==rebuilt.documents.length ||
    documents.some((document,index)=>{
      const rebuiltDocument=rebuilt.documents[index];
      if (document?.documentId!==rebuiltDocument.documentId || !(document.seed?.snapshot instanceof Uint8Array)) return true;
      const {snapshot,...seed}=document.seed,{snapshot:rebuiltSnapshot,...rebuiltSeed}=rebuiltDocument.seed;
      return !sameBytes(snapshot,rebuiltSnapshot) || !same(seed,rebuiltSeed) ||
        !same(document.policyBundle,rebuiltDocument.policyBundle);
    })) throw Error('SOURCE_CHANGED');
  return rebuilt.source;
}
