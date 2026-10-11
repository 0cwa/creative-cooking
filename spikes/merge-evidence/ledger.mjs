import { createHash } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
export const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Token-based identity does not depend on delivery order, render winner, time or index iteration. */
export function makeEvent({ engine, kind, entity, path: fieldPath, alternatives = [],
  identityTokens = [], frontier = null, concurrency = 'unknown', completeness = 'partial',
  missingCapabilities = [], actions = [], reason = null }) {
  const tokens = [...identityTokens, ...alternatives.map((a) => a.operationId || a.changeId)
    .filter(Boolean)].map(String).sort();
  if (!tokens.length) throw new Error('Evidence event requires durable identity tokens');
  const fingerprint = digest({ version: 1, engine, kind, entity, path: fieldPath, tokens });
  return {
    schemaVersion: 1, id: 'merge:v1:' + fingerprint, fingerprint, kind, entity,
    path: fieldPath, alternatives: [...alternatives].sort((a, b) =>
      String(a.operationId || a.changeId).localeCompare(String(b.operationId || b.changeId))),
    concurrency, frontier: frontier ? [...frontier].sort() : null,
    completeness, missingCapabilities: [...missingCapabilities].sort(), actions,
    status: 'unresolved', resolution: null, reason, sourceEngine: engine
  };
}
export class ReviewLedger {
  constructor(events = []) {
    this.byId = new Map(events.map((event) => [event.id, event]));
    if (this.byId.size !== events.length) throw new Error('Duplicate event IDs in persisted ledger');
  }
  upsert(event) {
    const prior = this.byId.get(event.id);
    if (!prior) this.byId.set(event.id, structuredClone(event));
    // IMPORTANT: processing history again must not undo dismissal or causal resolution.
    return this.byId.get(event.id);
  }
  get(id) { return this.byId.get(id); }
  list() { return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  dismiss(id) {
    const e = this.byId.get(id);
    if (!e) throw new Error('Cannot dismiss an unknown event');
    if (e.status === 'unresolved') e.status = 'dismissed';
    return e;
  }
  resolve(id, proof) {
    const e = this.byId.get(id);
    if (!e) throw new Error('Cannot resolve an unknown event');
    if (!proof || proof.causalProof !== true) throw new Error('No verified causal resolution');
    if (e.status === 'dismissed') return e; // local dismissal remains a separate user choice
    e.status = 'resolved';
    e.resolution = {
      changeId: proof.changeId ?? null,
      value: proof.value,
      evidence: proof.evidence,
      causalProof: true
    };
    return e;
  }
  toJSON() { return { schemaVersion: 1, events: this.list() }; }
  static fromJSON(json) {
    if (json?.schemaVersion !== 1 || !Array.isArray(json.events)) throw new Error('Unsupported ledger schema');
    return new ReviewLedger(json.events);
  }
}

/**
 * Test-only crash-consistent ordering: persist & fsync review checkpoint BEFORE
 * calling destructive engine compaction. This file is NOT replicated state.
 * A real storage implementation must coordinate its engine+ledger transaction.
 */
export function writeCheckpoint(file, { ledger, index = null, frontier = [] }) {
  const payload = { schemaVersion: 1, events: ledger.list(), index, sourceFrontier: [...frontier] };
  const checkpoint = { ...payload, checksum: digest(payload) };
  const temp = file + '.next';
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(checkpoint, null, 2) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(path.dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return checkpoint;
}
export function readCheckpoint(file) {
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  const { checksum, ...payload } = persisted;
  if (digest(payload) !== checksum) throw new Error('Review checkpoint checksum mismatch');
  return { ledger: ReviewLedger.fromJSON(payload), index: payload.index,
    frontier: payload.sourceFrontier, checksum };
}
