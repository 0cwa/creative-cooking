/** C0 interfaces are local contracts, not a wire encoding or cryptographic suite. */
export const CONTRACT_VERSION = 'C0' as const;
export const POLICY_SCHEMA_VERSION = 2 as const;
export const INITIAL_FRAME_BYTES = 16 * 1024;
export const REVIEW_LIMITS = { objects: 256, aggregateBytes: 8 * 1024 * 1024, objectBytes: 1024 * 1024, dependencies: 64 } as const;
export type Id = string;
export type Bytes = Uint8Array;
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export type BoundaryError = 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_SUITE' | 'TOO_LARGE' | 'DUPLICATE' | 'INVALID_PROOF' | 'MISSING_DEPENDENCY';
/** Input has not been authenticated, regardless of fields it claims. */
export type UntrustedBytes = { bytes: Bytes };
declare const verified: unique symbol;
/** Only a real verifier may produce this type; fixture data must not be cast to it. */
export type Verified<T> = { readonly value: T; readonly [verified]: true };
export type ImmutableObject = { id: Id; bytes: Bytes };
export type DocumentOutput = { documentId: Id; bytes: Bytes };
export type SemanticCommand = { version: 1; commandId: Id; effectId: Id; documentId: Id; kind: string; payload: Bytes; dependencyEffectIds: readonly Id[] };
export type OutboxEntry = { object: ImmutableObject; branchHead: Id; epochId: Id };
export type LocalCommit = { document: DocumentOutput; commands: readonly SemanticCommand[]; outbound: readonly OutboxEntry[] };
export type StorageError = 'CAPACITY' | 'CONFLICT' | 'IO' | 'CORRUPT' | 'UNSUPPORTED_VERSION';
export type CommitResult = Result<{ state: 'saved' }, { code: StorageError; recovery: 'reload-durable-state' }>;
export type InboxItem = { object: ImmutableObject; source: Id; cursor: string };
export interface AtomicStorage {
  /** All document, effect and outbox writes succeed together. On failure discard mutated working state and reload. */
  commitLocal(commit: LocalCommit): Promise<CommitResult>;
  reopenDocument(documentId: Id): Promise<Result<DocumentOutput | null, StorageError>>;
  stageInbox(item: InboxItem): Promise<Result<void, StorageError>>;
  commitImport(itemId: Id, document: DocumentOutput, effectIds: readonly Id[]): Promise<CommitResult>;
}
export type ContentHeader = { version: 1; suiteId: string; scopeId: Id; documentId: Id; documentGeneration: number; branchHead: Id; policyHashes: readonly Id[]; epochId: Id; authorDevice: Id; deviceSequence: number; predecessorRefs: readonly Id[]; semanticEffectIds: readonly Id[]; payloadKind: string };
export type KeyHeader = { version: 1; suiteId: string; scopeId: Id; branchHead: Id; policyHashes: readonly Id[]; epochId: Id; recipientDevice: Id; keyPurpose: string; senderDevice: Id };
export interface ObjectCodec {
  sealContent(header: ContentHeader, plaintext: Bytes, keyRef: Id): Promise<Result<ImmutableObject, BoundaryError>>;
  openContent(input: UntrustedBytes): Promise<Result<Verified<{ header: ContentHeader; plaintext: Bytes; object: ImmutableObject }>, BoundaryError>>;
  wrapKey(header: KeyHeader, keyRef: Id): Promise<Result<ImmutableObject, BoundaryError>>;
  openKey(input: UntrustedBytes): Promise<Result<Verified<{ header: KeyHeader; keyRef: Id }>, BoundaryError>>;
}
export interface KeyStore {
  generate(purpose: 'device-signing' | 'device-wrapping' | 'data' | 'recovery'): Promise<Result<Id, 'UNAVAILABLE' | 'IO'>>;
  publicKey(keyRef: Id): Promise<Result<Bytes, 'NOT_FOUND' | 'UNAVAILABLE'>>;
  remove(keyRef: Id): Promise<Result<void, 'NOT_FOUND' | 'IO'>>;
}
export type PairingTranscript = { version: 1; sessionId: Id; action: 'pairOwnDevice' | 'inviteAdult' | 'recoverDevice'; householdId: Id; parentHead: Id; initiatorDevice: Id; responderDevice: Id; offerHash: Id; answerHash: Id; proofRefs: readonly Id[] };
export interface Pairing {
  verify(transcript: PairingTranscript, evidence: readonly UntrustedBytes[]): Promise<Result<Verified<PairingTranscript>, BoundaryError>>;
  releaseKeys(transcript: Verified<PairingTranscript>): Promise<Result<readonly ImmutableObject[], BoundaryError>>;
}
export type FrameKind = 'hello' | 'inventory' | 'request' | 'objectChunk' | 'receipt' | 'close';
export type ExchangeFrame = { version: 1; sessionId: Id; streamId: Id; kind: FrameKind; transferId: Id; chunkIndex: number; chunkCount: number; payloadHash: Id; bytes: Bytes };
export type SendResult = Result<void, 'BACKPRESSURE' | 'CLOSED' | 'TOO_LARGE' | 'IO'>;
export interface Transport {
  readonly maxFrameBytes: number;
  send(frame: Bytes): Promise<SendResult>;
  receive(): Promise<Result<Bytes | null, 'CLOSED' | 'IO'>>;
  waitWritable(): Promise<Result<void, 'CLOSED' | 'IO'>>;
  close(): Promise<void>;
}
export type Receipt = { kind: 'local'; objectId: Id } | { kind: 'relay'; objectId: Id; receipt: Bytes } | { kind: 'peer'; recipientDevice: Id; transferId: Id; objectIds: readonly Id[]; trustHead: Id; state: 'stored' | 'applied'; signature: Bytes };
export type AuthorityDecision = { kind: 'allow' } | { kind: 'allowWithOverride'; disagreementRefs: readonly Id[] } | { kind: 'pending'; reason: 'POLICY_UNRESOLVED' | 'ADMISSION_REQUIRED' | 'QUORUM_REQUIRED' } | { kind: 'requireConsent' | 'requireReview' } | { kind: 'deny'; reason: 'PROHIBITED' | 'INCOMPATIBLE' | 'INVALID_PROOF' } | { kind: 'localOnly' };
export interface Authority { evaluate(request: Verified<AuthorityRequest>): Promise<AuthorityDecision> }
export type AuthorityRequest = { version: 2; action: string; scope: Id; parentHead: Id; policyHashes: readonly Id[]; evidenceRefs: readonly Id[] };
export type ProjectionEntry = { sourceDocument: Id; sourceCheckpointHash: Id; projectedStateHash: Id; newDocumentId: Id; newGeneration: number; schemaVersion: number };
export type CurrentStateGrant = { version: 1; householdId: Id; parentHead: Id; admissionEventHash: Id; sourcePolicyHashes: readonly Id[]; delegationHash: Id; recipientAdult: Id; recipientDevices: readonly Id[]; contentClasses: readonly ('recipe' | 'pantry' | 'shopping')[]; projectionManifestHash: Id; newDocumentGeneration: number; newEpochId: Id; keyEnvelopeRefs: readonly Id[]; signatures: readonly Bytes[] };
export interface Projection { create(grant: Verified<CurrentStateGrant>): Promise<Result<{ entries: readonly ProjectionEntry[]; documents: readonly DocumentOutput[] }, BoundaryError>> }
export type RecoveryCatalog = { version: 1; owner: Id; generation: number; previousCatalogHash: Id | null; keyRefs: readonly Id[]; encryptedObjectRefs: readonly Id[]; trustedCheckpoints: readonly Id[]; custodyLocations: readonly Id[] };
export type GuardianPackage = { version: 1; owner: Id; scope: 'personal' | 'shared'; packageGeneration: number; guardianRoster: readonly Id[]; threshold: number; encryptedCatalogRef: Id; sharedGrantRef: Id | null; approvalRefs: readonly Id[] };
export type CompromiseReport = { version: 1; reportId: Id; reporterDevice: Id; householdId: Id; selectedHead: Id; suspectDeviceIds: readonly Id[]; boundaryCheckpoint: Id; boundaryDeviceSequences: Readonly<Record<Id, number>>; reasonText: string; evidenceRefs: readonly Id[]; signature: Bytes };
export type ReviewManifest = { version: 1; reviewId: Id; reportHash: Id; acceptedCheckpointHash: Id; evidenceObjectIds: readonly Id[]; evidenceBytes: number; omittedSummary: string; signature: Bytes };
export type Reconstruction = { version: 1; reviewId: Id; checkpointHash: Id; selectedSemanticEffectIds: readonly Id[]; rejectedEffectRefs: readonly Id[]; unresolvedDependencyRefs: readonly Id[]; newGeneration: number; newBranchHead: Id; projectionManifestHash: Id; authorizations: readonly Bytes[] };

/** Structural validation only: the result remains unauthenticated. encodedSize is measured by the caller. */
export function validateFrame(input: unknown, encodedSize: number, negotiatedMaximum: number): Result<ExchangeFrame, BoundaryError> {
  if (!Number.isSafeInteger(encodedSize) || encodedSize < 0 || !Number.isSafeInteger(negotiatedMaximum) || negotiatedMaximum < 1) return { ok: false, error: 'MALFORMED' };
  if (encodedSize > Math.min(INITIAL_FRAME_BYTES, negotiatedMaximum)) return { ok: false, error: 'TOO_LARGE' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'MALFORMED' };
  const r = input as Record<string, unknown>;
  const keys = ['version', 'sessionId', 'streamId', 'kind', 'transferId', 'chunkIndex', 'chunkCount', 'payloadHash', 'bytes'];
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) return { ok: false, error: 'MALFORMED' };
  if (r.version !== 1) return { ok: false, error: 'UNSUPPORTED_VERSION' };
  if (!['hello', 'inventory', 'request', 'objectChunk', 'receipt', 'close'].includes(r.kind as string) || !['sessionId', 'streamId', 'transferId', 'payloadHash'].every(k => typeof r[k] === 'string' && (r[k] as string).length > 0) || !(r.bytes instanceof Uint8Array) || r.bytes.byteLength > encodedSize || !Number.isSafeInteger(r.chunkIndex) || !Number.isSafeInteger(r.chunkCount) || (r.chunkCount as number) < 1 || (r.chunkIndex as number) < 0 || (r.chunkIndex as number) >= (r.chunkCount as number)) return { ok: false, error: 'MALFORMED' };
  return { ok: true, value: r as ExchangeFrame };
}
/** Checks measured bytes and distinct object IDs, not signatures or completeness. */
export function validateReviewBatch(objects: readonly ImmutableObject[], dependencyCounts: readonly number[]): Result<void, BoundaryError> {
  if (objects.length > REVIEW_LIMITS.objects || dependencyCounts.some(n => !Number.isSafeInteger(n) || n < 0 || n > REVIEW_LIMITS.dependencies)) return { ok: false, error: 'TOO_LARGE' };
  const ids = new Set<string>(); let total = 0;
  for (const object of objects) {
    if (!object.id || !(object.bytes instanceof Uint8Array)) return { ok: false, error: 'MALFORMED' };
    if (ids.has(object.id)) return { ok: false, error: 'DUPLICATE' };
    ids.add(object.id); total += object.bytes.byteLength;
    if (object.bytes.byteLength > REVIEW_LIMITS.objectBytes || total > REVIEW_LIMITS.aggregateBytes) return { ok: false, error: 'TOO_LARGE' };
  }
  return { ok: true, value: undefined };
}
export function validateGuardianPackage(input: unknown): Result<GuardianPackage, BoundaryError> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'MALFORMED' };
  const p = input as Record<string, unknown>;
  const keys = ['version', 'owner', 'scope', 'packageGeneration', 'guardianRoster', 'threshold', 'encryptedCatalogRef', 'sharedGrantRef', 'approvalRefs'];
  if (Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k))) return { ok: false, error: 'MALFORMED' };
  if (p.version !== 1) return { ok: false, error: 'UNSUPPORTED_VERSION' };
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(id => typeof id === 'string' && id.length > 0) && new Set(v).size === v.length;
  if (typeof p.owner !== 'string' || !p.owner || typeof p.encryptedCatalogRef !== 'string' || !p.encryptedCatalogRef || !Number.isSafeInteger(p.packageGeneration) || (p.packageGeneration as number) < 0 || (p.scope !== 'personal' && p.scope !== 'shared') || !ids(p.guardianRoster) || !p.guardianRoster.length || !ids(p.approvalRefs) || !Number.isSafeInteger(p.threshold) || (p.threshold as number) < 1 || (p.threshold as number) > p.guardianRoster.length || (p.scope === 'personal' && p.sharedGrantRef !== null) || (p.scope === 'shared' && (typeof p.sharedGrantRef !== 'string' || !p.sharedGrantRef))) return { ok: false, error: 'MALFORMED' };
  return { ok: true, value: p as GuardianPackage };
}
