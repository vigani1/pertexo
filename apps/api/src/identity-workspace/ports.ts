import type {
  IdentityClock,
  IdentityCrypto,
  OidcLoginTransactionStore,
  OidcProviderPort,
  SessionCookieBoundary,
  SessionRecord as IdentitySessionRecord,
  SessionStorePort,
} from '../identity/index.js';
import type {
  WorkspaceAccessLookup,
  WorkspaceAccessQuery,
} from '../workspaces/index.js';
import type { WorkspaceAccess, WorkspaceId } from '../workspaces/index.js';

export type IdentityWorkspaceConfig = Readonly<{
  oidc: Readonly<{
    issuer: string;
    authorizationEndpoint: string;
    clientId: string;
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
      requestId?: string;
      traceId?: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<WorkspacePersistenceRecord>;
  requestWorkspaceDeletion(
    workspaceId: WorkspaceId,
    actorUserId: string,
    purgeAfter: Date,
    reason: string,
    options?: AuditOptions,
  ): Promise<WorkspaceLifecyclePersistenceResult>;
  restoreWorkspace(
    workspaceId: WorkspaceId,
    actorUserId: string,
    options?: AuditOptions,
  ): Promise<WorkspaceLifecyclePersistenceResult>;
}

export type WorkspacePersistenceRecord = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'pending_deletion' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}>;

export type WorkspaceLifecyclePersistenceResult = Readonly<{
  workspace: WorkspacePersistenceRecord;
  revokedSessionCount: number;
}>;

export type AuditOptions = Readonly<{
  requestId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}>;

export interface WorkspaceAuthorizationReader {
  findAccess(query: WorkspaceAccessQuery): Promise<WorkspaceAccess | undefined>;
}

export type WorkspaceAuthorizationSource =
  WorkspaceAuthorizationReader | WorkspaceAccessLookup;

export type IdentityWorkspaceDependencies = Readonly<{
  config: IdentityWorkspaceConfig;
  provider: OidcProviderPort;
  transactions: OidcLoginTransactionStore;
  persistence: IdentityWorkspacePersistence;
  authorization: WorkspaceAuthorizationSource;
  crypto?: IdentityCrypto;
  clock?: IdentityClock;
}>;

export type SessionCookieWriter = SessionCookieBoundary;

export type SessionCookiePolicy = Readonly<{
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}>;

export type { IdentityClock, IdentityCrypto, IdentitySessionRecord };
