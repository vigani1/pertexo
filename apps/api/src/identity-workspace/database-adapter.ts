import type {
  IdentityWorkspaceDatabase,
  SessionRecord as DatabaseSessionRecord,
} from '@pertexo/database';

import type { SessionRecord, SessionStorePort } from '../identity/index.js';
import type {
  IdentityWorkspacePersistence,
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

  public async createWorkspaceWithOwner(
    input: Parameters<IdentityWorkspaceDatabase['createWorkspaceWithOwner']>[0],
  ) {
    const result = await this.database.createWorkspaceWithOwner(input);
    return mapWorkspace(result);
  }

  public async findAccess(query: {
    actorId: string;
    workspaceId: string;
  }): Promise<WorkspaceAccess | undefined> {
    const result = await this.database.findWorkspaceAccess(
      query.actorId,
      query.workspaceId,
    );
    return result ?? undefined;
  }

  public async requestWorkspaceDeletion(
    ...input: Parameters<IdentityWorkspaceDatabase['requestWorkspaceDeletion']>
  ) {
    const result = await this.database.requestWorkspaceDeletion(...input);
    return Object.freeze({
      workspace: mapWorkspace(result.workspace),
      revokedSessionCount: result.revokedSessionCount,
    });
  }

  public async restoreWorkspace(
    ...input: Parameters<IdentityWorkspaceDatabase['restoreWorkspace']>
  ) {
    const result = await this.database.restoreWorkspace(...input);
    return Object.freeze({
      workspace: mapWorkspace(result.workspace),
      revokedSessionCount: result.revokedSessionCount,
    });
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
  ): Promise<SessionRecord | undefined> {
    const record = await this.database.findActiveSessionByDigest(tokenDigest);
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

export function asSessionStore(
  adapter: DatabaseIdentityWorkspaceAdapter,
): SessionStorePort {
  return adapter;
}
