export type SpaceKind = 'personal' | 'household';
export type SpaceRole = 'owner' | 'editor' | 'viewer';

export interface ApiUser {
  id: string;
  email: string;
}

export interface ApiSpace {
  id: string;
  name: string;
  kind: SpaceKind;
  role: SpaceRole;
  createdAt: string;
}

export interface AuthResponse {
  user: ApiUser;
  session: { token: string; expiresAt: string };
  spaces: ApiSpace[];
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface SpaceInvitation {
  id: string;
  email: string;
  role: Exclude<SpaceRole, 'owner'>;
  expiresAt: string;
  createdAt: string;
}

export interface SpaceMember {
  user: ApiUser;
  role: SpaceRole;
  joinedAt: string;
}
