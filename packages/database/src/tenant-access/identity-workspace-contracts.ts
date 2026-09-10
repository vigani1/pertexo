export const USER_STATUS = {
  active: 'active',
  suspended: 'suspended',
  deleted: 'deleted',
} as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export const WORKSPACE_STATUS = {
  active: 'active',
  suspended: 'suspended',
  pendingDeletion: 'pending_deletion',
  purging: 'purging',
  deleted: 'deleted',
} as const;
export type WorkspaceStatus =
  (typeof WORKSPACE_STATUS)[keyof typeof WORKSPACE_STATUS];

export const MEMBERSHIP_ROLE = {
  owner: 'owner',
  admin: 'admin',
  builder: 'builder',
  operator: 'operator',
  viewer: 'viewer',
} as const;
export type MembershipRole =
  (typeof MEMBERSHIP_ROLE)[keyof typeof MEMBERSHIP_ROLE];

export type UserRecord = Readonly<{
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}>;
export type AuthIdentityRecord = Readonly<{
  id: string;
  userId: string;
  issuer: string;
  providerSubject: string;
  profileMetadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}>;
export type SessionRecord = Readonly<{
  id: string;
  userId: string;
  tokenDigest: string;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
}>;
export type WorkspaceRecord = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdBy: string;
  deletionRequestedAt: Date | null;
  deletionRequestedBy: string | null;
  deletionReason: string | null;
  purgeAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;
export type CreateUserInput = Readonly<{
  id?: string;
  email: string;
  displayName: string;
}>;
export type CreateAuthIdentityInput = Readonly<{
  id?: string;
  userId: string;
  issuer: string;
  providerSubject: string;
  profileMetadata?: Record<string, unknown>;
}>;
export type ResolveOrCreateIdentityInput = Readonly<{
  issuer: string;
  providerSubject: string;
  email: string;
  displayName: string;
  profileMetadata?: Record<string, unknown>;
}>;
export type ResolvedIdentity = Readonly<{
  user: UserRecord;
  identity: AuthIdentityRecord;
}>;
export type WorkspaceAccessRecord = Readonly<{
  actorId: string;
  workspaceId: string;
  role: MembershipRole;
  membershipStatus: 'active' | 'suspended' | 'removed';
  workspaceStatus: WorkspaceStatus;
}>;
export type WorkspaceMemberRecord = Readonly<{
  userId: string;
  email: string;
  displayName: string;
  role: MembershipRole;
  membershipStatus: 'active' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
}>;
export type WorkspaceMembersPage = Readonly<{
  items: readonly WorkspaceMemberRecord[];
  nextCursor?: Readonly<{ createdAt: string; userId: string }>;
}>;
export type CreateSessionInput = Readonly<{
  id?: string;
  userId: string;
  tokenDigest: string;
  expiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}>;
export type WorkspaceWithOwnerInput = Readonly<{
  id?: string;
  name: string;
  slug: string;
  ownerUserId: string;
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}>;
export type WorkspaceCreationResult = Readonly<{
  workspace: WorkspaceRecord;
  revokedSessionCount: number;
}>;
export type WorkspaceLifecycleOperation = Readonly<{
  id: string;
  workspaceId: string;
  commandType: 'deletion_requested' | 'deletion_restored';
  status: 'pending' | 'running' | 'completed' | 'failed';
  submittedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
}>;
export type RequestWorkspaceLifecycleOperationInput = Readonly<{
  workspaceId: string;
  actorUserId: string;
  commandType: WorkspaceLifecycleOperation['commandType'];
  reason: string;
  idempotencyKey: string;
}>;

export type IdentityWorkspaceDatabase = Readonly<{
  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserById(userId: string): Promise<UserRecord | null>;
  linkAuthIdentity(input: CreateAuthIdentityInput): Promise<AuthIdentityRecord>;
  resolveOrCreateIdentity(
    input: ResolveOrCreateIdentityInput,
  ): Promise<ResolvedIdentity>;
  findWorkspaceAccess(
    actorId: string,
    workspaceId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<WorkspaceAccessRecord | null>;
  listWorkspaceMembers(
    workspaceId: string,
    actorId: string,
    input?: Readonly<{
      limit?: number;
      after?: Readonly<{ createdAt: string; userId: string }>;
    }>,
  ): Promise<WorkspaceMembersPage>;
  findAuthIdentity(
    issuer: string,
    providerSubject: string,
  ): Promise<AuthIdentityRecord | null>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  findActiveSessionByDigest(
    tokenDigest: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<boolean>;
  revokeSessionByDigest(tokenDigest: string): Promise<boolean>;
  createWorkspaceWithOwner(
    input: WorkspaceWithOwnerInput,
  ): Promise<WorkspaceRecord>;
  requestWorkspaceLifecycleOperation(
    input: RequestWorkspaceLifecycleOperationInput,
  ): Promise<WorkspaceLifecycleOperation>;
  readWorkspaceLifecycleOperation(
    workspaceId: string,
    operationId: string,
    actorUserId: string,
  ): Promise<WorkspaceLifecycleOperation | null>;
  close(): Promise<void>;
}>;
