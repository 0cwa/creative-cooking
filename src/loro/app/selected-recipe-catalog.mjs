import {decodeCookingPayload,validateCookingHeader} from '../disclosure/cooking.mjs';
import {projectRecipes} from '../domain/app-projection.mjs';
import {commandRecipeId,recipeCatalogBinding,recipeDocumentId} from '../domain/recipe-document.mjs';
import {bytes} from '../domain/registry.mjs';

const sameBytes=(a,b)=>a?.length===b?.length && (a==null || a.every((value,index)=>value===b[index]));

/** Candidate catalog reader. Opening it does not grant permission to change formats. */
export async function openSelectedRecipeCatalog(runtime, recipeId) {
  const auth=await runtime.authorization();
  if (!auth.sourceDocumentId || runtime.recipeId!==null || auth.sourceDocumentId!==runtime.scope.documentId ||
      (runtime.authority.kind??'household')!=='household') throw Error('INVALID_RECIPE_DOCUMENT');
  const binding=recipeCatalogBinding(runtime.scope,runtime.authority.rootPin);
  const result=await runtime.storage.readSelectedRecipeCatalog(auth.expectedAuthority,binding,recipeId);
  if (!result.ok) throw Error(result.error.code);
  const {source,entries}=result.value;
  const parent=await runtime.document();
  if (parent.revision!==(source?.revision??null) || !sameBytes(parent.storedBytes,source?.bytes??null)) throw Error('CONFLICT');
  const index=parent.doc.getMap('recipe-index');
  const children=new Map();
  for (const entry of entries) {
    if (index.get(entry.recipeId)) throw Error('CONFLICT');
    const documentId=await recipeDocumentId(runtime.scope,binding.rootPin,runtime.authority.provider,entry.recipeId);
    if (documentId!==entry.documentId) throw Error('INVALID_RECIPE_DOCUMENT');
    const opened=await runtime.codec.openContent(entry.envelope,auth.signingKeyRefs);
    validateCookingHeader(opened,entry.objectId,{...runtime.scope,documentId});
    const {command}=decodeCookingPayload(opened);
    if (command.kind!=='recipe-create' || commandRecipeId(command)!==entry.recipeId ||
        command.effectId!==entry.effectId) throw Error('INVALID_RECIPE_DOCUMENT');
    const doc=new runtime.LoroDoc();
    doc.import(entry.bytes);
    const recipeIndex=doc.getMap('recipe-index').toJSON();
    const marker=doc.getMap('domain-effects').get(entry.effectId);
    if (Object.keys(recipeIndex).length!==1 || recipeIndex[entry.recipeId]!==entry.effectId ||
        marker?.version!==2 || !sameBytes(bytes(marker.command),bytes(command))) throw Error('INVALID_RECIPE_DOCUMENT');
    children.set(entry.recipeId,{documentId,doc,revision:entry.revision});
  }
  return {binding,parent,children};
}

/** Legacy recipes keep their original document and history. */
export function projectSelectedRecipes({parent,children}) {
  return [...projectRecipes(parent.doc),...[...children.values()].flatMap(({doc})=>projectRecipes(doc))]
    .sort((left,right)=>left.id<right.id?-1:left.id>right.id?1:0);
}
