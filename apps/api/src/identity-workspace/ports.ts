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
  role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';
  createdAt: Date;
  updatedAt: Date;
}>;

export type WorkspacePersistenceRecord = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
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
}>;

export type { WorkspaceAuthorizationSource } from '../workspaces/index.js';

export type SessionCookiePolicy = Readonly<{
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}>;
