export type WorkspaceRole = 'owner' | 'editor' | 'viewer';
export type WorkspaceKind = 'personal' | 'household';

export interface AccountUser {
  id: string;
  email: string;
}

export interface AccountWorkspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceMember {
  user: AccountUser;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: 'editor' | 'viewer';
  expiresAt: string;
  createdAt: string;
  /** Returned once by invitation creation. Treat as a bearer credential. */
  token?: string;
}

export interface StoredAccountSession {
  apiUrl: string;
  token: string;
  expiresAt: string;
  email: string;
}

export type AccountStatus =
  | 'loading'
  | 'local'
  | 'signed-out'
  | 'restoring'
  | 'offline'
  | 'expired'
  | 'signed-in';

/**
 * Engine-independent account/workspace state for settings and future content
 * coordinators. It contains membership metadata only, never cooking records.
 */
export interface AccountWorkspaceSnapshot {
  apiUrl: string;
  status: AccountStatus;
  user: AccountUser | null;
  sessionEmail: string | null;
  spaces: AccountWorkspace[];
  busyAction: string | null;
  error: string | null;
  notice: string | null;
}

export interface AccountResponse {
  user: AccountUser;
  session: { token: string; expiresAt: string };
  spaces: AccountWorkspace[];
}

export interface MeResponse {
  user: AccountUser;
  spaces: AccountWorkspace[];
}
