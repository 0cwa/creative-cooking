import type { ExchangeFrame, ImmutableObject, SemanticCommand } from './index.ts';
/** Deterministic opaque bytes for interface tests only. They are not encrypted or signed. */
export const fixtureObject: ImmutableObject = { id: 'fixture-object', bytes: new Uint8Array([0, 1, 2, 255]) };
export const fixtureFrame: ExchangeFrame = { version: 1, sessionId: 'session', streamId: 'stream', kind: 'objectChunk', transferId: 'transfer', chunkIndex: 0, chunkCount: 1, payloadHash: 'unverified-hash', bytes: fixtureObject.bytes };
export const fixtureCommand: SemanticCommand = { version: 1, commandId: 'command', effectId: 'effect', documentId: 'document', kind: 'purchase', payload: new Uint8Array([7]), dependencyEffectIds: [] };
