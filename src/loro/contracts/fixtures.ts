import type { ExchangeFrame, ImmutableObject, SemanticCommand } from './index.ts';
/** Deterministic opaque bytes for interface tests only. They are not encrypted or signed. */
export const fixtureObject: ImmutableObject = { id: 'fixture-object', bytes: new Uint8Array([0, 1, 2, 255]) };
export const fixtureFrame: ExchangeFrame = { version: 1, sessionId: 'session', streamId: 'stream', kind: 'objectChunk', transferId: 'transfer', chunkIndex: 0, chunkCount: 1, payloadHash: 'unverified-hash', bytes: fixtureObject.bytes };
export const fixtureCommand: SemanticCommand = { version: 1, commandId: 'command', effectId: 'effect', documentId: 'document', kind: 'purchase', payload: new Uint8Array([7]), dependencyEffectIds: [] };

import type { PairingRelease } from './pairing.ts';
/** Opaque example bytes; no encryption, authentication or freshness is asserted. */
export const fixturePairingRelease: PairingRelease = {
  version: 1, operationId: 'release', expectedAuthorityRevision: 3,
  transcript: { version: 1, sessionId: 'session', action: 'pairOwnDevice', scope: {kind:'personal',id:'personal'}, purpose:'data', acceptedParent:'head', authorizationSnapshot:'snapshot',
    initiator: {role:'initiator',deviceId:'old',signingPublicKey:new Uint8Array([1]),wrappingPublicKey:new Uint8Array([2]),nonce:new Uint8Array(32).fill(1)},
    responder: {role:'responder',deviceId:'new',signingPublicKey:new Uint8Array([3]),wrappingPublicKey:new Uint8Array([4]),nonce:new Uint8Array(32).fill(2)}, signaling:[new Uint8Array([5]),new Uint8Array([6])] },
  guard: {version:1,guardId:'independent-guard',scope:{kind:'personal',id:'personal'},direction:'initiator-to-responder',purpose:'data'},
  packet:{id:'packet',bytes:new Uint8Array([7])},outbox:{destination:'new',objectId:'packet'},outcome:{recipientDevice:'new',packetId:'packet'}
};
