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
  /** Local database partition only; never treated as proof of current membership. */
  userId?: string;
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
  powerSyncUrl: string;
  status: AccountStatus;
  user: AccountUser | null;
  localProfileId: string | null;
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

/** PowerSync's short-lived service credential, minted from the opaque app session. */
export interface PowerSyncCredentialResponse {
  token: string;
  expiresAt: string;
}

type MutationOperationBase = { opId: string };

export type ContentMutationOperation =
  | (MutationOperationBase & { type: 'pantry.upsert'; id: string; name: string; preference: number })
  | (MutationOperationBase & { type: 'pantry.delete'; id: string })
  | (MutationOperationBase & { type: 'recipe.save'; baseVersion: number | null; recipe: {
      id: string; title: string; description?: string | null; portions: number; notes: string[];
      ingredients: Array<{ id: string; name: string; amount?: string | null; needsShopping?: boolean; metadata?: Record<string, unknown> }>;
      steps: Array<{ id: string; text: string }>;
    } })
  | (MutationOperationBase & { type: 'recipe.delete'; id: string; baseVersion: number })
  | (MutationOperationBase & { type: 'shopping.list.create'; list: { id: string; name: string; currentCycleId: string; createdAt: string; updatedAt: string }; cycle: { id: string; listId: string; startedAt: string } })
  | (MutationOperationBase & { type: 'shopping.list.rename'; id: string; name: string; updatedAt: string })
  | (MutationOperationBase & { type: 'shopping.list.remove'; id: string; removedAt?: string })
  | (MutationOperationBase & { type: 'shopping.cycle.start'; listId: string; cycle: { id: string; startedAt: string } })
  | (MutationOperationBase & { type: 'shopping.item.upsert'; item: {
      id: string; listId: string; name: string; recipeId?: string | null; ingredientId?: string | null;
      displayQuantity?: string | null; displayUnit?: string | null; purchaseCycleId: string; checked: boolean;
      purchasedCycleId?: string | null; createdAt: string; updatedAt: string;
    } })
  | (MutationOperationBase & { type: 'shopping.item.check'; id: string; listId: string; purchaseCycleId: string; checked: boolean })
  | (MutationOperationBase & { type: 'shopping.item.remove'; id: string; listId: string; purchaseCycleId: string; removedAt?: string })
  | (MutationOperationBase & { type: 'shopping.history.import'; listId: string; currentCycleId: string;
      cycles: Array<{ id: string; startedAt: string }>;
      purchases: Array<{ id: string; purchaseCycleId: string; itemIds: string[]; pantryItemIds: string[]; purchasedAt: string }> })
  | (MutationOperationBase & { type: 'shopping.purchase'; purchase: {
      id: string; listId: string; purchaseCycleId: string; itemIds: string[]; pantryItemIds: string[]; purchasedAt: string;
    }; pantryAdds: Array<{ id: string; name: string; preference: number }> })
  | (MutationOperationBase & { type: 'personal.preference.set'; field: string; value: unknown; baseVersion: number | null })
  | (MutationOperationBase & { type: 'personal.allergy.set'; name: string; enabled: boolean; baseVersion: number | null })
  | (MutationOperationBase & { type: 'personal.chat.conversation.create'; conversation: { id: string; title: string; createdAt: string } })
  | (MutationOperationBase & { type: 'personal.chat.message.append'; conversationId: string; message: { id: string; role: 'user' | 'assistant'; content: string; createdAt: string } })
  | (MutationOperationBase & { type: 'personal.chat.proposal.create'; conversationId: string; messageId: string; proposal: { id: string; toolName: string; arguments: string; status: 'pending' | 'applied' } })
  | (MutationOperationBase & { type: 'personal.chat.proposal.setStatus'; conversationId: string; messageId: string; proposalId: string; status: 'applied'; baseVersion: number; effectSpaceId: string; effectMutationId: string; effectOpId: string })
  | (MutationOperationBase & { type: 'personal.chat.conversation.delete'; id: string; baseVersion: number });

export interface ContentMutationRequest {
  mutationId: string;
  operations: ContentMutationOperation[];
}

/*
 * Kept as a named alias so callers can retain the narrower request type in
 * their own module declarations without treating domain IDs as storage IDs.
 */
export type ContentMutationEnvelope = ContentMutationRequest;
