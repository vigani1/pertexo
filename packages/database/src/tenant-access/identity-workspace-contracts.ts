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
  revision: number;
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
  roleRevision: number;
  membershipStatus: 'active' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
}>;
export type ChangeWorkspaceMemberRoleInput = Readonly<{
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: Exclude<MembershipRole, 'owner'>;
  expectedRoleRevision: number;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
export type WorkspaceMemberRoleChangeResult = Readonly<{
  userId: string;
  role: Exclude<MembershipRole, 'owner'>;
  roleRevision: number;
  changed: boolean;
  replayed: boolean;
}>;
export type WorkspaceMembersPage = Readonly<{
  items: readonly WorkspaceMemberRecord[];
  nextCursor?: Readonly<{ createdAt: string; userId: string }>;
}>;
export type DelegatedMembershipRole = Exclude<MembershipRole, 'owner'>;
export type WorkspaceInvitationStatus =
  'pending' | 'accepted' | 'revoked' | 'expired';
export type WorkspaceInvitationDeliveryStatus =
  'queued' | 'submitted' | 'failed' | 'canceled';
export type WorkspaceInvitationRecord = Readonly<{
  id: string;
  workspaceId: string;
  email: string;
  role: DelegatedMembershipRole;
  status: WorkspaceInvitationStatus;
  revision: number;
  deliveryStatus: WorkspaceInvitationDeliveryStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}>;
export type SealedInvitationToken = Readonly<{
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: string;
}>;
type WorkspaceInvitationCommandInput = Readonly<{
  workspaceId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
export type CreateWorkspaceInvitationInput = WorkspaceInvitationCommandInput &
  Readonly<{
    invitationId?: string;
    deliveryAttemptId?: string;
    email: string;
    role: DelegatedMembershipRole;
    tokenDigest: string;
    sealedToken: SealedInvitationToken;
    expiresAt: Date;
  }>;
export type ChangeWorkspaceInvitationInput = WorkspaceInvitationCommandInput &
  Readonly<{
    invitationId: string;
    expectedRevision: number;
    tokenDigest?: string;
    sealedToken?: SealedInvitationToken;
    deliveryAttemptId?: string;
    expiresAt?: Date;
  }>;
export type WorkspaceInvitationCommandResult = Readonly<{
  invitation: WorkspaceInvitationRecord;
  replayed: boolean;
}>;
export type WorkspaceInvitationsPage = Readonly<{
  items: readonly WorkspaceInvitationRecord[];
  nextCursor?: Readonly<{ createdAt: string; invitationId: string }>;
}>;
export type InvitationAcceptanceIntentRecord = Readonly<{
  id: string;
  workspaceId: string;
  invitationId: string;
  invitationRevision: number;
  status:
    | 'pending'
    | 'verified'
    | 'wrong_account'
    | 'completed'
    | 'abandoned'
    | 'superseded';
  expiresAt: Date;
  verifiedUserId: string | null;
  verifiedEmail: string | null;
  verifiedAt: Date | null;
  workspaceName: string | null;
  invitationRole: DelegatedMembershipRole | null;
  invitationStatus: WorkspaceInvitationStatus | null;
  acceptedUserId: string | null;
  receipt: Readonly<{
    intentId: string;
    workspaceId: string;
    role: MembershipRole;
    membershipCreated: boolean;
  }> | null;
}>;
export type ResolveInvitationAcceptanceInput = Readonly<{
  workspaceId: string;
  invitationId: string;
  tokenDigest: string;
  intentId: string;
  bindingDigest: string;
  csrfDigest: string;
  expiresAt: Date;
  priorBinding?: Readonly<{
    workspaceId: string;
    intentId: string;
    bindingDigest: string;
  }>;
}>;
export type CompleteInvitationAcceptanceInput = Readonly<{
  workspaceId: string;
  intentId: string;
  invitationRevision: number;
  actorUserId: string;
  idempotencyKey: string;
  replacementSession: Readonly<{
    id: string;
    tokenDigest: string;
    expiresAt: Date;
    userAgent?: string | null;
    ipAddress?: string | null;
  }>;
  requestId?: string;
  traceId?: string;
}>;
export type InvitationAcceptanceResult = Readonly<{
  intentId: string;
  workspaceId: string;
  role: MembershipRole;
  membershipCreated: boolean;
  replayed: boolean;
  replacementSessionCreated: boolean;
}>;
export type AccessibleWorkspaceRecord = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: Extract<WorkspaceStatus, 'active' | 'suspended' | 'pending_deletion'>;
  revision: number;
  role: MembershipRole;
  createdAt: Date;
  updatedAt: Date;
}>;
export type AccessibleWorkspacesPage = Readonly<{
  items: readonly AccessibleWorkspaceRecord[];
  nextCursor?: string;
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
export type RenameWorkspaceInput = Readonly<{
  workspaceId: string;
  actorUserId: string;
  name: string;
  expectedRevision: number;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
export type WorkspaceRenameResult = Readonly<{
  workspace: WorkspaceRecord;
  changed: boolean;
  replayed: boolean;
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
  changeWorkspaceMemberRole(
    input: ChangeWorkspaceMemberRoleInput,
  ): Promise<WorkspaceMemberRoleChangeResult>;
  listWorkspaceInvitations(
    workspaceId: string,
    actorId: string,
    input?: Readonly<{
      limit?: number;
      after?: Readonly<{ createdAt: string; invitationId: string }>;
    }>,
  ): Promise<WorkspaceInvitationsPage>;
  createWorkspaceInvitation(
    input: CreateWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationCommandResult>;
  resendWorkspaceInvitation(
    input: ChangeWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationCommandResult>;
  revokeWorkspaceInvitation(
    input: ChangeWorkspaceInvitationInput,
  ): Promise<WorkspaceInvitationCommandResult>;
  resolveInvitationAcceptance(
    input: ResolveInvitationAcceptanceInput,
  ): Promise<InvitationAcceptanceIntentRecord | null>;
  readInvitationAcceptance(
    workspaceId: string,
    bindingDigest: string,
  ): Promise<InvitationAcceptanceIntentRecord | null>;
  recordInvitationAcceptanceProof(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      bindingDigest: string;
      userId: string;
      verifiedEmail: string;
      verifiedAt: Date;
    }>,
  ): Promise<InvitationAcceptanceIntentRecord | null>;
  completeInvitationAcceptance(
    input: CompleteInvitationAcceptanceInput,
  ): Promise<InvitationAcceptanceResult>;
  abandonInvitationAcceptance(
    workspaceId: string,
    intentId: string,
    bindingDigest: string,
  ): Promise<boolean>;
  listAccessibleWorkspaces(
    actorId: string,
    input?: Readonly<{ limit?: number; after?: string }>,
  ): Promise<AccessibleWorkspacesPage>;
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
  renameWorkspace(input: RenameWorkspaceInput): Promise<WorkspaceRenameResult>;
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
