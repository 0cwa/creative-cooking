/**
 * PROPOSED interface only. No production implementation or app dependency.
 * An engine adapter supplies actual CRDT semantics and conflict evidence;
 * household authorization/crypto are separately required and NOT proven here.
 */
export type Space = Readonly<{ kind: 'personal' | 'household'; id: string }>;
export type StableId = string;
export type SemanticStatus = 'unresolved' | 'resolved' | 'dismissed';
export type Provenance = Readonly<{
  operationId: string | null;
  changeId: string | null;
  authorId: string | null; // opaque participant; never provider credentials
  deps: readonly string[] | null;
}>;
export type ReviewAlternative<T = unknown> = Readonly<{ value: T; source: Provenance }>;
export type ReviewEvidence = Readonly<{
  id: string;
  engine: 'automerge' | 'loro';
  entityId: StableId;
  path: readonly string[];
  kind: 'scalar-disagreement' | 'semantic-delete-edit' | 'semantic-duplicate' | 'semantic-suspicion';
  alternatives: readonly ReviewAlternative[];
  frontier: readonly string[];
  status: SemanticStatus; // device-local until explicit household review protocol
  completeness: 'complete' | 'partial';
}>;
export type CookingView = Readonly<{
  pantry: readonly {id:StableId; name:string; preference:1|2|3|4|5}[];
  recipes: readonly {
    id:StableId; title:string; portions:number;
    ingredients: readonly {name:string; amount?:string}[];
    steps:readonly string[];
  }[];
  chatMessages: readonly {id:StableId;role:'user'|'assistant';content:string}[];
}>;
// Engine projection uses stable ingredient/step IDs internally; UI does not have to
// expose them. No quantity/expiry/tags are mandatory for pantry items.
export type PersistedHistory = Readonly<{
  formatVersion: 1;
  schemaVersion: 2;
  engine: 'automerge' | 'loro';
  space: Space;
  documentId: string;
  fullSnapshot: Uint8Array;
  snapshotSha256: string;
  reviewCheckpoint: Uint8Array; // atomically durable BEFORE future history pruning
  keyEpochReference: string | null; // never private key bytes
}>;
export type OpaqueUpdate = Readonly<{
  engine: 'automerge' | 'loro';
  space: Space;
  documentId: string;
  schemaVersion: 2;
  updateId: string;
  deps: readonly string[];
  bytes: Uint8Array; // still needs separately authenticated encrypted transport
}>;
export type MigrationReport = Readonly<{
  receiptId: string;
  outcome: 'imported' | 'duplicate' | 'quarantined';
  conflictingStableIds: readonly StableId[];
  discardedLegacyFieldPaths: readonly string[];
}>;
export type MutateCooking = Readonly<{
  type: 'pantry/add' | 'pantry/set-preference' | 'recipe/edit' |
    'recipe/move-step' | 'recipe/delete' | 'chat/append';
  space: Space;
  entityId: StableId;
  payload: unknown; // validated by strict operation allowlist, not blindly serialized
}>;
export interface ReplicatedCookingBackend {
  /** Must open indefinitely offline, without an account, or fail visibly. */
  open(space: Space): Promise<CookingView>;
  getView(space: Space): Promise<CookingView>;
  mutate(edit: MutateCooking): Promise<void>;
  /** Creates updates and persists to local WAL before returning for transport. */
  pendingUpdates(space: Space): Promise<readonly OpaqueUpdate[]>;
  /** Authenticated transport boundary is OUTSIDE this interface. */
  receive(update: OpaqueUpdate): Promise<'persisted' | 'duplicate' | 'quarantined'>;
  /** Non-blocking feed; only disagreement or semantic suspicion prompts review. */
  reviewEvents(space: Space): Promise<readonly ReviewEvidence[]>;
  /** Full binary engine document + review evidence retained separately. */
  checkpoint(space: Space): Promise<PersistedHistory>;
  restore(payload: PersistedHistory, space: Space): Promise<void>;
  importLegacyV1(rawBackup: string, space: Space): Promise<MigrationReport>;
}
