import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { CommonPowerSyncDatabase, SyncStatus } from '@powersync/common';
import type { ChefToolProposal } from '../domain/types';
import { keepWorkspaceRecipeVersion as applyWorkspaceRecipeVersion } from '../domain/recipeConflict';
import {
  getAccountWorkspaceSnapshot,
  initializeAccountWorkspace,
  refreshAccountWorkspace,
  subscribeAccountWorkspace
} from '../account/accountWorkspace';
import type { AccountWorkspace, WorkspaceRole } from '../account/contracts';
import { DEFAULT_STATE } from '../domain/defaults';
import type { PersistedState } from '../domain/types';
import { loadState, saveState } from '../storage/appStorage';
import {
  archiveWorkspaceState,
  beginProposalAction,
  guestAdoptionStatus,
  keepGuestArchive,
  keepWorkspaceRecipeSnapshot,
  listLocalArchives,
  loadLocalRecipeConflicts,
  loadPersonalContentConflicts,
  loadWorkspaceState,
  mergeGuestArchive,
  migrateLegacyAggregate,
  openContentProfile,
  persistWorkspaceState,
  readActiveWorkspaceSelection,
  saveActiveWorkspaceSelection,
  stableSerialize,
  withProposalStatus,
  type ContentScope,
  type GuestAdoptionStatus,
  type PersonalContentConflict
} from './contentStore';
import { createPowerSyncConnector, flushPendingContentMutations } from './powerSyncConnector';
import { PERSONAL_CONTENT_TABLES } from './powerSyncSchema';
import { recoverAndActivateWorkspace } from './workspaceExit';

export type ContentSyncStatus =
  | 'opening'
  | 'local-only'
  | 'offline-unverified'
  | 'unconfigured'
  | 'connecting'
  | 'syncing'
  | 'synced'
  | 'attention'
  | 'error'
  | 'switching';

export type LocalPersistenceStatus = 'saving' | 'saved' | 'error';

export type LocalRecipeConflict = Awaited<ReturnType<typeof loadLocalRecipeConflicts>>[number];

export type ContentRuntimeSnapshot = {
  hydrated: boolean;
  storageError: string | null;
  scope: ContentScope;
  workspaceName: string;
  role: WorkspaceRole | null;
  syncStatus: ContentSyncStatus;
  syncError: string | null;
  localPersistenceStatus: LocalPersistenceStatus;
  canEditShared: boolean;
  sharedEditDeniedMessage: string;
  guestAdoption: GuestAdoptionStatus;
  recipeConflicts: LocalRecipeConflict[];
  personalConflicts: PersonalContentConflict[];
  archives: Awaited<ReturnType<typeof listLocalArchives>>;
  localProfileId: string;
  markLocalStateChange(): number;
  selectWorkspace(spaceId: string): Promise<void>;
  keepWorkspaceRecipeVersion(conflictId: string): Promise<void>;
  mergeGuestContent(): Promise<void>;
  keepGuestContent(): Promise<void>;
  prepareAccountExit(): Promise<void>;
  applyProposalEffect(conversationId: string, proposal: ChefToolProposal, before: PersistedState, after: PersistedState): Promise<'applied' | 'queued'>;
  flushCurrentWorkspace(target?: PersistedState): Promise<void>;
  retryStorage(): Promise<boolean>;
  exportWorkspaceRecovery(): Promise<string>;
  reportEditDenied(): void;
};

export type LegacyLoadResult = { state: PersistedState | null; hadData: boolean };

const GUEST_SCOPE: ContentScope = { kind: 'guest', profileId: 'guest', spaceId: 'local-guest' };
const LOCAL_PROFILE_ID = 'guest';
const DATABASE_TABLES = [
  'pantry_items', 'recipes', 'recipe_ingredients', 'recipe_steps', 'shopping_lists', 'shopping_cycles', 'shopping_items', 'shopping_purchases'
];

type ActiveRuntime = {
  db: CommonPowerSyncDatabase;
  scope: ContentScope;
  name: string;
  role: WorkspaceRole | null;
};

function scopeKey(scope: ContentScope, profileId: string): string {
  return scope.kind === 'guest'
    ? `${profileId}:${scope.kind}:${scope.spaceId}`
    : `${profileId}:${scope.kind}:${scope.spaceId}:${scope.workspaceKind}:${scope.personalSpaceId ?? ''}`;
}
function spaceForSelection(spaces: AccountWorkspace[], selectedId: string | null): AccountWorkspace | null {
  if (selectedId) {
    const selected = spaces.find((space) => space.id === selectedId);
    if (selected) return selected;
  }
  return spaces.find((space) => space.kind === 'personal') ?? null;
}

function endpointConfigured(value: string): boolean {
  return Boolean(value.trim());
}

function statusMessage(status: SyncStatus): string | null {
  const error = status.uploadError ?? status.downloadError;
  return error ? error.message : null;
}

function queryForSpace(scope: ContentScope): { sql: string; parameters: string[] } {
  const names = scope.kind === 'guest' ? DATABASE_TABLES.map((name) => `guest_${name}`) : DATABASE_TABLES;
  const clauses = names.map((name) => `SELECT id FROM ${name} WHERE space_id = ?`);
  const parameters = clauses.map(() => scope.spaceId);
  if (scope.kind === 'account') {
    if (scope.personalSpaceId) {
      for (const name of PERSONAL_CONTENT_TABLES) {
        clauses.push(`SELECT id FROM ${name} WHERE space_id = ?`);
        parameters.push(scope.personalSpaceId);
      }
    }
    clauses.push('SELECT id FROM local_recipe_conflicts WHERE space_id = ?');
    parameters.push(scope.spaceId);
    clauses.push('SELECT id FROM local_proposal_actions WHERE space_id = ? OR personal_space_id = ?');
    parameters.push(scope.spaceId, scope.personalSpaceId ?? scope.spaceId);
    clauses.push('SELECT id FROM local_migrations');
  }
  return { sql: clauses.join(' UNION ALL '), parameters };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function useContentRuntime(
  state: PersistedState,
  setState: Dispatch<SetStateAction<PersistedState>>,
  readLegacy: () => Promise<LegacyLoadResult>
): ContentRuntimeSnapshot {
  const account = useSyncExternalStore(subscribeAccountWorkspace, getAccountWorkspaceSnapshot, getAccountWorkspaceSnapshot);
  const [hydrated, setHydrated] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<ContentSyncStatus>('opening');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [localPersistenceStatus, setLocalPersistenceStatus] = useState<LocalPersistenceStatus>('saving');
  const [workspaceName, setWorkspaceName] = useState('Local on this device');
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  const [scope, setScope] = useState<ContentScope>(GUEST_SCOPE);
  const [database, setDatabase] = useState<CommonPowerSyncDatabase | null>(null);
  const [guestAdoption, setGuestAdoption] = useState<GuestAdoptionStatus>({ available: false, migrationId: null, decision: null });
  const [recipeConflicts, setRecipeConflicts] = useState<LocalRecipeConflict[]>([]);
  const [personalConflicts, setPersonalConflicts] = useState<PersonalContentConflict[]>([]);
  const [archives, setArchives] = useState<Awaited<ReturnType<typeof listLocalArchives>>>([]);
  const [editDenied, setEditDenied] = useState<string | null>(null);
  const stateRef = useRef(state);
  const alreadyPersistedState = useRef<PersistedState | null>(null);
  const persistedStateFingerprint = useRef<string | null>(null);
  const runtimeRef = useRef<ActiveRuntime | null>(null);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());
  const transitionGeneration = useRef(0);
  const transitionInProgress = useRef(false);
  const workspaceSelectionGeneration = useRef(0);
  const workspaceSelectionInProgress = useRef(false);
  const legacyReadRef = useRef(readLegacy);
  const retryMigration = useRef(false);
  const persistenceGeneration = useRef(0);
  const localEditRevision = useRef(0);
  const persistedLocalEditRevision = useRef(0);
  const guestAdoptionInProgress = useRef(false);
  const observedState = useRef(state);
  const stateRevision = useRef(0);
  if (observedState.current !== state) {
    observedState.current = state;
    stateRevision.current += 1;
  }
  stateRef.current = state;
  legacyReadRef.current = readLegacy;

  const setSyncFromStatus = useCallback(async (active: ActiveRuntime, status: SyncStatus) => {
    if (runtimeRef.current !== active || active.scope.kind !== 'account') return;
    const message = statusMessage(status);
    setSyncError(message);
    if (message) {
      setSyncStatus('error');
      return;
    }
    if (!status.connected) {
      setSyncStatus(status.connecting ? 'connecting' : 'offline-unverified');
      return;
    }
    if (!status.hasSynced || status.uploading || status.downloading) {
      setSyncStatus('syncing');
      return;
    }
    try {
      const queue = await active.db.getUploadQueueStats();
      if (runtimeRef.current !== active) return;
      const pending = await active.db.getOptional<{ count: number }>(
        'SELECT COUNT(*) AS count FROM local_content_outbox'
      );
      const issues = await active.db.getOptional<{ count: number }>(
        'SELECT COUNT(*) AS count FROM local_sync_issues WHERE resolved_at IS NULL'
      );
      const proposalActions = await active.db.getOptional<{ count: number }>(
        'SELECT COUNT(*) AS count FROM local_proposal_actions'
      );
      const recipeConflicts = await active.db.getOptional<{ count: number }>(
        'SELECT COUNT(*) AS count FROM local_recipe_conflicts'
      );
      setSyncStatus(queue.count === 0 && Number(pending?.count ?? 0) === 0
        && Number(issues?.count ?? 0) === 0 && Number(proposalActions?.count ?? 0) === 0
        && Number(recipeConflicts?.count ?? 0) === 0 ? 'synced' : 'attention');
    } catch {
      setSyncStatus('syncing');
    }
  }, []);

  const markLocalStateChange = useCallback(() => {
    localEditRevision.current += 1;
    setLocalPersistenceStatus('saving');
    return localEditRevision.current;
  }, []);

  const markLocalStateCommitted = useCallback((revision: number) => {
    persistedLocalEditRevision.current = Math.max(persistedLocalEditRevision.current, revision);
  }, []);

  const saveCurrent = useCallback(async (active: ActiveRuntime, current: PersistedState) => {
    await persistWorkspaceState(active.db, active.scope, current);
    if (active.scope.kind === 'guest') await saveState(current);
  }, []);

  const enqueuePersist = useCallback((active: ActiveRuntime, current: PersistedState, flushAfterSave = true): Promise<void> => {
    const generation = ++persistenceGeneration.current;
    const editRevision = localEditRevision.current;
    setLocalPersistenceStatus('saving');
    const task = persistenceQueue.current.catch(() => undefined).then(() => saveCurrent(active, current));
    void task.then(() => {
      persistedStateFingerprint.current = stableSerialize(current);
      markLocalStateCommitted(editRevision);
      if (generation === persistenceGeneration.current) setLocalPersistenceStatus('saved');
      if (flushAfterSave && active.scope.kind === 'account' && account.status === 'signed-in') {
        void flushPendingContentMutations(active.db).then(() => {
          if (runtimeRef.current === active) void setSyncFromStatus(active, active.db.currentStatus);
        }).catch((error) => {
          if (runtimeRef.current !== active) return;
          setSyncStatus('error');
          setSyncError(error instanceof Error ? error.message : 'Saved workspace edits are waiting for the service.');
        });
      }
    }, () => undefined);
    persistenceQueue.current = task.catch((error) => {
      if (generation === persistenceGeneration.current) setLocalPersistenceStatus('error');
      setStorageError(error instanceof Error ? error.message : 'Creative Cooking could not save this workspace locally.');
      setSyncStatus('error');
    });
    return task;
  }, [account.status, markLocalStateCommitted, saveCurrent, setSyncFromStatus]);

  const updateRecoveryDetails = useCallback(async (active: ActiveRuntime) => {
    if (active.scope.kind !== 'account') {
      setGuestAdoption({ available: false, migrationId: null, decision: null });
      setRecipeConflicts([]);
      setPersonalConflicts([]);
      return;
    }
    const [currentGuest, conflicts, privateConflicts, nextArchives] = await Promise.all([
      (async () => {
        const guestDb = await openContentProfile(LOCAL_PROFILE_ID);
        return loadWorkspaceState(guestDb, GUEST_SCOPE, DEFAULT_STATE);
      })(),
      loadLocalRecipeConflicts(active.db, active.scope.spaceId),
      loadPersonalContentConflicts(active.db, active.scope.personalSpaceId),
      listLocalArchives(active.db)
    ]);
    const adoption = await guestAdoptionStatus(currentGuest, active.db, DEFAULT_STATE, active.scope.spaceId);
    if (runtimeRef.current !== active) return;
    setGuestAdoption(adoption);
    setRecipeConflicts(conflicts);
    setPersonalConflicts(privateConflicts);
    setArchives(nextArchives);
  }, []);

  const activateWorkspace = useCallback(async (
    next: ActiveRuntime,
    profileId: string,
    transitionReason: 'signout' | 'membership-removed' | 'workspace-switch'
  ) => {
    const current = runtimeRef.current;
    const previousState = stateRef.current;
    const key = scopeKey(next.scope, profileId);
    const currentKey = current ? scopeKey(current.scope, current.scope.profileId) : null;
    if (current && currentKey === key) {
      current.name = next.name;
      current.role = next.role;
      setScope(next.scope);
      setWorkspaceName(next.name);
      setRole(next.role);
      return current;
    }

    const requestGeneration = ++transitionGeneration.current;
    transitionInProgress.current = true;
    setSyncStatus('switching');
    try {
      const activation = await recoverAndActivateWorkspace({
        hidePreviousAccount: () => {
          if (current?.scope.kind !== 'account') return;
          // Hide the prior account's cooking data before any best-effort write
          // or archive can fail. Its database remains local and recoverable.
          stateRef.current = DEFAULT_STATE;
          alreadyPersistedState.current = DEFAULT_STATE;
          persistedStateFingerprint.current = stableSerialize(DEFAULT_STATE);
          setState(DEFAULT_STATE);
          setDatabase(null);
          setScope(next.scope);
          setWorkspaceName(next.name);
          setRole(next.role);
          setEditDenied(null);
          setStorageError(null);
        },
        ...(current ? { persistPrevious: () => enqueuePersist(current, previousState) } : {}),
        ...(current?.scope.kind === 'account'
          ? { archivePrevious: async () => { await archiveWorkspaceState(current.db, current.scope, previousState, transitionReason); } }
          : {}),
        activateNext: async (recoveryErrors) => {
          if (requestGeneration !== transitionGeneration.current) return null;
          if (next.scope.kind === 'account' && next.scope.spaceId !== 'offline-unverified') {
            await saveActiveWorkspaceSelection(next.db, {
              spaceId: next.scope.spaceId,
              workspaceKind: next.scope.workspaceKind,
              personalSpaceId: next.scope.personalSpaceId
            });
          }
          const nextState = await loadWorkspaceState(next.db, next.scope, DEFAULT_STATE);
          if (requestGeneration !== transitionGeneration.current) return null;
          runtimeRef.current = next;
          stateRef.current = nextState;
          alreadyPersistedState.current = nextState;
          persistedStateFingerprint.current = stableSerialize(nextState);
          setState(nextState);
          setDatabase(next.db);
          setScope(next.scope);
          setWorkspaceName(next.name);
          setRole(next.role);
          setEditDenied(null);
          setStorageError(recoveryErrors.length
            ? 'The previous account workspace could not be fully saved or archived before switching. Its existing account profile remains on this device for recovery.'
            : null);
          setSyncError(null);
          setSyncStatus(next.scope.kind === 'guest'
            ? 'local-only'
            : account.status === 'offline' ? 'offline-unverified' : endpointConfigured(account.powerSyncUrl) ? 'connecting' : 'unconfigured');
          await updateRecoveryDetails(next);
          return next;
        }
      });
      return activation.value;
    } finally {
      if (requestGeneration === transitionGeneration.current) {
        transitionInProgress.current = false;
        setSyncStatus((currentStatus) => currentStatus === 'switching'
          ? next.scope.kind === 'guest' ? 'local-only' : account.status === 'offline' ? 'offline-unverified' : endpointConfigured(account.powerSyncUrl) ? 'connecting' : 'unconfigured'
          : currentStatus);
      }
    }
  }, [account.status, enqueuePersist, setState, updateRecoveryDetails]);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      await initializeAccountWorkspace();
      const guestDb = await openContentProfile(LOCAL_PROFILE_ID);
      let legacy: LegacyLoadResult | null = null;
      try {
        legacy = await legacyReadRef.current();
      } catch (error) {
        retryMigration.current = true;
        setStorageError(error instanceof Error ? error.message : 'The saved local cooking data could not be read.');
      }
      if (legacy) await migrateLegacyAggregate(guestDb, legacy.hadData ? legacy.state : null);
      const guestState = await loadWorkspaceState(guestDb, GUEST_SCOPE, DEFAULT_STATE);
      if (!active) return;
      const guestRuntime = { db: guestDb, scope: GUEST_SCOPE, name: 'Local on this device', role: null };
      runtimeRef.current = guestRuntime;
      stateRef.current = guestState;
      alreadyPersistedState.current = guestState;
      persistedStateFingerprint.current = stableSerialize(guestState);
      setState(guestState);
      setDatabase(guestDb);
      setScope(GUEST_SCOPE);
      setWorkspaceName(guestRuntime.name);
      setRole(null);
      setHydrated(true);
      setSyncStatus('local-only');
      setLocalPersistenceStatus('saved');
    };
    void initialize().catch((error) => {
      if (!active) return;
      setStorageError(error instanceof Error ? error.message : 'Creative Cooking could not open local cooking data.');
      setSyncStatus('error');
      setLocalPersistenceStatus('error');
      setHydrated(true);
    });
    return () => { active = false; };
  }, [setState]);

  const accountSpaceKey = useMemo(() => account.spaces.map((space) => `${space.id}:${space.kind}:${space.role}:${space.name}`).join('|'), [account.spaces]);
  useEffect(() => {
    if (!hydrated || account.status === 'loading' || account.status === 'restoring') return;
    let active = true;
    const selectionGeneration = workspaceSelectionGeneration.current;
    void (async () => {
      if ((account.status === 'signed-in' || account.status === 'offline') && account.localProfileId) {
        const db = await openContentProfile(account.localProfileId);
        if (!active || workspaceSelectionInProgress.current || selectionGeneration !== workspaceSelectionGeneration.current) return;
        const storedSelection = await readActiveWorkspaceSelection(db);
        if (!active || workspaceSelectionInProgress.current || selectionGeneration !== workspaceSelectionGeneration.current) return;
        if (account.status === 'signed-in') {
          const previous = runtimeRef.current;
          const stillMemberSpace = previous?.scope.kind === 'account'
            && previous.scope.profileId === account.localProfileId
            ? account.spaces.find((space) => space.id === previous.scope.spaceId) ?? null
            : null;
          const selected = stillMemberSpace ?? spaceForSelection(account.spaces, storedSelection?.spaceId ?? null);
          if (!selected) {
            setStorageError('The account service did not return a personal workspace. Local cooking data was kept unchanged.');
            return;
          }
          const personalSpace = account.spaces.find((space) => space.kind === 'personal') ?? null;
          const removed = previous?.scope.kind === 'account'
            && previous.scope.profileId === account.localProfileId
            && !account.spaces.some((space) => space.id === previous.scope.spaceId);
          await activateWorkspace({
            db,
            scope: {
              kind: 'account', profileId: account.localProfileId, spaceId: selected.id,
              workspaceKind: selected.kind, personalSpaceId: personalSpace?.id ?? null
            },
            name: selected.name,
            role: selected.role
          }, account.localProfileId, removed ? 'membership-removed' : previous?.scope.kind === 'account' ? 'workspace-switch' : 'signout');
        } else if (storedSelection) {
          await activateWorkspace({
            db,
            scope: { kind: 'account', profileId: account.localProfileId, ...storedSelection },
            name: 'Saved workspace (membership unverified)',
            role: null
          }, account.localProfileId, 'signout');
        }
        if (!storedSelection && account.status === 'offline') {
          setSyncStatus('offline-unverified');
          setWorkspaceName('Offline copy; no confirmed workspace');
        }
        return;
      }
      if (account.status === 'signed-out' || account.status === 'expired' || account.status === 'local') {
        const guestDb = await openContentProfile(LOCAL_PROFILE_ID);
        if (!active) return;
        const reason = 'signout';
        await activateWorkspace({ db: guestDb, scope: GUEST_SCOPE, name: 'Local on this device', role: null }, LOCAL_PROFILE_ID, reason);
      }
    })().catch((error) => {
      if (active) {
        setStorageError(error instanceof Error ? error.message : 'The selected cooking workspace could not be opened.');
        setSyncStatus('error');
      }
    });
    return () => { active = false; };
  }, [account.status, account.localProfileId, accountSpaceKey, activateWorkspace, hydrated]);

  useEffect(() => {
    if (!hydrated || !database || !runtimeRef.current) return;
    if (persistedStateFingerprint.current === stableSerialize(state)) {
      alreadyPersistedState.current = null;
      return;
    }
    if (alreadyPersistedState.current === state) {
      alreadyPersistedState.current = null;
      persistedStateFingerprint.current = stableSerialize(state);
      return;
    }
    alreadyPersistedState.current = null;
    if (transitionInProgress.current || guestAdoptionInProgress.current) return;
    const current = runtimeRef.current;
    if (scopeKey(current.scope, current.scope.profileId) !== scopeKey(scope, scope.profileId)) return;
    // Passive effects from an older render may run after a newer state update.
    // Persist only the state object that is still current in this runtime.
    if (stateRef.current !== state) return;
    void enqueuePersist(current, state).catch(() => undefined);
  }, [database, enqueuePersist, hydrated, scope, state]);

  useEffect(() => {
    if (!database || !runtimeRef.current) return;
    const active = runtimeRef.current;
    const query = queryForSpace(active.scope);
    const abort = new AbortController();
    let live = true;
    void (async () => {
      try {
        for await (const _result of active.db.watch(query.sql, query.parameters, { signal: abort.signal })) {
          if (!live || runtimeRef.current !== active) break;
          if (transitionInProgress.current || guestAdoptionInProgress.current) continue;
          // A render effect has not enqueued persistence yet while its local
          // edit revision is ahead. A read started in that gap can observe the
          // pre-edit database and finish after the write commits.
          if (localEditRevision.current !== persistedLocalEditRevision.current) continue;
          const revisionAtRead = stateRevision.current;
          const editRevisionAtRead = localEditRevision.current;
          const next = await loadWorkspaceState(active.db, active.scope, DEFAULT_STATE);
          if (!live || runtimeRef.current !== active) break;
          if (transitionInProgress.current || guestAdoptionInProgress.current) continue;
          // A watch read can finish after a newer local edit was rendered. Do
          // not let that older snapshot overwrite the user's in-flight state.
          if (stateRevision.current !== revisionAtRead
            || localEditRevision.current !== editRevisionAtRead
            || localEditRevision.current !== persistedLocalEditRevision.current) continue;
          stateRef.current = next;
          alreadyPersistedState.current = next;
          persistedStateFingerprint.current = stableSerialize(next);
          setState(next);
          if (active.scope.kind === 'account') {
            setRecipeConflicts(await loadLocalRecipeConflicts(active.db, active.scope.spaceId));
            setPersonalConflicts(await loadPersonalContentConflicts(active.db, active.scope.personalSpaceId));
            await updateRecoveryDetails(active);
          }
        }
      } catch (error) {
        if (live && !abort.signal.aborted && active.scope.kind === 'account') {
          setSyncError(error instanceof Error ? error.message : 'Workspace changes could not be observed.');
        }
      }
    })();
    return () => { live = false; abort.abort(); };
  }, [database, scope, setState, updateRecoveryDetails]);

  useEffect(() => {
    const active = runtimeRef.current;
    if (!database || !active || active.scope.kind !== 'account') return;
    if (account.status !== 'signed-in' || account.localProfileId !== active.scope.profileId) {
      void database.disconnect().catch(() => undefined);
      if (account.status === 'offline') setSyncStatus('offline-unverified');
      return;
    }
    if (!endpointConfigured(account.powerSyncUrl)) {
      setSyncStatus('unconfigured');
      setSyncError('No PowerSync Service URL is saved on this device. Local cooking and account workspaces still work here.');
      return;
    }

    let live = true;
    const listener = {
      statusChanged: (status: SyncStatus) => { void setSyncFromStatus(active, status); }
    };
    const unregister = database.registerListener(listener);
    setSyncStatus('connecting');
    setSyncError(null);
    void database.connect(createPowerSyncConnector(database)).then(() => {
      if (live) void setSyncFromStatus(active, database.currentStatus);
    }).catch((error) => {
      if (live) {
        setSyncStatus('error');
        setSyncError(error instanceof Error ? error.message : 'The PowerSync service connection failed.');
      }
    });
    return () => {
      live = false;
      unregister();
      void database.disconnect().catch(() => undefined);
    };
  }, [account.status, account.localProfileId, account.powerSyncUrl, database, setSyncFromStatus]);

  useEffect(() => {
    if (hydrated && runtimeRef.current?.scope.kind === 'account') void updateRecoveryDetails(runtimeRef.current);
  }, [account.spaces, account.status, hydrated, scope, updateRecoveryDetails]);

  useEffect(() => {
    const active = runtimeRef.current;
    if (account.status !== 'signed-in' || !account.user || !active || active.scope.kind !== 'account'
      || active.scope.profileId !== account.localProfileId) return;
    void flushPendingContentMutations(active.db).catch((error) => {
      if (runtimeRef.current === active) {
        setSyncError(error instanceof Error ? error.message : 'Saved workspace edits are waiting for a connection.');
      }
    });
  }, [account.localProfileId, account.status, account.user, database, scope]);

  useEffect(() => {
    const active = runtimeRef.current;
    if ((account.status !== 'signed-in' && account.status !== 'offline')
      || (account.status === 'signed-in' && !account.user)
      || !active || active.scope.kind !== 'account'
      || active.scope.profileId !== account.localProfileId || typeof window === 'undefined'
      || typeof window.addEventListener !== 'function') return;
    const retryWhenOnline = () => {
      if (runtimeRef.current !== active || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
      const flush = () => flushPendingContentMutations(active.db).catch((error) => {
        if (runtimeRef.current === active) {
          setSyncError(error instanceof Error ? error.message : 'Saved workspace edits are waiting for a connection.');
        }
      });
      if (account.status === 'offline') {
        void refreshAccountWorkspace().then(flush).catch((error) => {
          if (runtimeRef.current === active) {
            setSyncError(error instanceof Error ? error.message : 'Account access could not be confirmed after reconnecting.');
          }
        });
      } else {
        void flush();
      }
    };
    window.addEventListener('online', retryWhenOnline);
    return () => window.removeEventListener('online', retryWhenOnline);
  }, [account.localProfileId, account.status, account.user, database, scope]);

  const flushCurrentWorkspace = useCallback(async () => {
    const active = runtimeRef.current;
    if (!active) return;
    await enqueuePersist(active, stateRef.current);
    await persistenceQueue.current;
  }, [enqueuePersist]);

  const selectWorkspace = useCallback(async (spaceId: string) => {
    if (guestAdoptionInProgress.current) throw new Error('Wait for the local cooking import to finish before changing workspaces.');
    if (account.status !== 'signed-in' || !account.localProfileId) throw new Error('Confirm the account session before changing workspaces.');
    const selected = account.spaces.find((space) => space.id === spaceId);
    if (!selected) throw new Error('The account service has not confirmed membership in this workspace.');
    const personalSpace = account.spaces.find((space) => space.kind === 'personal') ?? null;
    const selectionGeneration = ++workspaceSelectionGeneration.current;
    workspaceSelectionInProgress.current = true;
    try {
      const db = await openContentProfile(account.localProfileId);
      if (selectionGeneration !== workspaceSelectionGeneration.current) return;
      await activateWorkspace({
        db,
        scope: {
          kind: 'account', profileId: account.localProfileId, spaceId: selected.id,
          workspaceKind: selected.kind, personalSpaceId: personalSpace?.id ?? null
        },
        name: selected.name,
        role: selected.role
      }, account.localProfileId, 'workspace-switch');
    } finally {
      if (selectionGeneration === workspaceSelectionGeneration.current) workspaceSelectionInProgress.current = false;
    }
  }, [account.localProfileId, account.spaces, account.status, activateWorkspace]);

  const keepWorkspaceRecipeVersion = useCallback(async (conflictId: string) => {
    const active = runtimeRef.current;
    const currentAccount = getAccountWorkspaceSnapshot();
    if (!active || active.scope.kind !== 'account'
      || active.scope.profileId !== currentAccount.localProfileId
      || (currentAccount.status !== 'signed-in' && currentAccount.status !== 'offline')) {
      throw new Error('Reconnect the same account before resolving this recipe conflict.');
    }

    await persistenceQueue.current;
    const conflict = await active.db.getOptional<LocalRecipeConflict>(
      `SELECT id, recipe_id, attempted_json, current_json, reason, created_at
       FROM local_recipe_conflicts WHERE id = ? AND space_id = ?`,
      [conflictId, active.scope.spaceId]
    );
    if (!conflict) throw new Error('This recipe conflict is no longer available. Its recovery data was kept.');
    const resolution = applyWorkspaceRecipeVersion(stateRef.current, conflict);
    if (!resolution) throw new Error('The saved workspace version is invalid. The conflict remains available for recovery.');

    const editRevision = markLocalStateChange();
    try {
      await keepWorkspaceRecipeSnapshot(
        active.db,
        active.scope.spaceId,
        conflict.id,
        conflict.recipe_id,
        resolution.snapshot
      );
    } catch (error) {
      if (runtimeRef.current === active) setLocalPersistenceStatus('error');
      throw error;
    }
    const afterAccount = getAccountWorkspaceSnapshot();
    if (runtimeRef.current !== active || afterAccount.localProfileId !== active.scope.profileId) return;

    markLocalStateCommitted(editRevision);
    stateRef.current = resolution.state;
    alreadyPersistedState.current = resolution.state;
    persistedStateFingerprint.current = stableSerialize(resolution.state);
    setState(resolution.state);
    setLocalPersistenceStatus('saved');
    await updateRecoveryDetails(active);
    await setSyncFromStatus(active, active.db.currentStatus);
  }, [markLocalStateChange, markLocalStateCommitted, setState, setSyncFromStatus, updateRecoveryDetails]);

  const refreshAdoption = useCallback(async () => {
    const active = runtimeRef.current;
    if (!active || active.scope.kind !== 'account') return;
    await updateRecoveryDetails(active);
  }, [updateRecoveryDetails]);

  const mergeGuestContent = useCallback(async () => {
    const active = runtimeRef.current;
    if (!active || active.scope.kind !== 'account' || account.status !== 'signed-in' || !account.user) {
      throw new Error('Sign in and choose a confirmed workspace before merging local cooking data.');
    }
    if (guestAdoptionInProgress.current) throw new Error('The local cooking import is already running.');
    guestAdoptionInProgress.current = true;
    setSyncStatus('switching');
    try {
      const editRevision = markLocalStateChange();
      await flushCurrentWorkspace();
      const guestDb = await openContentProfile(LOCAL_PROFILE_ID);
      const guestState = await loadWorkspaceState(guestDb, GUEST_SCOPE, DEFAULT_STATE);
      const result = await mergeGuestArchive(active.db, guestState, stateRef.current, active.scope, DEFAULT_STATE);
      if (runtimeRef.current !== active) throw new Error('The account changed while local cooking data was being merged.');
      markLocalStateCommitted(editRevision);
      stateRef.current = result;
      alreadyPersistedState.current = result;
      persistedStateFingerprint.current = stableSerialize(result);
      setState(result);
      setLocalPersistenceStatus('saved');
      await updateRecoveryDetails(active);
    } catch (error) {
      setLocalPersistenceStatus('error');
      throw error;
    } finally {
      guestAdoptionInProgress.current = false;
      if (runtimeRef.current === active) void setSyncFromStatus(active, active.db.currentStatus);
    }
  }, [account.status, account.user, flushCurrentWorkspace, markLocalStateChange, markLocalStateCommitted, setState, setSyncFromStatus, updateRecoveryDetails]);

  const keepGuestContent = useCallback(async () => {
    const active = runtimeRef.current;
    if (!active || active.scope.kind !== 'account' || account.status !== 'signed-in' || !account.user) {
      throw new Error('Sign in and choose a confirmed workspace before recording this choice.');
    }
    const guestDb = await openContentProfile(LOCAL_PROFILE_ID);
    const guestState = await loadWorkspaceState(guestDb, GUEST_SCOPE, DEFAULT_STATE);
    await keepGuestArchive(active.db, guestState, account.user.id, active.scope.spaceId);
    await updateRecoveryDetails(active);
  }, [account.status, account.user, updateRecoveryDetails]);

  const prepareAccountExit = useCallback(async () => {
    const active = runtimeRef.current;
    if (!active || active.scope.kind !== 'account') return;
    await flushCurrentWorkspace();
    await archiveWorkspaceState(active.db, active.scope, stateRef.current, 'signout');
  }, [flushCurrentWorkspace]);

  const applyProposalEffect = useCallback(async (
    conversationId: string,
    proposal: ChefToolProposal,
    before: PersistedState,
    after: PersistedState
  ): Promise<'applied' | 'queued'> => {
    const active = runtimeRef.current;
    if (!active) throw new Error('The cooking workspace is still opening. Try again when it is ready.');
    if (active.scope.kind === 'guest') {
      const applied = withProposalStatus(after, conversationId, proposal.id, 'applied');
      const editRevision = markLocalStateChange();
      try {
        await persistWorkspaceState(active.db, active.scope, applied);
        await saveState(applied);
      } catch (error) {
        setLocalPersistenceStatus('error');
        throw error;
      }
      markLocalStateCommitted(editRevision);
      setLocalPersistenceStatus('saved');
      if (runtimeRef.current === active) {
        stateRef.current = applied;
        alreadyPersistedState.current = applied;
        persistedStateFingerprint.current = stableSerialize(applied);
        setState(applied);
      }
      return 'applied';
    }
    if (account.status !== 'signed-in' && account.status !== 'offline') {
      throw new Error('Confirm the account session before applying a shared cooking change. The suggestion remains pending.');
    }
    const editRevision = markLocalStateChange();
    let result: Awaited<ReturnType<typeof beginProposalAction>>;
    try {
      // Wait for any earlier rendered edit to reach the local transaction queue
      // before starting the cross-workspace Chef action. This keeps an older
      // state snapshot from racing the durable action/effect transaction.
      await enqueuePersist(active, before, false);
      await persistenceQueue.current;
      result = await beginProposalAction(active.db, active.scope, before, after, conversationId, proposal);
    } catch (error) {
      markLocalStateCommitted(editRevision);
      setLocalPersistenceStatus('error');
      throw error;
    }
    markLocalStateCommitted(editRevision);
    setLocalPersistenceStatus('saved');
    if (runtimeRef.current === active) {
      stateRef.current = result.state;
      alreadyPersistedState.current = result.state;
      persistedStateFingerprint.current = stableSerialize(result.state);
      setState(result.state);
      if (account.status === 'signed-in') {
        void flushPendingContentMutations(active.db).catch((error) => {
          if (runtimeRef.current === active) {
            setSyncError(error instanceof Error ? error.message : 'The Chef change is saved locally and waiting for confirmation.');
          }
        });
      }
    }
    return 'queued';
  }, [account.status, enqueuePersist, markLocalStateChange, markLocalStateCommitted, setState]);

  const retryStorage = useCallback(async (): Promise<boolean> => {
    try {
      if (retryMigration.current) {
        const legacy = await legacyReadRef.current();
        const guestDb = await openContentProfile(LOCAL_PROFILE_ID);
        await migrateLegacyAggregate(guestDb, legacy.hadData ? legacy.state : null);
        retryMigration.current = false;
      }
      await flushCurrentWorkspace();
      setStorageError(null);
      return true;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Creative Cooking could not save local data.');
      return false;
    }
  }, [flushCurrentWorkspace]);

  const exportWorkspaceRecovery = useCallback(async () => {
    const active = runtimeRef.current;
    if (!active) return safeJson({ state: stateRef.current, outbox: [] });
    await flushCurrentWorkspace();
    const [localArchives, pending, blocked, issues] = await Promise.all([
      listLocalArchives(active.db),
      active.db.getAll('SELECT space_id, mutation_id, payload_json, created_at FROM local_content_outbox WHERE state = ? ORDER BY created_at', ['pending']),
      active.db.getAll('SELECT space_id, mutation_id, payload_json, error_json, created_at FROM local_content_outbox WHERE state != ? ORDER BY created_at', ['pending']),
      active.db.getAll('SELECT space_id, issue_type, message, data_json, created_at FROM local_sync_issues WHERE resolved_at IS NULL ORDER BY created_at')
    ]);
    const proposalActions = await active.db.getAll('SELECT * FROM local_proposal_actions ORDER BY created_at, id');
    return safeJson({ state: stateRef.current, archives: localArchives, pending, blocked, issues, proposalActions });
  }, [flushCurrentWorkspace]);

  const reportEditDenied = useCallback(() => {
    setEditDenied(role === 'viewer'
      ? 'This workspace is read-only for your viewer role. Choose an editor workspace or continue in local mode.'
      : syncStatus === 'switching'
        ? 'Wait for the selected workspace to finish opening before editing.'
        : 'This workspace is not available for editing until account access is confirmed.');
  }, [role, syncStatus]);

  const canEditShared = scope.kind === 'guest'
    || (account.status === 'offline' && Boolean(account.localProfileId) && scope.spaceId !== 'offline-unverified')
    || ((role === 'owner' || role === 'editor') && account.status === 'signed-in')
    || (role === null && account.status === 'local');
  const sharedEditDeniedMessage = role === 'viewer'
    ? 'This workspace is read-only for viewers. The suggestion remains pending.'
    : transitionInProgress.current || guestAdoptionInProgress.current
      ? 'Wait for the selected workspace or local import to finish. The suggestion remains pending.'
      : account.status === 'signed-in' && role === null
        ? 'The account service has not confirmed an editable membership in this workspace. The suggestion remains pending.'
        : account.status === 'offline'
          ? 'Reconnect to confirm workspace access before applying shared changes. The suggestion remains pending.'
          : account.status !== 'signed-in' && account.status !== 'local'
            ? 'Confirm the account session before applying shared changes. The suggestion remains pending.'
            : 'This workspace is not available for editing. The suggestion remains pending.';

  return {
    hydrated,
    storageError: storageError ?? editDenied,
    scope,
    workspaceName,
    role,
    syncStatus: transitionInProgress.current || guestAdoptionInProgress.current ? 'switching' : syncStatus,
    syncError,
    localPersistenceStatus,
    canEditShared: canEditShared && !transitionInProgress.current && !guestAdoptionInProgress.current,
    sharedEditDeniedMessage,
    guestAdoption,
    recipeConflicts,
    personalConflicts,
    archives,
    localProfileId: account.localProfileId ?? LOCAL_PROFILE_ID,
    markLocalStateChange,
    selectWorkspace,
    keepWorkspaceRecipeVersion,
    mergeGuestContent,
    keepGuestContent,
    prepareAccountExit,
    applyProposalEffect,
    flushCurrentWorkspace,
    retryStorage,
    exportWorkspaceRecovery,
    reportEditDenied
  };
}
