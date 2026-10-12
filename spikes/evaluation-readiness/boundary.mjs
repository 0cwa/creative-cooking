// Research-only transport contract; NOT a production authorization or encryption boundary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const ENGINES = Object.freeze(['automerge', 'loro']);
export const MAX_UPDATE_BYTES = 4 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stable = (x) => JSON.stringify(x);
function nonemptyId(value, label) {
  assert.ok(typeof value === 'string' && /^[a-zA-Z0-9:._-]{1,128}$/.test(value), 'invalid ' + label);
}

// Explicit document projection: secrets, provider settings, identity vaults, tokens,
// and personal chat are NEVER implicitly copied to a household namespace.
export function projectForSpace(state, scope) {
  assert.ok(scope === 'personal' || scope === 'household', 'unknown scope fails closed');
  assert.ok(state && typeof state === 'object', 'state required');
  const pantry = (state.pantry ?? []).map(({ id, name, preference }) => ({ id, name, preference }));
  const recipes = (state.recipes ?? []).map(({ id, title, portions }) => ({ id, title, portions }));
  const result = { pantry, recipes };
  if (scope === 'personal') result.chatMessages = (state.chatMessages ?? [])
    .map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt }));
  return result;
}

export function makeUpdate({ engine, spaceId, documentId, dependencies = [], bytes }) {
  assert.ok(ENGINES.includes(engine), 'unsupported engine');
  nonemptyId(spaceId, 'spaceId'); nonemptyId(documentId, 'documentId');
  assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_UPDATE_BYTES, 'invalid binary update');
  assert.ok(Array.isArray(dependencies) && dependencies.length <= 64 &&
    new Set(dependencies).size === dependencies.length &&
    dependencies.every((v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)), 'invalid dependency hashes');
  const payloadSha256 = digest(bytes);
  const header = { schemaVersion: 1, engine, spaceId, documentId, dependencies: [...dependencies].sort(), payloadSha256 };
  const id = digest(Buffer.from(stable(header)));
  return { ...header, id, byteLength: bytes.byteLength, bytes: Uint8Array.from(bytes) };
}
export function assertUpdate(update, expected) {
  for (const key of ['engine', 'spaceId', 'documentId']) {
    assert.equal(update[key], expected[key], 'wrong ' + key + ' rejected before import');
  }
  const recomputed = makeUpdate(update);
  assert.equal(update.id, recomputed.id, 'opaque update identity mismatch');
  assert.equal(update.payloadSha256, recomputed.payloadSha256, 'binary integrity mismatch');
  assert.equal(update.byteLength, recomputed.byteLength, 'length mismatch');
  return true;
}

// Receipt ledger is transport metadata, not an engine change set. Late dependencies
// stay pending; identical replay is idempotent. Conflicting metadata fails closed.
export class ReceiptLedger {
  constructor(expected) { this.expected = expected; this.received = new Map(); this.applied = new Set(); }
  accept(update) {
    assertUpdate(update, this.expected);
    const prior = this.received.get(update.id);
    if (prior) {
      assert.equal(prior.payloadSha256, update.payloadSha256);
      return { fresh: false, ready: [] };
    }
    this.received.set(update.id, update);
    const ready = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, item] of this.received) {
        if (this.applied.has(id) || !item.dependencies.every((parent) => this.applied.has(parent))) continue;
        ready.push(item);
        this.applied.add(id);
        progressed = true;
      }
    }
    return { fresh: true, ready };
  }
  checkpoint() {
    return { schemaVersion: 1, receivedIds: [...this.received.keys()].sort(), appliedIds: [...this.applied].sort() };
  }
}
