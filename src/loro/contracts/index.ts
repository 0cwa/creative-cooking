import { validPairingScope } from './pairing.ts';
import type { PairingScope } from './pairing.ts';
/** C0 interfaces are local contracts, not a wire encoding or cryptographic suite. */
export const CONTRACT_VERSION = 'C0.1' as const;
export const POLICY_SCHEMA_VERSION = 2 as const;
export const INITIAL_FRAME_BYTES = 16 * 1024;
export const REVIEW_LIMITS = { objects: 256, aggregateBytes: 8 * (2 * (1024 * 1024 + 256) + 320 * 1024), objectBytes: 2 * (1024 * 1024 + 256) + 320 * 1024, dependencies: 64 } as const;
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
/** Revisions are safe nonnegative integers; null means the document must not exist. */
export type DocumentWrite = DocumentOutput & { expectedRevision: number | null };
export type AuthorityPrecondition = { version: 2; scope: PairingScope; record: {revision: number; acceptedParent: Id; authorizationSnapshot: Id} | null };
export type LocalCommit = { expectedAuthority: AuthorityPrecondition; scopeId: Id; operationId: Id; documents: readonly DocumentWrite[]; commands: readonly SemanticCommand[]; outbound: readonly OutboxEntry[] };
export type LocalCommitGroup = { groupId: Id; children: readonly LocalCommit[] };
export type GroupCommitResult = Result<{ outcomes: readonly SavedOutcome[]; replayed: boolean }, { code: StorageError; recovery: 'reload-durable-state' }>;
export type ImportCommit = { version: 2; commands: readonly SemanticCommand[]; expectedAuthority: AuthorityPrecondition; scopeId: Id; operationId: Id; itemId: Id; documents: readonly DocumentWrite[]; effectIds: readonly Id[] };
export type StorageError = 'QUARANTINED' | 'CHECKOUT_REQUIRED' | 'LOCKED' | 'CAPACITY' | 'CONFLICT' | 'IO' | 'CORRUPT' | 'UNSUPPORTED_VERSION' | 'MALFORMED' | 'TOO_LARGE';
export type SavedOutcome = { state: 'saved'; revisions: readonly { documentId: Id; revision: number }[] };
export type CommitResult = Result<{ outcome: SavedOutcome; replayed: boolean }, { code: StorageError; recovery: 'reload-durable-state' }>;
export type InboxItem = { scopeId: Id; object: ImmutableObject; source: Id; expectedCursor: string | null; cursor: string };
/** A receipt is persisted as untrusted bytes; storage does not authenticate its claims. */
export type OutboxReceipt = { scopeId: Id; objectId: Id; receiptId: Id; destination: 'relay' | 'peer'; recipientId: Id; state: 'stored' | 'applied'; bytes: Bytes };
export interface AtomicStorage {
  /** Authority must be revalidated by the caller, including on retries. Compare complete operation before revision checks.
   * Identical replay returns its original outcome; conflicting reuse or partial pre-existing identity sets write nothing.
   * All writes and revision comparisons occur in one database transaction, including across processes/tabs. */
  commitLocal(commit: LocalCommit): Promise<CommitResult>;
  /** One local DB transaction for all scopes; caller authorizes each scope before every invocation. */
  commitLocalGroup(group: LocalCommitGroup): Promise<GroupCommitResult>;
  reopenDocument(scopeId: Id, documentId: Id): Promise<Result<(DocumentOutput & { revision: number }) | null, StorageError>>;
  /** Atomically stage immutable bytes and compare-and-swap the opaque per-scope/source cursor. */
  stageInbox(item: InboxItem, expectedAuthority?: LocalCommit['expectedAuthority']): Promise<Result<void, StorageError>>;
  /** Atomically commit all outputs, effects and applied outcome; failure retains staged bytes. */
  commitImport(commit: ImportCommit): Promise<CommitResult>;
  /** Persist a receipt idempotently; conflicting reuse fails. Never erase objects, effects or retry history.
   * Relay supports stored only; peer supports stored then applied per recipient. Applied does not imply another recipient's state. */
  recordReceipt(receipt: OutboxReceipt): Promise<Result<{ replayed: boolean }, StorageError>>;
}

/** Provisional per-operation limits, measured in actual bytes; adapters must reject before any write. */
export const STORAGE_LIMITS = { groups: 16, documents: 64, commands: 256, outbound: 256, effects: 256, itemBytes: 1024 * 1024, objectBytes: 2 * (1024 * 1024 + 256) + 320 * 1024, totalBytes: 8 * (2 * (1024 * 1024 + 256) + 320 * 1024), idBytes: 256 } as const;
const storageEncoder = new TextEncoder();
const storageId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && storageEncoder.encode(x).length <= STORAGE_LIMITS.idBytes;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
/** Pure validation and deterministic comparison representation, not a wire or cryptographic encoding.
 * Arrays retain order; byte arrays compare byte-for-byte; all IDs and associations participate.
 * Document IDs must be strictly increasing by JS UTF-16 code unit order; other identity arrays are unique.
 * No Unicode normalization is performed. A namespace is always paired with scopeId. */
export function storageOperationKey(input: unknown, kind: 'local' | 'import'): Result<string, 'MALFORMED' | 'TOO_LARGE'> {
  if (!record(input) || !exact(input, kind === 'local' ? ['expectedAuthority','scopeId','operationId','documents','commands','outbound'] : ['version','commands','expectedAuthority','scopeId','operationId','itemId','documents','effectIds']) || !storageId(input.scopeId) || !storageId(input.operationId) || (kind === 'import' && (!storageId(input.itemId) || input.version !== 2))) return {ok:false,error:'MALFORMED'};
  {
    const a = input.expectedAuthority;
    if (!record(a) || !exact(a,['version','scope','record']) || a.version !== 2 || !validPairingScope(a.scope) || a.scope.id !== input.scopeId || !(a.record === null || (record(a.record) && exact(a.record,['revision','acceptedParent','authorizationSnapshot']) && Number.isSafeInteger(a.record.revision) && (a.record.revision as number) >= 0 && storageId(a.record.acceptedParent) && storageId(a.record.authorizationSnapshot)))) return {ok:false,error:'MALFORMED'};
  }
  let total = 0, tooLarge = false;
  const bytes = (v: unknown, limit: number = STORAGE_LIMITS.itemBytes): v is Uint8Array => { if (!(v instanceof Uint8Array)) return false; total += v.byteLength; if (v.byteLength > limit || total > STORAGE_LIMITS.totalBytes) tooLarge = true; return true; };
  const docs = input.documents;
  if (!Array.isArray(docs) || !docs.length) return {ok:false,error:'MALFORMED'};
  if (docs.length > STORAGE_LIMITS.documents) return {ok:false,error:'TOO_LARGE'};
  let previous = '';
  for (const d of docs) {
    if (!record(d) || !exact(d,['documentId','bytes','expectedRevision']) || !storageId(d.documentId) || (previous !== '' && previous >= d.documentId) || !bytes(d.bytes) || !(d.expectedRevision === null || (Number.isSafeInteger(d.expectedRevision) && (d.expectedRevision as number) >= 0 && (d.expectedRevision as number) < Number.MAX_SAFE_INTEGER))) return {ok:false,error:'MALFORMED'};
    previous = d.documentId;
  }
  const unique = (xs: unknown[]): boolean => xs.every(storageId) && new Set(xs).size === xs.length;
  if (!Array.isArray(input.commands) || (kind === 'local' && !input.commands.length)) return {ok:false,error:'MALFORMED'};
  if (input.commands.length > STORAGE_LIMITS.commands) return {ok:false,error:'TOO_LARGE'};
  const commandIds: unknown[] = [], effectIds: unknown[] = [];
  for (const c of input.commands) {
    if (!record(c) || !exact(c,['version','commandId','effectId','documentId','kind','payload','dependencyEffectIds']) || c.version !== 1 || !storageId(c.commandId) || !storageId(c.effectId) || !storageId(c.documentId) || !docs.some(d => d.documentId === c.documentId) || !storageId(c.kind) || !bytes(c.payload) || !Array.isArray(c.dependencyEffectIds) || !unique(c.dependencyEffectIds)) return {ok:false,error:'MALFORMED'};
    if (c.dependencyEffectIds.length > STORAGE_LIMITS.effects) return {ok:false,error:'TOO_LARGE'};
    commandIds.push(c.commandId); effectIds.push(c.effectId);
  }
  if (!unique(commandIds) || !unique(effectIds)) return {ok:false,error:'MALFORMED'};
  if (kind === 'local') {
    if (!Array.isArray(input.outbound)) return {ok:false,error:'MALFORMED'};
    if (input.outbound.length > STORAGE_LIMITS.outbound) return {ok:false,error:'TOO_LARGE'};
    const objectIds: unknown[] = [];
    for (const o of input.outbound) {
      if (!record(o) || !exact(o,['object','branchHead','epochId']) || !storageId(o.branchHead) || !storageId(o.epochId) || !record(o.object) || !exact(o.object,['id','bytes']) || !storageId(o.object.id) || !bytes(o.object.bytes, STORAGE_LIMITS.objectBytes)) return {ok:false,error:'MALFORMED'};
      objectIds.push(o.object.id);
    }
    if (!unique(objectIds)) return {ok:false,error:'MALFORMED'};
  } else {
    if (!Array.isArray(input.effectIds) || !unique(input.effectIds) || input.effectIds.length !== effectIds.length || !input.effectIds.every((id,i)=>id === effectIds[i])) return {ok:false,error:'MALFORMED'};
    if (input.effectIds.length > STORAGE_LIMITS.effects) return {ok:false,error:'TOO_LARGE'};
  }
  if (tooLarge) return {ok:false,error:'TOO_LARGE'};
  // Fixed object-key order is supplied explicitly by recursively sorting keys, never by caller insertion order.
  const canonical = (v: unknown): unknown => v instanceof Uint8Array ? Array.from(v) : Array.isArray(v) ? v.map(canonical) : record(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return {ok:true,value:JSON.stringify([kind, canonical(input)])};
}
/** Validate and compare the ordered complete local group; not a wire encoding. */
export function storageGroupKey(input: unknown): Result<string, 'MALFORMED' | 'TOO_LARGE'> {
  if (!record(input) || !exact(input, ['groupId','children']) || !storageId(input.groupId) || !Array.isArray(input.children) || !input.children.length) return {ok:false,error:'MALFORMED'};
  if (input.children.length > STORAGE_LIMITS.groups) return {ok:false,error:'TOO_LARGE'};
  const keys: string[] = [], identities = new Set<string>();
  let documents = 0, commands = 0, outbound = 0, dependencies = 0, total = 0;
  for (const child of input.children) {
    const result = storageOperationKey(child, 'local');
    if (!result.ok) return result;
    const c = child as LocalCommit;
    const add = (namespace: string, id: string) => { const key = JSON.stringify([c.scopeId, namespace, id]); if (identities.has(key)) return false; identities.add(key); return true; };
    if (!add('operation', c.operationId)) return {ok:false,error:'MALFORMED'};
    for (const d of c.documents) { if (!add('document',d.documentId)) return {ok:false,error:'MALFORMED'}; total += d.bytes.byteLength; }
    for (const command of c.commands) { if (!add('command',command.commandId) || !add('effect',command.effectId)) return {ok:false,error:'MALFORMED'}; total += command.payload.byteLength; dependencies += command.dependencyEffectIds.length; }
    for (const entry of c.outbound) { if (!add('object',entry.object.id)) return {ok:false,error:'MALFORMED'}; total += entry.object.bytes.byteLength; }
    documents += c.documents.length; commands += c.commands.length; outbound += c.outbound.length;
    keys.push(result.value);
  }
  if (documents > STORAGE_LIMITS.documents || commands > STORAGE_LIMITS.commands || outbound > STORAGE_LIMITS.outbound || dependencies > STORAGE_LIMITS.effects || total > STORAGE_LIMITS.totalBytes) return {ok:false,error:'TOO_LARGE'};
  return {ok:true,value:JSON.stringify([input.groupId, keys])};
}
/** Classify persisted identity facts read inside the same transaction; never infer completion from child records. */
export function classifyStorageGroup(inputKey: string, completedGroupKey: string | null, anyChildIdentityExists: boolean): 'new' | 'replay' | 'conflict' {
  if (completedGroupKey !== null) return completedGroupKey === inputKey ? 'replay' : 'conflict';
  return anyChildIdentityExists ? 'conflict' : 'new';
}
export function validateStorageReceipt(input: unknown): Result<OutboxReceipt, 'MALFORMED' | 'TOO_LARGE'> {
  if (!record(input) || !exact(input,['scopeId','objectId','receiptId','destination','recipientId','state','bytes']) || !storageId(input.scopeId) || !storageId(input.objectId) || !storageId(input.receiptId) || !storageId(input.recipientId) || !(input.bytes instanceof Uint8Array) || !((input.destination === 'relay' && input.state === 'stored') || (input.destination === 'peer' && (input.state === 'stored' || input.state === 'applied')))) return {ok:false,error:'MALFORMED'};
  if (input.bytes.byteLength > STORAGE_LIMITS.itemBytes) return {ok:false,error:'TOO_LARGE'};
  return {ok:true,value:input as OutboxReceipt};
}
/** Cursor values are opaque strings, including empty strings; null means no prior cursor. */
export function validateInboxItem(input: unknown): Result<InboxItem, 'MALFORMED' | 'TOO_LARGE'> {
  if (!record(input) || !exact(input,['scopeId','object','source','expectedCursor','cursor']) || !storageId(input.scopeId) || !storageId(input.source) || !record(input.object) || !exact(input.object,['id','bytes']) || !storageId(input.object.id) || !(input.object.bytes instanceof Uint8Array) || !(input.expectedCursor === null || typeof input.expectedCursor === 'string') || typeof input.cursor !== 'string') return {ok:false,error:'MALFORMED'};
  if (input.object.bytes.byteLength > STORAGE_LIMITS.objectBytes || storageEncoder.encode(input.cursor).length > STORAGE_LIMITS.itemBytes || (typeof input.expectedCursor === 'string' && storageEncoder.encode(input.expectedCursor).length > STORAGE_LIMITS.itemBytes)) return {ok:false,error:'TOO_LARGE'};
  return {ok:true,value:input as InboxItem};
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

export * from "./pairing.ts";
export * from './runtime-storage.ts';
