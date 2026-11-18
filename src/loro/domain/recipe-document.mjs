import {domain} from '../authority/validator.mjs';

const recipeKinds = new Set([
  'recipe-create', 'recipe-field', 'recipe-ingredient-add', 'recipe-ingredient-field',
  'recipe-step-add', 'recipe-step-field',
]);

export function commandRecipeId(command) {
  if (!recipeKinds.has(command?.kind)) return null;
  return (command.kind === 'recipe-create' ? command.data?.recipe?.id : command.data?.recipeId) ?? null;
}

export function recipeCatalogBinding(scope, rootPin, sourceDocumentId = scope.documentId) {
  return {
    version: 1, rootPin, scopeId: scope.scopeId, branchHead: scope.branchHead,
    sourceDocumentId, documentGeneration: scope.documentGeneration, epochId: scope.epochId,
  };
}

// The authority still signs the household root document. Derive each subordinate
// document from that verified context and the recipe identity in the command.
export async function recipeDocumentId(scope, rootPin, provider, recipeId) {
  if (typeof recipeId !== 'string' || !recipeId.trim()) throw Error('INVALID_RECIPE_DOCUMENT');
  const digest = await provider.hash(domain('recipe-document-v1', {
    rootPin, scopeId: scope.scopeId, branchHead: scope.branchHead,
    parentDocumentId: scope.documentId, generation: scope.documentGeneration,
    epochId: scope.epochId, recipeId,
  }));
  const documentId = 'recipe-v1-' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (documentId === scope.documentId) throw Error('INVALID_RECIPE_DOCUMENT');
  return documentId;
}
