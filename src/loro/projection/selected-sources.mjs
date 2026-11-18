import {openSelectedRecipeCatalog} from '../app/selected-recipe-catalog.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {domain} from '../authority/validator.mjs';
import {MAX_SELECTED_CHILDREN} from '../contracts/runtime-storage.ts';
import {recipeDocumentId} from '../domain/recipe-document.mjs';
import {replayAuthenticated} from '../domain/replay.mjs';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SET_BYTES = 8 * 1024 * 1024;
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

async function validateManifest(manifest, record, selected, pin, provider) {
  if (!exact(manifest,['version','rootPin','householdId','parentHead','authorizationSnapshot',
    'authorityRevision','epochId','generation','root','catalog','children']) || manifest.version !== 1 ||
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
  const documents = new Set([manifest.root.documentId]), effects = new Set(), objects = new Set();
  for (const [index,child] of manifest.children.entries()) {
    if (!exact(child,['recipeId','documentId','revision','checkpointHash','creationEffectId',
      'creationObjectId','creationParentRevision']) || ![child.recipeId,child.creationEffectId].every(id) ||
      !revision(child.revision) || ![child.checkpointHash,child.creationObjectId].every(digest) ||
      !(child.creationParentRevision === null || revision(child.creationParentRevision) &&
        manifest.root.revision !== null && child.creationParentRevision <= manifest.root.revision) ||
      (index && manifest.children[index-1].recipeId >= child.recipeId) ||
      documents.has(child.documentId) || effects.has(child.creationEffectId) || objects.has(child.creationObjectId) ||
      child.documentId !== await recipeDocumentId(scope,pin,provider,child.recipeId)) throw Error('INVALID_SOURCE_SET');
    documents.add(child.documentId);
    effects.add(child.creationEffectId);
    objects.add(child.creationObjectId);
  }
  if (manifest.catalog.hash !== await catalogHash(provider,manifest.children)) throw Error('INVALID_SOURCE_SET');
}

/** Check a signed observation against a locally pinned, independently retained
 * public parent. Revisions describe the publisher's database, not this peer's. */
export async function verifySelectedSourceSet({storage,scope,pin,provider,signed}) {
  signed = structuredClone(signed);
  if (!exact(signed,['manifest','deviceId','signature']) || !id(signed.deviceId) ||
    typeof signed.signature !== 'string' || !/^[a-f0-9]{128}$/.test(signed.signature)) throw Error('INVALID_SOURCE_SET');
  const {record,state,nodes} = await verifyPublicParent(storage,scope,pin,provider);
  const selected = nodes.get(state.activeHead);
  await validateManifest(signed.manifest,record,selected,pin,provider);
  const author = selected.devices.find(device => device.active && device.deviceId === signed.deviceId);
  const signature = Uint8Array.from(signed.signature.match(/../g),pair => parseInt(pair,16));
  const message = domain('selected-household-sources-v1',{manifest:signed.manifest,deviceId:signed.deviceId});
  if (!author || !await provider.verify(author.signingKeyRef,message,signature)) throw Error('INVALID_SOURCE_SIGNATURE');
  return {manifest:signed.manifest,record,state,selected};
}

const visible = doc => Object.fromEntries(Object.entries(doc.toJSON()).filter(([,value]) => Object.keys(value).length));

async function authenticateSource(runtime,bytes,doc) {
  if (bytes === null) return;
  const replay = await replayAuthenticated({runtime,checkpoint:bytes});
  if (replay.held.length || !same(visible(doc),visible(replay.doc))) throw Error('INCOMPLETE_SOURCE');
}

/** Read a complete source set from one storage transaction, then authenticate
 * each captured source with its retained envelopes before signing the set. */
export async function observeSelectedSourceSet(runtime) {
  const catalog = await openSelectedRecipeCatalog(runtime,undefined,MAX_SELECTED_CHILDREN);
  const {binding,expectedAuthority,parent,entries,catalogRevision,children} = catalog;
  const raw = [parent.storedBytes,...entries.map(entry => entry.bytes)];
  if (raw.some(bytes => bytes && bytes.length > MAX_SOURCE_BYTES) ||
    raw.reduce((sum,bytes) => sum + (bytes?.length ?? 0),0) > MAX_SET_BYTES) throw Error('TOO_LARGE');
  const {provider,rootPin} = runtime.authority;
  const guard = {binding,expectedAuthority,catalogRevision,root:parent.storedBytes === null ? null :
    {documentId:binding.sourceDocumentId,revision:parent.revision,bytes:parent.storedBytes},entries};
  await authenticateSource(runtime,parent.storedBytes,parent.doc);
  const manifestChildren = [];
  const sources = [{runtime,revision:parent.revision,bytes:parent.storedBytes}];
  entries.sort((left,right) => left.recipeId < right.recipeId ? -1 : 1);
  for (const entry of entries) {
    const childRuntime = await runtime.forRecipe(entry.recipeId);
    await authenticateSource(childRuntime,entry.bytes,children.get(entry.recipeId).doc);
    sources.push({runtime:childRuntime,revision:entry.revision,bytes:entry.bytes});
    manifestChildren.push({recipeId:entry.recipeId,documentId:entry.documentId,revision:entry.revision,
      checkpointHash:await sourceSnapshotHash(provider,entry.bytes),creationEffectId:entry.effectId,
      creationObjectId:entry.objectId,creationParentRevision:entry.sourceRevision});
  }
  const manifest = {
    version:1,rootPin,householdId:binding.scopeId,parentHead:binding.branchHead,
    authorizationSnapshot:expectedAuthority.record.authorizationSnapshot,authorityRevision:expectedAuthority.record.revision,
    epochId:binding.epochId,generation:binding.documentGeneration,
    root:{documentId:binding.sourceDocumentId,revision:parent.revision,
      checkpointHash:parent.storedBytes === null ? null : await sourceSnapshotHash(provider,parent.storedBytes)},
    catalog:{revision:catalogRevision,hash:await catalogHash(provider,manifestChildren)},children:manifestChildren,
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
