import type { Bytes, Id, Result, StorageError, UntrustedBytes, Verified } from './index.ts';

/** Candidate structures only. No encoding, algorithm or production trust is selected here. */
export type PairingScope = { kind: 'personal' | 'household'; id: Id };
export type PairingAction = 'pairOwnDevice' | 'inviteAdult' | 'recoverDevice';
export type PairingDevice = { role: 'initiator' | 'responder'; deviceId: Id; signingPublicKey: Bytes; wrappingPublicKey: Bytes; nonce: Bytes };
export type CeremonyTranscript = { version: 1; sessionId: Id; action: PairingAction; scope: PairingScope; purpose: Id; acceptedParent: Id; authorizationSnapshot: Id; initiator: PairingDevice; responder: PairingDevice; signaling: readonly Bytes[] };
/** Independently authenticated random session identity; never derived solely from transcript bytes. */
export type CeremonyGuard = { version: 1; guardId: Id; scope: PairingScope; direction: 'initiator-to-responder' | 'responder-to-initiator'; purpose: Id };
export type PairingProofs = { initiatorConfirmation: UntrustedBytes; responderConfirmation: UntrustedBytes; wrappingPossession: UntrustedBytes; authenticatedGuard: UntrustedBytes };
export interface PairingAuthenticator {
  /** Pins, signatures, possession, authority and guard authentication are verified by the implementation. */
  verify(transcript: CeremonyTranscript, guard: CeremonyGuard, proofs: PairingProofs): Promise<Result<Verified<{ transcript: CeremonyTranscript; guard: CeremonyGuard }>, 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'TOO_LARGE' | 'INVALID_PROOF' | 'UNAUTHORIZED' | 'UNAVAILABLE'>>;
}
/** A projection of accepted authority, maintained by the authority writer in the same database. */
export type PairingAuthorityRecord = { scope: PairingScope; revision: number; acceptedParent: Id; authorizationSnapshot: Id; authorityState: Bytes };
export type PairingAuthorityWrite = { expectedRevision: number | null; record: PairingAuthorityRecord };
/** Packet and outbox bytes are already recipient-encrypted; never include plaintext key material. */
export type PairingRelease = { version: 1; operationId: Id; transcript: CeremonyTranscript; guard: CeremonyGuard; expectedAuthorityRevision: number; packet: { id: Id; bytes: Bytes }; outbox: { destination: Id; objectId: Id }; outcome: { recipientDevice: Id; packetId: Id } };
export type PairingReleaseResult = Result<{ release: PairingRelease; replayed: boolean }, { code: StorageError; recovery: 'reload-durable-state' }>;
export interface PairingAtomicStorage {
  readPairingAuthority(scope: PairingScope): Promise<Result<PairingAuthorityRecord | null, StorageError>>;
  /** CAS against the durable record in the same database transaction as the authority writer's related changes. */
  compareAndSwapPairingAuthority(write: PairingAuthorityWrite): Promise<Result<void, StorageError>>;
  /** Look up before randomized encryption; lookup is not authorization to transmit. */
  findPairingRelease(scope: PairingScope, operationId: Id): Promise<Result<PairingRelease | null, StorageError>>;
  /** Caller authenticates ceremony and revalidates authority; storage performs all comparisons and writes atomically. */
  commitPairingRelease(release: PairingRelease): Promise<PairingReleaseResult>;
}
/** Only an implementation with a transactional wrapped-key record and durable master key can implement this. */
export interface PairingRecipientStorage {
  installAndReceipt(input: { operationId: Id; scope: PairingScope; guard: CeremonyGuard; transcript: CeremonyTranscript; packetId: Id; wrappedLocalKey: Bytes; masterKeyId: Id; acceptanceReceipt: Bytes }): Promise<Result<{ replayed: boolean }, StorageError | 'UNAVAILABLE'>>;
}
export const PAIRING_LIMITS = { idBytes: 256, publicKeyBytes: 4096, signalingItems: 64, itemBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 } as const;
type ValidationError = 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'TOO_LARGE';
const enc = new TextEncoder();
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Uint8Array);
const fields = (x: Record<string, unknown>, ks: string[]) => Object.keys(x).length === ks.length && ks.every(k => Object.hasOwn(x,k));
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && enc.encode(x).length <= PAIRING_LIMITS.idBytes;
export const validPairingScope = (x: unknown): x is PairingScope => obj(x) && fields(x,['kind','id']) && (x.kind === 'personal' || x.kind === 'household') && id(x.id);
const denseBytes = (x: unknown): x is Uint8Array[] => { if (!Array.isArray(x) || !x.length) return false; for (let i=0;i<x.length;i++) if (!Object.hasOwn(x,i) || !(x[i] instanceof Uint8Array) || !x[i].length) return false; return true; };
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v,i) => v === b[i]);
const canonical = (v: unknown): unknown => v instanceof Uint8Array ? Array.from(v) : Array.isArray(v) ? v.map(canonical) : obj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,canonical(v[k])])) : v;
/** Structural comparison only, never a cryptographic serialization or authentication. */
export function pairingReleaseKey(input: unknown): Result<string, ValidationError> {
  if (!obj(input) || !fields(input,['version','operationId','transcript','guard','expectedAuthorityRevision','packet','outbox','outcome'])) return {ok:false,error:'MALFORMED'};
  if (input.version !== 1) return {ok:false,error:'UNSUPPORTED_VERSION'};
  const t = input.transcript, g = input.guard, p = input.packet, o = input.outbox, result = input.outcome;
  if (!id(input.operationId) || !Number.isSafeInteger(input.expectedAuthorityRevision) || (input.expectedAuthorityRevision as number) < 0 || !obj(t) || !fields(t,['version','sessionId','action','scope','purpose','acceptedParent','authorizationSnapshot','initiator','responder','signaling']) || !obj(g) || !fields(g,['version','guardId','scope','direction','purpose'])) return {ok:false,error:'MALFORMED'};
  if (t.version !== 1 || g.version !== 1) return {ok:false,error:'UNSUPPORTED_VERSION'};
  if (!id(t.sessionId) || !['pairOwnDevice','inviteAdult','recoverDevice'].includes(t.action as string) || !validPairingScope(t.scope) || !id(t.purpose) || !id(t.acceptedParent) || !id(t.authorizationSnapshot) || (t.action === 'inviteAdult' && t.scope.kind !== 'household') || !id(g.guardId) || !validPairingScope(g.scope) || g.scope.kind !== t.scope.kind || g.scope.id !== t.scope.id || g.purpose !== t.purpose || !['initiator-to-responder','responder-to-initiator'].includes(g.direction as string)) return {ok:false,error:'MALFORMED'};
  const device = (x: unknown, role: string): x is PairingDevice => obj(x) && fields(x,['role','deviceId','signingPublicKey','wrappingPublicKey','nonce']) && x.role === role && id(x.deviceId) && x.signingPublicKey instanceof Uint8Array && x.signingPublicKey.length > 0 && x.wrappingPublicKey instanceof Uint8Array && x.wrappingPublicKey.length > 0 && x.nonce instanceof Uint8Array && x.nonce.length === 32;
  if (!device(t.initiator,'initiator') || !device(t.responder,'responder') || t.initiator.deviceId === t.responder.deviceId || equalBytes(t.initiator.nonce,t.responder.nonce) || !denseBytes(t.signaling) || !obj(p) || !fields(p,['id','bytes']) || !id(p.id) || !(p.bytes instanceof Uint8Array) || !p.bytes.length || !obj(o) || !fields(o,['destination','objectId']) || !id(o.destination) || o.objectId !== p.id || o.destination !== (g.direction === 'initiator-to-responder' ? t.responder.deviceId : t.initiator.deviceId) || !obj(result) || !fields(result,['recipientDevice','packetId']) || result.packetId !== p.id || result.recipientDevice !== (g.direction === 'initiator-to-responder' ? t.responder.deviceId : t.initiator.deviceId)) return {ok:false,error:'MALFORMED'};
  const items = [t.initiator.signingPublicKey,t.initiator.wrappingPublicKey,t.responder.signingPublicKey,t.responder.wrappingPublicKey,...t.signaling,p.bytes];
  if (t.signaling.length > PAIRING_LIMITS.signalingItems || items.slice(0,4).some(x => x.length > PAIRING_LIMITS.publicKeyBytes) || items.some(x => x.length > PAIRING_LIMITS.itemBytes) || items.reduce((n,x) => n+x.length,64) > PAIRING_LIMITS.totalBytes) return {ok:false,error:'TOO_LARGE'};
  return {ok:true,value:JSON.stringify(canonical(input))};
}
/** Facts must be read from the same transaction; guard and operation identities are separate. */
export function classifyPairingRelease(inputKey: string, completedKey: string | null, guardUsed: boolean, packetUsed: boolean): 'new' | 'replay' | 'conflict' {
  if (completedKey !== null) return completedKey === inputKey ? 'replay' : 'conflict';
  return guardUsed || packetUsed ? 'conflict' : 'new';
}

export function validatePairingAuthority(input: unknown): Result<PairingAuthorityRecord, ValidationError> {
  if (!obj(input) || !fields(input,['scope','revision','acceptedParent','authorizationSnapshot','authorityState']) || !validPairingScope(input.scope) || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || !id(input.acceptedParent) || !id(input.authorizationSnapshot) || !(input.authorityState instanceof Uint8Array) || !input.authorityState.length) return {ok:false,error:'MALFORMED'};
  if (input.authorityState.length > PAIRING_LIMITS.itemBytes) return {ok:false,error:'TOO_LARGE'};
  return {ok:true,value:input as PairingAuthorityRecord};
}
