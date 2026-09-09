import type {
  IdentityWorkspaceDatabase,
  SessionRecord as DatabaseSessionRecord,
} from '@pertexo/database/api';

import type { SessionRecord } from '../identity/index.js';
import type {
  IdentityWorkspacePersistence,
  UserProfilePersistenceRecord,
  WorkspaceMemberPersistenceRecord,
  WorkspaceAuthorizationReader,
} from './ports.js';
import type { WorkspaceAccess } from '../workspaces/index.js';

/** Structural adapter keeping database-specific records out of application use cases. */
export class DatabaseIdentityWorkspaceAdapter
  implements IdentityWorkspacePersistence, WorkspaceAuthorizationReader
{
  public constructor(private readonly database: IdentityWorkspaceDatabase) {}

  public async resolveOrCreateIdentity(
    input: Parameters<IdentityWorkspaceDatabase['resolveOrCreateIdentity']>[0],
  ) {
    const result = await this.database.resolveOrCreateIdentity(input);
    return Object.freeze({
      userId: result.user.id,
      authenticationIdentityId: result.identity.id,
    });
  }

  public async findUserById(
    userId: string,
  ): Promise<UserProfilePersistenceRecord | null> {
    const user = await this.database.findUserById(userId);
    return user === null
      ? null
      : Object.freeze({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          status: user.status,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        });
  }

  public async createWorkspaceWithOwner(
    input: Parameters<IdentityWorkspaceDatabase['createWorkspaceWithOwner']>[0],
  ) {
    const result = await this.database.createWorkspaceWithOwner(input);
    return mapWorkspace(result);
  }

  public async findAccess(query: {
    actorId: string;
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<WorkspaceAccess | undefined> {
    const result = await this.database.findWorkspaceAccess(
      query.actorId,
      query.workspaceId,
      query.signal === undefined ? {} : { signal: query.signal },
    );
    return result ?? undefined;
  }

  public async listWorkspaceMembers(
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
  > {
    return this.database.listWorkspaceMembers(workspaceId, actorId, input);
  }

  public requestWorkspaceLifecycleOperation(
    ...input: Parameters<
      IdentityWorkspaceDatabase['requestWorkspaceLifecycleOperation']
    >
  ) {
    return this.database.requestWorkspaceLifecycleOperation(...input);
  }

  public readWorkspaceLifecycleOperation(
    ...input: Parameters<
      IdentityWorkspaceDatabase['readWorkspaceLifecycleOperation']
    >
  ) {
    return this.database.readWorkspaceLifecycleOperation(...input);
  }

  public async create(record: SessionRecord): Promise<void> {
    await this.database.createSession({
      id: record.sessionId,
      userId: record.userId,
      tokenDigest: record.tokenDigest,
      expiresAt: record.expiresAt,
      userAgent: record.clientMetadata.userAgent ?? null,
      ipAddress: record.clientMetadata.ipAddress ?? null,
    });
  }

  public async findByDigest(
    tokenDigest: string,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<SessionRecord | undefined> {
    const record = await this.database.findActiveSessionByDigest(
      tokenDigest,
      options,
    );
    return record === null ? undefined : mapSession(record);
  }

  public async revokeByDigest(
    tokenDigest: string,
    revokedAt: Date,
  ): Promise<boolean> {
    void revokedAt;
    return this.database.revokeSessionByDigest(tokenDigest);
  }
}

function mapSession(record: DatabaseSessionRecord): SessionRecord {
  return Object.freeze({
    sessionId: record.id,
    tokenDigest: record.tokenDigest,
    userId: record.userId,
    expiresAt: record.expiresAt,
    ...(record.revokedAt === null ? {} : { revokedAt: record.revokedAt }),
    clientMetadata: Object.freeze({
      ...(record.userAgent === null ? {} : { userAgent: record.userAgent }),
      ...(record.ipAddress === null ? {} : { ipAddress: record.ipAddress }),
    }),
  });
}

function mapWorkspace(
  record: Readonly<{
    id: string;
    name: string;
    slug: string;
    status: 'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted';
    createdAt: Date;
    updatedAt: Date;
  }>,
): Readonly<{
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}> {
  return Object.freeze({
    id: record.id,
    name: record.name,
    slug: record.slug,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
