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
      idempotencyKey: string;
      requestId?: string;
      traceId?: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<WorkspacePersistenceRecord>;
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

type SessionCookieWriter = SessionCookieBoundary;

export type { WorkspaceAuthorizationSource } from '../workspaces/index.js';

export type SessionCookiePolicy = Readonly<{
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}>;
