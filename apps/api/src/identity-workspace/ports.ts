import type {
  IdentityClock,
  IdentityCrypto,
  OidcLoginTransactionStore,
  OidcProviderPort,
  SessionStorePort,
} from '../identity/index.js';
import type {
  WorkspaceAccessQuery,
  WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type { WorkspaceAccess, WorkspaceId } from '../workspaces/index.js';
import type { IdentityWorkspaceTelemetry } from './telemetry.js';

export type IdentityWorkspaceConfig = Readonly<{
  publicWebOrigin?: string;
  oidc: Readonly<{
    issuer: string;
    authorizationEndpoint: string;
    clientId: string;
    callbackLandingPath?: string;
    redirectUri: string;
    scopes: readonly string[];
    transactionTtlMillis: number;
  }>;
  session?: Readonly<{
    ttlMillis?: number;
    secureCookie?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
  }>;
}>;

export interface IdentityWorkspacePersistence extends SessionStorePort {
  findUserById(userId: string): Promise<UserProfilePersistenceRecord | null>;
  resolveOrCreateIdentity(
    input: Readonly<{
      issuer: string;
      providerSubject: string;
      email: string;
      displayName: string;
      profileMetadata?: Record<string, unknown>;
    }>,
  ): Promise<Readonly<{ userId: string; authenticationIdentityId?: string }>>;
  createWorkspaceWithOwner(
    input: Readonly<{
      name: string;
      slug: string;
      ownerUserId: string;
      idempotencyKey: string;
      requestId?: string;
      traceId?: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<WorkspacePersistenceRecord>;
  renameWorkspace?(
    input: Readonly<{
      workspaceId: string;
      actorUserId: string;
      name: string;
      expectedRevision: number;
      idempotencyKey: string;
      requestId?: string;
      traceId?: string;
    }>,
  ): Promise<WorkspaceRenamePersistenceResult>;
  listWorkspaceMembers(
    workspaceId: string,
    actorId: string,
    input?: Readonly<{
      limit?: number;
      after?: Readonly<{ createdAt: string; userId: string }>;
    }>,
  ): Promise<
    Readonly<{
      items: readonly WorkspaceMemberPersistenceRecord[];
      nextCursor?: Readonly<{ createdAt: string; userId: string }>;
    }>
  >;
  changeWorkspaceMemberRole(
    input: Readonly<{
      workspaceId: string;
      actorUserId: string;
      targetUserId: string;
      role: 'admin' | 'builder' | 'operator' | 'viewer';
      expectedRoleRevision: number;
      idempotencyKey: string;
      requestId?: string;
      traceId?: string;
    }>,
  ): Promise<
    Readonly<{
      userId: string;
      role: 'admin' | 'builder' | 'operator' | 'viewer';
      roleRevision: number;
      changed: boolean;
      replayed: boolean;
    }>
  >;
  listWorkspaceInvitations?(
    workspaceId: string,
    actorId: string,
    input?: Readonly<{
      limit?: number;
      after?: Readonly<{ createdAt: string; invitationId: string }>;
    }>,
  ): Promise<WorkspaceInvitationsPersistencePage>;
  createWorkspaceInvitation?(
    input: WorkspaceInvitationCreatePersistenceInput,
  ): Promise<WorkspaceInvitationCommandPersistenceResult>;
  resendWorkspaceInvitation?(
    input: WorkspaceInvitationChangePersistenceInput,
  ): Promise<WorkspaceInvitationCommandPersistenceResult>;
  revokeWorkspaceInvitation?(
    input: WorkspaceInvitationChangePersistenceInput,
  ): Promise<WorkspaceInvitationCommandPersistenceResult>;
  resolveInvitationAcceptance?(
    input: InvitationAcceptanceResolvePersistenceInput,
  ): Promise<InvitationAcceptanceIntentPersistenceRecord | null>;
  readInvitationAcceptance?(
    workspaceId: string,
    bindingDigest: string,
  ): Promise<InvitationAcceptanceIntentPersistenceRecord | null>;
  recordInvitationAcceptanceProof?(
    input: Readonly<{
      workspaceId: string;
      intentId: string;
      bindingDigest: string;
      userId: string;
      verifiedEmail: string;
      verifiedAt: Date;
    }>,
  ): Promise<InvitationAcceptanceIntentPersistenceRecord | null>;
  completeInvitationAcceptance?(
    input: InvitationAcceptanceCompletePersistenceInput,
  ): Promise<InvitationAcceptancePersistenceResult>;
  abandonInvitationAcceptance?(
    workspaceId: string,
    intentId: string,
    bindingDigest: string,
  ): Promise<boolean>;
  listAccessibleWorkspaces(
    actorId: string,
    input?: Readonly<{ limit?: number; after?: string }>,
  ): Promise<
    Readonly<{
      items: readonly AccessibleWorkspacePersistenceRecord[];
      nextCursor?: string;
    }>
  >;
  requestWorkspaceLifecycleOperation(input: {
    workspaceId: WorkspaceId;
    actorUserId: string;
    commandType: WorkspaceLifecycleOperationRecord['commandType'];
    reason: string;
    idempotencyKey: string;
  }): Promise<WorkspaceLifecycleOperationRecord>;
  readWorkspaceLifecycleOperation(
    workspaceId: WorkspaceId,
    operationId: string,
    actorUserId: string,
  ): Promise<WorkspaceLifecycleOperationRecord | null>;
}

export type WorkspaceInvitationPersistenceRecord = Readonly<{
  id: string;
  workspaceId: string;
  email: string;
  role: 'admin' | 'builder' | 'operator' | 'viewer';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  revision: number;
  deliveryStatus: 'queued' | 'submitted' | 'failed' | 'canceled';
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}>;
export type WorkspaceInvitationsPersistencePage = Readonly<{
  items: readonly WorkspaceInvitationPersistenceRecord[];
  nextCursor?: Readonly<{ createdAt: string; invitationId: string }>;
}>;
export type SealedInvitationToken = Readonly<{
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: string;
}>;
type WorkspaceInvitationCommandPersistenceBase = Readonly<{
  workspaceId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;
export type WorkspaceInvitationCreatePersistenceInput =
  WorkspaceInvitationCommandPersistenceBase &
    Readonly<{
      invitationId: string;
      deliveryAttemptId: string;
      email: string;
      role: 'admin' | 'builder' | 'operator' | 'viewer';
      tokenDigest: string;
      sealedToken: SealedInvitationToken;
      expiresAt: Date;
    }>;
export type WorkspaceInvitationChangePersistenceInput =
  WorkspaceInvitationCommandPersistenceBase &
    Readonly<{
      invitationId: string;
      expectedRevision: number;
      tokenDigest?: string;
      sealedToken?: SealedInvitationToken;
      deliveryAttemptId?: string;
      expiresAt?: Date;
    }>;
export type WorkspaceInvitationCommandPersistenceResult = Readonly<{
  invitation: WorkspaceInvitationPersistenceRecord;
  replayed: boolean;
}>;
export type InvitationAcceptanceIntentPersistenceRecord = Readonly<{
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
  invitationRole: 'admin' | 'builder' | 'operator' | 'viewer' | null;
  invitationStatus: 'pending' | 'accepted' | 'revoked' | 'expired' | null;
  acceptedUserId: string | null;
  receipt: Readonly<{
    intentId: string;
    workspaceId: string;
    role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';
    membershipCreated: boolean;
  }> | null;
}>;
export type InvitationAcceptanceResolvePersistenceInput = Readonly<{
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
export type InvitationAcceptanceCompletePersistenceInput = Readonly<{
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
export type InvitationAcceptancePersistenceResult = Readonly<{
  intentId: string;
  workspaceId: string;
  role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';
  membershipCreated: boolean;
  replayed: boolean;
  replacementSessionCreated: boolean;
}>;

export interface InvitationTokenProtector {
  seal(
    plaintext: string,
    associatedData: string,
  ): Promise<SealedInvitationToken> | SealedInvitationToken;
}

export type UserProfilePersistenceRecord = Readonly<{
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}>;

export type WorkspaceMemberPersistenceRecord = Readonly<{
  userId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';
  roleRevision: number;
  membershipStatus: 'active' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
}>;

export type AccessibleWorkspacePersistenceRecord = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'pending_deletion';
  revision: number;
  role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';
  createdAt: Date;
  updatedAt: Date;
}>;

export type WorkspacePersistenceRecord = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted';
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}>;
export type WorkspaceRenamePersistenceResult = Readonly<{
  workspace: WorkspacePersistenceRecord;
  changed: boolean;
  replayed: boolean;
}>;

export type WorkspaceLifecycleOperationRecord = Readonly<{
  id: string;
  workspaceId: string;
  commandType: 'deletion_requested' | 'deletion_restored';
  status: 'pending' | 'running' | 'completed' | 'failed';
  submittedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
}>;

export interface WorkspaceAuthorizationReader {
  findAccess(query: WorkspaceAccessQuery): Promise<WorkspaceAccess | undefined>;
}

export type IdentityWorkspaceDependencies = Readonly<{
  config: IdentityWorkspaceConfig;
  provider: OidcProviderPort;
  transactions: OidcLoginTransactionStore;
  persistence: IdentityWorkspacePersistence;
  authorization: WorkspaceAuthorizationSource;
  crypto?: IdentityCrypto;
  clock?: IdentityClock;
  telemetry?: IdentityWorkspaceTelemetry;
  invitationTokens?: InvitationTokenProtector;
}>;

export type { WorkspaceAuthorizationSource } from '../workspaces/index.js';

export type SessionCookiePolicy = Readonly<{
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}>;
