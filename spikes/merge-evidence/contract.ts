/**
 * PROPOSED engine-independent evidence record, not a production schema.
 * IDs refer to observed immutable operations/changes, never to an LWW winner.
 * Device identities are opaque, nullable, and deliberately not credentials.
 */
export type EvidenceCompleteness = 'complete' | 'partial' | 'unavailable' | 'not-applicable';
export type MergeEventKind =
  | 'scalar-disagreement'
  | 'semantic-delete-edit'
  | 'semantic-duplicate-pantry'
  | 'semantic-suspicion'
  | 'clean-activity';
export type ReviewStatus = 'unresolved' | 'resolved' | 'dismissed';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ChangeEvidence {
  /** Stable change identity from the engine; never a fabricated clock. */
  changeId: string | null;
  /** Engine-specific opaque operation key; adapters own its interpretation. */
  operationId: string | null;
  /** Device/actor identifier when legitimately available; not a human name. */
  authorId: string | null;
  /** Dependencies/hashes/frontier if exposed; null explicitly means unknown. */
  dependencies: string[] | null;
  value: JsonValue;
}
export interface MergeEvent {
  schemaVersion: 1;
  /** SHA-256 of sorted, stable source tokens and logical identity, NOT wall time. */
  id: string;
  fingerprint: string;
  kind: MergeEventKind;
  entity: { type: 'recipe' | 'ingredient' | 'pantry'; id: string };
  path: string[];
  alternatives: ChangeEvidence[];
  concurrency: 'concurrent' | 'causally-ordered' | 'unknown' | 'not-applicable';
  /** Source frontier at detection; may be absent after compaction. */
  frontier: string[] | null;
  completeness: EvidenceCompleteness;
  missingCapabilities: string[];
  /** Proposed actions, not instructions to auto-select a displayed LWW value. */
  actions: string[];
  status: ReviewStatus;
  resolution: null | {
    changeId: string | null;
    value: JsonValue;
    evidence: string;
    causalProof: boolean;
  };
  /** Free-form policy reason without conflating semantic issues with CRDT conflicts. */
  reason: string | null;
  /**
   * Immutable source engine for provenance debugging. Identity is engine-neutral
   * in shape, but fingerprints need not match across different CRDT engines.
   */
  sourceEngine: 'automerge' | 'loro';
}
export interface LocalReviewCheckpoint {
  schemaVersion: 1;
  /** Derived local review cache, NOT authoritative replicated domain state. */
  events: MergeEvent[];
  /** Optional engine-derived index. Rebuildable only while history remains. */
  index: JsonValue | null;
  /** Captured pre-compaction source frontier/heads for audit. */
  sourceFrontier: string[];
  /** File integrity fingerprint; atomic/durable write is caller responsibility. */
  checksum: string;
}
