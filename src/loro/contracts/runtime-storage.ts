import type { Bytes, Id, Result, StorageError, LocalCommit, SavedOutcome } from './index.ts';
/** Copied durable data, always unauthenticated. These reads do not provide a transactional snapshot across calls. */
export interface RuntimeStorageReader {
  getLocalOperation(scopeId: Id, operationId: Id): Promise<Result<{commit: LocalCommit; outcome: SavedOutcome} | null, StorageError>>;
  getInboxApplication(scopeId: Id, itemId: Id): Promise<Result<{operationId: Id; outcome: SavedOutcome} | null, StorageError>>;
  listDocuments(scopeId: Id): Promise<Result<readonly {documentId: Id; bytes: Bytes; revision: number}[], StorageError>>;
  listOutboundObjects(scopeId: Id): Promise<Result<readonly {objectId: Id; bytes: Bytes; branchHead: Id; epochId: Id}[], StorageError>>;
  listStagedInbox(scopeId: Id): Promise<Result<readonly {itemId: Id; bytes: Bytes}[], StorageError>>;
  listCursors(scopeId: Id): Promise<Result<readonly {source: Id; cursor: string}[], StorageError>>;
  listReceiptStates(scopeId: Id): Promise<Result<readonly {objectId: Id; destination: 'relay' | 'peer'; recipientId: Id; state: 'stored' | 'applied'}[], StorageError>>;
}
