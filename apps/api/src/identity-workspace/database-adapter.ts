import type {
  IdentityWorkspaceDatabase,
  SessionRecord as DatabaseSessionRecord,
} from '@pertexo/database/api';

import type { SessionRecord } from '../identity/index.js';
import type {
  IdentityWorkspacePersistence,
  InvitationAcceptanceIntentPersistenceRecord,
  InvitationAcceptancePersistenceResult,
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
    return user === null ? null : mapUserProfile(user);
  }

  public async updateUserProfile(
    input: Parameters<IdentityWorkspaceDatabase['updateUserProfile']>[0],
  ) {
    const result = await this.database.updateUserProfile(input);
    return Object.freeze({ ...result, user: mapUserProfile(result.user) });
  }

  public async createWorkspaceWithOwner(
    input: Parameters<IdentityWorkspaceDatabase['createWorkspaceWithOwner']>[0],
  ) {
    const result = await this.database.createWorkspaceWithOwner(input);
    return mapWorkspace(result);
  }

  public async renameWorkspace(
    input: Parameters<IdentityWorkspaceDatabase['renameWorkspace']>[0],
  ) {
    const result = await this.database.renameWorkspace(input);
    return Object.freeze({
      ...result,
      workspace: mapWorkspace(result.workspace),
    });
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

  public changeWorkspaceMemberRole(
    input: Parameters<
      IdentityWorkspaceDatabase['changeWorkspaceMemberRole']
    >[0],
  ) {
    return this.database.changeWorkspaceMemberRole(input);
  }

  public removeWorkspaceMember(
    input: Parameters<IdentityWorkspaceDatabase['removeWorkspaceMember']>[0],
  ) {
    return this.database.removeWorkspaceMember(input);
  }

  public listWorkspaceInvitations(
    ...input: Parameters<IdentityWorkspaceDatabase['listWorkspaceInvitations']>
  ) {
    return this.database.listWorkspaceInvitations(...input);
  }

  public createWorkspaceInvitation(
    input: Parameters<
      IdentityWorkspaceDatabase['createWorkspaceInvitation']
    >[0],
  ) {
    return this.database.createWorkspaceInvitation(input);
  }

  public resendWorkspaceInvitation(
    input: Parameters<
      IdentityWorkspaceDatabase['resendWorkspaceInvitation']
    >[0],
  ) {
    return this.database.resendWorkspaceInvitation(input);
  }

  public revokeWorkspaceInvitation(
    input: Parameters<
      IdentityWorkspaceDatabase['revokeWorkspaceInvitation']
    >[0],
  ) {
    return this.database.revokeWorkspaceInvitation(input);
  }

  public resolveInvitationAcceptance(
    input: Parameters<
      IdentityWorkspaceDatabase['resolveInvitationAcceptance']
    >[0],
  ): Promise<InvitationAcceptanceIntentPersistenceRecord | null> {
    return this.database.resolveInvitationAcceptance(input);
  }

  public readInvitationAcceptance(
    ...input: Parameters<IdentityWorkspaceDatabase['readInvitationAcceptance']>
  ): Promise<InvitationAcceptanceIntentPersistenceRecord | null> {
    return this.database.readInvitationAcceptance(...input);
  }

  public recordInvitationAcceptanceProof(
    input: Parameters<
      IdentityWorkspaceDatabase['recordInvitationAcceptanceProof']
    >[0],
  ): Promise<InvitationAcceptanceIntentPersistenceRecord | null> {
    return this.database.recordInvitationAcceptanceProof(input);
  }

  public completeInvitationAcceptance(
    input: Parameters<
      IdentityWorkspaceDatabase['completeInvitationAcceptance']
    >[0],
  ): Promise<InvitationAcceptancePersistenceResult> {
    return this.database.completeInvitationAcceptance(input);
  }

  public abandonInvitationAcceptance(
    ...input: Parameters<
      IdentityWorkspaceDatabase['abandonInvitationAcceptance']
    >
  ) {
    return this.database.abandonInvitationAcceptance(...input);
  }

  public listAccessibleWorkspaces(
    actorId: string,
    input?: Readonly<{ limit?: number; after?: string }>,
  ) {
    return this.database.listAccessibleWorkspaces(actorId, input);
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

function mapUserProfile(
  user: UserProfilePersistenceRecord,
): UserProfilePersistenceRecord {
  return Object.freeze({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    profileRevision: user.profileRevision,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
}

function mapWorkspace(
  record: Readonly<{
    id: string;
    name: string;
    slug: string;
    status: 'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted';
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  }>,
): Readonly<{
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted';
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}> {
  return Object.freeze({
    id: record.id,
    name: record.name,
    slug: record.slug,
    status: record.status,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
