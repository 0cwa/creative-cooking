import {isRecipeDocumentId} from '../domain/recipe-document.mjs';

type CatalogReader = {keys():Promise<string[]>;get(key:string):Promise<unknown>};

/** Legacy transitions cannot carry child documents. Check both catalog and
 * ownership so a missing catalog row cannot reopen a single-document route. */
export async function hasSelectedRecipeChildren(tx:CatalogReader,scope:string,heads:readonly string[]) {
  const catalogPrefixes = heads.map(head=>JSON.stringify(['recipe-catalog',scope,head]).slice(0,-1)+',');
  const ownerPrefix = JSON.stringify(['document-owner',scope]).slice(0,-1)+',';
  for (const slot of await tx.keys()) {
    if (catalogPrefixes.some(prefix=>slot.startsWith(prefix))) return true;
    if (!slot.startsWith(ownerPrefix)) continue;
    const documentId = JSON.parse(slot)[2];
    if (!isRecipeDocumentId(documentId)) continue;
    const owner = await tx.get(slot);
    if (typeof owner === 'string' && heads.includes(owner)) return true;
  }
  return false;
}
