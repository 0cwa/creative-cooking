import {decodeCookingPayload,validateCookingHeader} from '../disclosure/cooking.mjs';
import {projectRecipes} from '../domain/app-projection.mjs';
import {commandRecipeId,recipeCatalogBinding,recipeDocumentId} from '../domain/recipe-document.mjs';
import {bytes,validateOperations} from '../domain/registry.mjs';
import {policyBaseline,verifyPolicyBaseline} from '../authority/policy-baseline.mjs';

const sameBytes=(a,b)=>a?.length===b?.length && (a==null || a.every((value,index)=>value===b[index]));

export async function verifyRecipeCreation(runtime, scope, opened, objectId) {
  validateCookingHeader(opened,objectId,scope);
  const {command,update}=decodeCookingPayload(opened);
  const recipeId=commandRecipeId(command);
  if(command.kind!=='recipe-create'||command.data.author!==opened.header.authorDevice)throw Error('INVALID_RECIPE_DOCUMENT');
  const initial=new runtime.LoroDoc(),change=Uint8Array.from(update),meta=runtime.inspectUpdate(change);
  if(meta.peer!==scope.authorPeers[opened.header.authorDevice] || meta.frontiers.length ||
     opened.header.predecessorRefs.length || command.dependencyEffectIds.length || initial.import(change).pending?.size) {
    throw Error('INVALID_RECIPE_DOCUMENT');
  }
  validateOperations(command,initial.exportJsonUpdates(undefined,undefined,false).changes);
  return {initial,command,recipeId};
}

/** Match durable catalog entries to signed creation and the retained document. */
export async function readRecipeCatalog(runtime, auth, recipeId, maxChildren) {
  const root={...runtime.scope,documentId:auth.sourceDocumentId};
  const {rootPin,provider}=runtime.authority;
  const binding=recipeCatalogBinding(root,rootPin);
  const target=recipeId===undefined?undefined:{recipeId,documentId:await recipeDocumentId(root,rootPin,provider,recipeId)};
  const result=await runtime.storage.readSelectedRecipeCatalog(auth.expectedAuthority,binding,target,maxChildren);
  if (!result.ok) throw Error(result.error.code);
  const {source,entries,catalogRevision}=result.value;
  const rootDoc=new runtime.LoroDoc();
  if(source)rootDoc.import(source.bytes);
  const index=rootDoc.getMap('recipe-index');
  const children=new Map();
  for (const entry of entries) {
    if (index.get(entry.recipeId)) throw Error('CONFLICT');
    const documentId=await recipeDocumentId(root,rootPin,provider,entry.recipeId);
    if (documentId!==entry.documentId) throw Error('INVALID_RECIPE_DOCUMENT');
    const opened=await runtime.codec.openContent(entry.envelope,auth.signingKeyRefs);
    if(auth.members&&!opened.recipeDelivery)throw Error('INVALID_RECIPE_DOCUMENT');
    const {command,initial,recipeId}=await verifyRecipeCreation(runtime,{...root,documentId},opened,entry.objectId);
    if (recipeId!==entry.recipeId||command.effectId!==entry.effectId)throw Error('INVALID_RECIPE_DOCUMENT');
    const doc=new runtime.LoroDoc();
    if(doc.import(entry.bytes).pending?.size)throw Error('INVALID_RECIPE_DOCUMENT');
    const recipeIndex=doc.getMap('recipe-index').toJSON();
    const marker=doc.getMap('domain-effects').get(entry.effectId);
    if (Object.keys(recipeIndex).length!==1 || recipeIndex[entry.recipeId]!==entry.effectId ||
        marker?.version!==2 || !sameBytes(bytes(marker.command),bytes(command))) throw Error('INVALID_RECIPE_DOCUMENT');
    const baseline=await policyBaseline(initial,provider);
    await verifyPolicyBaseline(doc,runtime.LoroDoc,baseline,provider);
    children.set(entry.recipeId,{documentId,doc,revision:entry.revision,creationObjectId:entry.objectId});
  }
  return {binding,source,children,entries,catalogRevision,expectedAuthority:auth.expectedAuthority};
}

export async function openSelectedRecipeCatalog(runtime, recipeId, maxChildren) {
  const auth=await runtime.authorization();
  if (!auth.sourceDocumentId || runtime.recipeId!==null || auth.sourceDocumentId!==runtime.scope.documentId ||
      (runtime.authority.kind??'household')!=='household') throw Error('INVALID_RECIPE_DOCUMENT');
  const {source,...catalog}=await readRecipeCatalog(runtime,auth,recipeId,maxChildren);
  const parent=await runtime.document();
  if (parent.revision!==(source?.revision??null) || !sameBytes(parent.storedBytes,source?.bytes??null)) throw Error('CONFLICT');
  return {...catalog,parent};
}

/** Legacy recipes keep their original document and history. */
export function projectSelectedRecipes({parent,children}) {
  return [...projectRecipes(parent.doc),...[...children.values()].flatMap(({doc})=>projectRecipes(doc))]
    .sort((left,right)=>left.id<right.id?-1:left.id>right.id?1:0);
}
