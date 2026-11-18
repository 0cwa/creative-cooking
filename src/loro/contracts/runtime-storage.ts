import type { Bytes, Id, Result, StorageError, LocalCommit, LocalCommitGroup, AuthorityPrecondition, SavedOutcome } from './index.ts';
import type { LocalKeyRecord, ReadyMasterCatalog } from '../storage/local-keys.ts';

export type RecipeCatalogBinding = {
  version: 1;
  rootPin: Id;
  scopeId: Id;
  branchHead: Id;
  sourceDocumentId: Id;
  documentGeneration: number;
  epochId: Id;
};
export const MAX_SELECTED_CHILDREN = 15;
export const MAX_SELECTED_SOURCE_BYTES = 1024 * 1024;
export const MAX_SELECTED_SET_BYTES = 8 * 1024 * 1024;

export type SelectedSourceDocument = {documentId:Id;revision:number;bytes:Bytes};
export type SelectedRecipeSource = SelectedSourceDocument & {
  recipeId:Id;effectId:Id;sourceRevision:number|null;objectId:Id;envelope:Bytes;
};
export type SelectedHouseholdSources = {
  binding:RecipeCatalogBinding;
  expectedAuthority:AuthorityPrecondition;
  catalogRevision:number;
  root:SelectedSourceDocument|null;
  entries:SelectedRecipeSource[];
  members?: (SelectedSourceDocument & {recipeId:Id})[];
};

export type RecipePublication = {
  binding: RecipeCatalogBinding;
  sourceRevision: number | null;
  recipeId: Id;
  installedKey?: {record: LocalKeyRecord; catalog: ReadyMasterCatalog};
};

/** Authenticated recipe evidence to be checked again inside the consumer write. */
export type ShoppingRecipeSourceReceipt = {
  consumerEffectId: Id;
  binding: RecipeCatalogBinding;
  recipeId: Id;
  documentId: Id;
  revision: number;
  rootRevision: number | null;
  creationObjectId?: Id;
  effects: ({effectId: Id; objectId: Id} | {effectId: Id; seedId: Id})[];
};

/** Copied durable data, always unauthenticated. These reads do not provide a transactional snapshot across calls. */
export interface RuntimeStorageReader {
  reopenBranchDocument(expectedAuthority: AuthorityPrecondition, documentId: Id): Promise<Result<{documentId: Id; bytes: Bytes; revision: number} | null, StorageError>>;
  getLocalGroup(groupId: Id): Promise<Result<{group: LocalCommitGroup; outcomes: readonly SavedOutcome[]} | null, StorageError>>;
  getLocalOperation(scopeId: Id, operationId: Id): Promise<Result<{commit: LocalCommit; outcome: SavedOutcome} | null, StorageError>>;
  getInboxApplication(scopeId: Id, itemId: Id): Promise<Result<{operationId: Id; outcome: SavedOutcome} | null, StorageError>>;
  listDocuments(scopeId: Id): Promise<Result<readonly {documentId: Id; bytes: Bytes; revision: number}[], StorageError>>;
  listOutboundObjects(scopeId: Id): Promise<Result<readonly {objectId: Id; bytes: Bytes; branchHead: Id; epochId: Id}[], StorageError>>;
  listStagedInbox(scopeId: Id): Promise<Result<readonly {itemId: Id; bytes: Bytes}[], StorageError>>;
  listCursors(scopeId: Id): Promise<Result<readonly {source: Id; cursor: string}[], StorageError>>;
  listReceiptStates(scopeId: Id): Promise<Result<readonly {objectId: Id; destination: 'relay' | 'peer'; recipientId: Id; state: 'stored' | 'applied'}[], StorageError>>;
}
