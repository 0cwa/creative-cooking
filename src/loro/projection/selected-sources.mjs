import {openSelectedRecipeCatalog,openShoppingRecipeCatalog} from '../app/selected-recipe-catalog.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {domain} from '../authority/validator.mjs';
import {MAX_SELECTED_CHILDREN,MAX_SELECTED_SOURCE_BYTES,MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';
import {recipeDocumentId} from '../domain/recipe-document.mjs';
import {replayAuthenticated} from '../domain/replay.mjs';

const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value,field));
const id = value => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 256;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const hex = bytes => Array.from(bytes,byte => byte.toString(16).padStart(2,'0')).join('');
const same = (left,right) => {
  const a=domain('selected-sources-comparison',left),b=domain('selected-sources-comparison',right);
  return a.length===b.length && a.every((byte,index)=>byte===b[index]);
};

export async function selectedSourceHash(provider,purpose,value) {
  const result = await provider.hash(domain(purpose,value));
  if (!(result instanceof Uint8Array) || result.length !== 32) throw Error('INVALID_PROOF');
  return hex(result);
}

const sourceSnapshotHash = (provider,bytes) =>
  selectedSourceHash(provider,'projection-source-snapshot',hex(bytes));
const catalogHash = (provider,children) => selectedSourceHash(provider,'selected-recipe-catalog-v1',
  children.map(({recipeId,documentId,creationEffectId,creationObjectId,creationParentRevision}) =>
    ({recipeId,documentId,creationEffectId,creationObjectId,creationParentRevision})));

function validDocument(entry) {
  return exact(entry,['documentId','revision','checkpointHash']) && id(entry.documentId) &&
    (entry.revision === null ? entry.checkpointHash === null : revision(entry.revision) && digest(entry.checkpointHash));
}

async function validateManifest(manifest, record, selected, pin, provider, admittedMembers=[]) {
  if (!exact(manifest,['version','rootPin','householdId','parentHead','authorizationSnapshot',
    'authorityRevision','epochId','generation','root','catalog','children']) || ![1,2].includes(manifest.version) ||
    manifest.rootPin !== pin || manifest.householdId !== selected.householdId ||
    manifest.parentHead !== selected.head || manifest.authorizationSnapshot !== record.authorizationSnapshot ||
    !revision(manifest.authorityRevision) || manifest.epochId !== selected.epochId ||
    manifest.generation !== selected.generation || !validDocument(manifest.root) ||
    manifest.root.documentId !== selected.runtime.documentId ||
    !exact(manifest.catalog,['revision','hash']) || !digest(manifest.catalog.hash) ||
    !Array.isArray(manifest.children) || manifest.children.length > MAX_SELECTED_CHILDREN ||
    // The catalog is insert-only on this head. The number of durable rows is
    // its revision. The digest commits their exact identities and bindings.
    manifest.catalog.revision !== manifest.children.length) throw Error('INVALID_SOURCE_SET');

  const scope = {scopeId:selected.householdId,branchHead:selected.head,epochId:selected.epochId,
    documentGeneration:selected.generation,documentId:selected.runtime.documentId};
  const admitted=manifest.version===2 ? new Map(admittedMembers.map(member=>[member.recipeId,member.documentId])) : new Map();
  const documents = new Set([manifest.root.documentId]), effects = new Set(), objects = new Set(), seenAdmitted=new Set();
  for (const [index,child] of manifest.children.entries()) {
    if (!exact(child,['recipeId','documentId','revision','checkpointHash','creationEffectId',
      'creationObjectId','creationParentRevision']) || !id(child.recipeId) ||
      !revision(child.revision) || !digest(child.checkpointHash) ||
      !(child.creationEffectId===null && child.creationObjectId===null && child.creationParentRevision===null &&
          admitted.get(child.recipeId)===child.documentId || id(child.creationEffectId) && digest(child.creationObjectId) &&
          !admitted.has(child.recipeId) && (child.creationParentRevision === null || revision(child.creationParentRevision) &&
        manifest.root.revision !== null && child.creationParentRevision <= manifest.root.revision)) ||
      (index && manifest.children[index-1].recipeId >= child.recipeId) ||
      documents.has(child.documentId) || child.creationEffectId!==null && effects.has(child.creationEffectId) ||
      child.creationObjectId!==null && objects.has(child.creationObjectId) ||
      child.documentId !== await recipeDocumentId(scope,pin,provider,child.recipeId)) throw Error('INVALID_SOURCE_SET');
    documents.add(child.documentId);
    if(child.creationEffectId===null)seenAdmitted.add(child.recipeId);
    else {effects.add(child.creationEffectId);objects.add(child.creationObjectId);}
  }
  if (seenAdmitted.size!==admitted.size || manifest.catalog.hash !== await catalogHash(provider,manifest.children)) throw Error('INVALID_SOURCE_SET');
}

/** Check a signed observation against a locally pinned, independently retained
 * public parent. Revisions describe the publisher's database, not this peer's. */
export async function verifySelectedSourceSet({storage,scope,pin,provider,signed}) {
  signed = structuredClone(signed);
  if (!exact(signed,['manifest','deviceId','signature']) || !id(signed.deviceId) ||
    typeof signed.signature !== 'string' || !/^[a-f0-9]{128}$/.test(signed.signature)) throw Error('INVALID_SOURCE_SET');
  const {record,state,nodes} = await verifyPublicParent(storage,scope,pin,provider);
  const selected = nodes.get(state.activeHead);
  let admittedMembers=[];
  const item=state.events.find(item=>item.admission?.grant.admissionEventHash===state.activeHead && item.admission.manifest?.version===5);
  if((signed.manifest?.version===2)!==!!item)throw Error('INVALID_SOURCE_SET');
  if(item)admittedMembers=item.admission.manifest.entries.slice(1).map(({recipeId,documentId})=>({recipeId,documentId}));
  await validateManifest(signed.manifest,record,selected,pin,provider,admittedMembers);
  const author = selected.devices.find(device => device.active && device.deviceId === signed.deviceId);
  const signature = Uint8Array.from(signed.signature.match(/../g),pair => parseInt(pair,16));
  const message = domain('selected-household-sources-v1',{manifest:signed.manifest,deviceId:signed.deviceId});
  if (!author || !await provider.verify(author.signingKeyRef,message,signature)) throw Error('INVALID_SOURCE_SIGNATURE');
  return {manifest:signed.manifest,record,state,nodes,selected};
}

const visible = doc => Object.fromEntries(Object.entries(doc.toJSON()).filter(([,value]) => Object.keys(value).length));

async function authenticateSource(runtime,bytes,doc,verifyCheckpointHistory) {
  if (bytes === null) return;
  const replay = await replayAuthenticated({runtime,checkpoint:bytes,verifyCheckpointHistory});
  if (replay.held.length || !same(visible(doc),visible(replay.doc))) throw Error('INCOMPLETE_SOURCE');
}

/** Capture and authenticate the complete source set, then recheck every
 * document and catalog entry together before returning the signed observation. */
export async function observeSelectedSourceSet(runtime,{verifyCheckpointHistory=false}={}) {
  const catalog = await openSelectedRecipeCatalog(runtime,undefined,MAX_SELECTED_CHILDREN);
  const {binding,expectedAuthority,parent,entries,catalogRevision,children} = catalog;
  const {provider,rootPin} = runtime.authority;
  const auth=await runtime.authorization();
  const admitted=(auth.members??[]).filter(member=>member.recipeId!==null);
  let capturedBytes=(parent.storedBytes?.length??0)+entries.reduce((sum,entry)=>sum+entry.bytes.length+entry.envelope.length,0);
  if(admitted.length+entries.length>MAX_SELECTED_CHILDREN || admitted.some(member=>entries.some(entry=>entry.recipeId===member.recipeId||entry.documentId===member.documentId)))throw Error('CONFLICT');
  const guard = {binding,expectedAuthority,catalogRevision,...(auth.members?{members:[]}:{}),root:parent.storedBytes === null ? null :
    {documentId:binding.sourceDocumentId,revision:parent.revision,bytes:parent.storedBytes},entries};
  await authenticateSource(runtime,parent.storedBytes,parent.doc,verifyCheckpointHistory);
  const manifestChildren = [];
  const sources = [{runtime,revision:parent.revision,bytes:parent.storedBytes,doc:parent.doc}];
  entries.sort((left,right) => left.recipeId < right.recipeId ? -1 : 1);
  for (const entry of entries) {
    const childRuntime = await runtime.forRecipe(entry.recipeId);
    const {doc}=children.get(entry.recipeId);
    await authenticateSource(childRuntime,entry.bytes,doc,verifyCheckpointHistory);
    sources.push({runtime:childRuntime,revision:entry.revision,bytes:entry.bytes,doc});
    manifestChildren.push({recipeId:entry.recipeId,documentId:entry.documentId,revision:entry.revision,
      checkpointHash:await sourceSnapshotHash(provider,entry.bytes),creationEffectId:entry.effectId,
      creationObjectId:entry.objectId,creationParentRevision:entry.sourceRevision});
  }
  for(const member of admitted){
    const captured=await openShoppingRecipeCatalog(runtime,member.recipeId),child=captured.children.get(member.recipeId);
    if(!child?.admitted||!same(captured.expectedAuthority,expectedAuthority))throw Error('CONFLICT');
    capturedBytes+=child.storedBytes.length;
    if(child.storedBytes.length>MAX_SELECTED_SOURCE_BYTES||capturedBytes>MAX_SELECTED_SET_BYTES)throw Error('TOO_LARGE');
    const childRuntime=await runtime.forRecipe(member.recipeId);
    await authenticateSource(childRuntime,child.storedBytes,child.doc,verifyCheckpointHistory);
    guard.members.push({recipeId:member.recipeId,documentId:member.documentId,revision:child.revision,bytes:child.storedBytes});
    sources.push({runtime:childRuntime,revision:child.revision,bytes:child.storedBytes,doc:child.doc,admitted:true});
    manifestChildren.push({recipeId:member.recipeId,documentId:member.documentId,revision:child.revision,
      checkpointHash:await sourceSnapshotHash(provider,child.storedBytes),creationEffectId:null,creationObjectId:null,creationParentRevision:null});
  }
  const sorted=sources.slice(1).sort((a,b)=>a.runtime.recipeId<b.runtime.recipeId?-1:1);
  sources.splice(1,sources.length-1,...sorted);
  manifestChildren.sort((a,b)=>a.recipeId<b.recipeId?-1:1);
  const manifest = {
    version:auth.members?2:1,rootPin,householdId:binding.scopeId,parentHead:binding.branchHead,
    authorizationSnapshot:expectedAuthority.record.authorizationSnapshot,authorityRevision:expectedAuthority.record.revision,
    epochId:binding.epochId,generation:binding.documentGeneration,
    root:{documentId:binding.sourceDocumentId,revision:parent.revision,
      checkpointHash:parent.storedBytes === null ? null : await sourceSnapshotHash(provider,parent.storedBytes)},
    catalog:{revision:catalogRevision+admitted.length,hash:await catalogHash(provider,manifestChildren)},children:manifestChildren,
  };
  const {signingKeyRefs} = await runtime.authorization();
  const deviceId = runtime.scope.authorDevice;
  const signature = await provider.sign(signingKeyRefs[deviceId],
    domain('selected-household-sources-v1',{manifest,deviceId}));
  const signed = {manifest,deviceId,signature:hex(signature)};
  await verifySelectedSourceSet({storage:runtime.storage,scope:expectedAuthority.scope,pin:rootPin,provider,signed});
  const checked = await runtime.storage.checkSelectedHouseholdSources(guard);
  if (!checked.ok) throw Error(checked.error.code);
  return {signed,sources,guard};
}
