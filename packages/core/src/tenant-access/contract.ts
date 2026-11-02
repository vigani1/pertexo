import type { DirectoryMembershipSource } from '@pertexo/contracts';
import type { DelegatedRole, Role } from '@pertexo/workflow-model';
import type { WorkspaceLifecycleOperation } from '../lifecycle/deletion/contract.js';
import type {
  users,
  workspaceInvitations,
  workspaces,
} from '@pertexo/database/schema';
import type { USER_STATUS, WORKSPACE_STATUS } from './state.js';
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];
export type WorkspaceStatus =
  (typeof WORKSPACE_STATUS)[keyof typeof WORKSPACE_STATUS];

export type UserRecord = Readonly<
  Pick<
    typeof users.$inferSelect,
    | 'id'
    | 'email'
    | 'displayName'
    | 'status'
    | 'profileRevision'
    | 'createdAt'
    | 'updatedAt'
  >
>;
export type UpdateUserProfileInput = Readonly<{
  actorUserId: string;
  displayName: string;
  expectedRevision: number;
  idempotencyKey: string;
}>;
export type UserProfileUpdateResult = Readonly<{
  user: UserRecord;
  changed: boolean;
  replayed: boolean;
}>;
export type WorkspaceRecord = Readonly<
  Pick<
    typeof workspaces.$inferSelect,
    | 'id'
    | 'name'
    | 'slug'
    | 'status'
    | 'revision'
    | 'deletionRequestedAt'
    | 'deletionRequestedBy'
    | 'deletionReason'
    | 'purgeAfter'
    | 'createdAt'
    | 'updatedAt'
  > & { createdBy: NonNullable<typeof workspaces.$inferSelect.createdBy> }
>;
export type CreateUserInput = Readonly<{
  id?: string;
  email: string;
  displayName: string;
}>;
// Actor membership joined to the current workspace status.
export type WorkspaceAccessRecord = Readonly<{
  actorId: string;
  workspaceId: string;
  role: Role;
  membershipStatus: 'active' | 'suspended' | 'removed';
  workspaceStatus: WorkspaceStatus;
}>;
// Membership joined to the user profile and optional directory provenance.
export type WorkspaceMemberRecord = Readonly<{
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  roleRevision: number;
  membershipStatus: 'active' | 'suspended';
  directorySource?: DirectoryMembershipSource;
  createdAt: Date;
  updatedAt: Date;
}>;
export type ChangeWorkspaceMemberRoleInput = Readonly<{
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  role: Exclude<Role, 'owner'>;
  expectedRoleRevision: number;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
export type WorkspaceMemberRoleChangeResult = Readonly<{
  userId: string;
  role: Exclude<Role, 'owner'>;
  roleRevision: number;
  changed: boolean;
  replayed: boolean;
}>;
export type RemoveWorkspaceMemberInput = Omit<
  ChangeWorkspaceMemberRoleInput,
  'role'
>;
export type WorkspaceMemberRemovalResult = Readonly<{
  userId: string;
  roleRevision: number;
  replayed: boolean;
}>;
/** ADR 047: leaving names only the actor; the owner check runs under lock. */
export type LeaveWorkspaceInput = Omit<
  RemoveWorkspaceMemberInput,
  'targetUserId' | 'expectedRoleRevision'
>;
export type WorkspaceMemberStatusCommandInput = RemoveWorkspaceMemberInput;
export type WorkspaceMemberStatusResult = Readonly<{
  userId: string;
  roleRevision: number;
  membershipStatus: 'active' | 'suspended';
  replayed: boolean;
}>;
export type TransferWorkspaceOwnershipInput = RemoveWorkspaceMemberInput &
  Readonly<{ expectedOwnerRoleRevision: number }>;
export type WorkspaceOwnershipTransferResult = Readonly<{
  ownerUserId: string;
  ownerRoleRevision: number;
  previousOwnerUserId: string;
  previousOwnerRoleRevision: number;
  replayed: boolean;
}>;
export type WorkspaceMembersPage = Readonly<{
  items: readonly WorkspaceMemberRecord[];
  nextCursor?: WorkspaceMembersPosition;
}>;
export type WorkspaceInvitationStatus =
  'pending' | 'accepted' | 'revoked' | 'expired';
export type WorkspaceInvitationRecord = Readonly<
  Pick<
    typeof workspaceInvitations.$inferSelect,
    | 'id'
    | 'workspaceId'
    | 'role'
    | 'status'
    | 'revision'
    | 'deliveryStatus'
    | 'expiresAt'
    | 'createdAt'
    | 'updatedAt'
  > & { email: typeof workspaceInvitations.$inferSelect.recipientEmail }
>;
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
    role: DelegatedRole;
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
  nextCursor?: WorkspaceInvitationsPosition;
}>;
// Intent joined to workspace, invitation and recipient receipt data.
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
  verifiedSessionId: string | null;
  verifiedEmail: string | null;
  verifiedAt: Date | null;
  workspaceName: string | null;
  invitationRole: DelegatedRole | null;
  invitationStatus: WorkspaceInvitationStatus | null;
  acceptedUserId: string | null;
  receipt: Readonly<{
    intentId: string;
    workspaceId: string;
    role: Role;
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
/** The Better Auth session that replaces every session of a user. */
export type ReplacementSessionInput = Readonly<{
  id: string;
  token: string;
  expiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}>;
export type CompleteInvitationAcceptanceInput = Readonly<{
  workspaceId: string;
  intentId: string;
  invitationRevision: number;
  actorUserId: string;
  idempotencyKey: string;
  replacementSession: ReplacementSessionInput;
  requestId?: string;
  traceId?: string;
}>;
export type InvitationAcceptanceResult = Readonly<{
  intentId: string;
  workspaceId: string;
  role: Role;
  membershipCreated: boolean;
  replayed: boolean;
  replacementSessionCreated: boolean;
}>;
// Workspace joined to the actor membership, narrowed to discoverable statuses.
export type AccessibleWorkspaceRecord = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: Extract<WorkspaceStatus, 'active' | 'suspended' | 'pending_deletion'>;
  revision: number;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}>;
export type AccessibleWorkspacesPage = Readonly<{
  items: readonly AccessibleWorkspaceRecord[];
  nextCursor?: string;
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
export type { WorkspaceLifecycleOperation } from '../lifecycle/deletion/contract.js';
export type RequestWorkspaceLifecycleOperationInput = Readonly<{
  workspaceId: string;
  actorUserId: string;
  commandType: WorkspaceLifecycleOperation['commandType'];
  reason: string;
  idempotencyKey: string;
}>;

export type WorkspaceMembersPosition = Readonly<{
  createdAt: string;
  userId: string;
}>;
export type ListWorkspaceMembersInput = Readonly<{
  limit?: number;
  after?: WorkspaceMembersPosition;
}>;
export type WorkspaceInvitationsPosition = Readonly<{
  createdAt: string;
  invitationId: string;
}>;
export type ListWorkspaceInvitationsInput = Readonly<{
  limit?: number;
  after?: WorkspaceInvitationsPosition;
}>;
export type ListAccessibleWorkspacesInput = Readonly<{
  limit?: number;
  after?: string;
}>;
export type FindWorkspaceAccessOptions = Readonly<{ signal?: AbortSignal }>;
export type RecordInvitationAcceptanceProofInput = Readonly<{
  workspaceId: string;
  intentId: string;
  bindingDigest: string;
  userId: string;
  sessionId: string;
  verifiedEmail: string;
  verifiedAt: Date;
}>;
