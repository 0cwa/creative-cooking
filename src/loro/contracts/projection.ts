import type { AuthorityPrecondition, Bytes, Id, Result, StorageError } from './index.ts';
import type { LocalKeyRecord, ReadyMasterCatalog } from '../storage/local-keys.ts';
import type { PairingAuthorityRecord } from './pairing.ts';
/** Structural transaction only. Callers must verify admission, source delegation,
 * projection bytes, packages, ceremony, possession, and authority before invoking. */
export type ProjectionPublication = {
 version:1; seed?:{seedId:Id;identities:readonly {commandId:Id;effectId:Id}[]}; singleRecipient?:true; recovery?:{owner:Id;generation:number;bindingHash:Id;claimHash:Id;tokenCommitment:Id;sealed:string}; operationId:Id; guardId?:Id; guardIds?:readonly Id[]; sourceDocument?:{documentId:Id;revision:number}; expectedAuthority:AuthorityPrecondition; nextAuthority:PairingAuthorityRecord;
 admissionEventHash:Id; grantHash:Id; manifest:{id:Id;bytes:Bytes}; epochId:Id;
 documents:readonly {documentId:Id;generation:number;bytes:Bytes}[];
 packages:readonly {id:Id;recipientDevice:Id;bytes:Bytes}[];
 localKey:{record:LocalKeyRecord;catalog:ReadyMasterCatalog};
 pendingEdits:readonly {scopeId:Id;operationId:Id}[];
};
export interface ProjectionAtomicStorage {
 publishProjection(input:ProjectionPublication):Promise<Result<{replayed:boolean},StorageError>>;
 getProjectionPublication(scopeId:Id,operationId:Id):Promise<Result<ProjectionPublication|null,StorageError>>;
}
