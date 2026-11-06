import type { WorkspaceLifecycleStore } from '@pertexo/core/lifecycle';
import type { IdentityWorkspaceStore } from '@pertexo/core/tenant-access';
import type {
  IdentityWorkspacePersistence,
  UserProfilePersistenceRecord,
  WorkspaceAuthorizationReader,
} from '../ports.js';

/** Keep internal profile/workspace fields and absent access behind the application boundary. */
export function createIdentityWorkspaceAdapter(
  database: IdentityWorkspaceStore,
  lifecycle: Pick<
    WorkspaceLifecycleStore,
    'requestWorkspaceLifecycleOperation'
  >,
): IdentityWorkspacePersistence & WorkspaceAuthorizationReader {
  return Object.freeze({
    ...database,
    requestWorkspaceLifecycleOperation:
      lifecycle.requestWorkspaceLifecycleOperation,
    async findUserById(userId: string) {
      const user = await database.findUserById(userId);
      return user === null ? null : mapUserProfile(user);
    },
    async updateUserProfile(
      input: Parameters<IdentityWorkspaceStore['updateUserProfile']>[0],
    ) {
      const result = await database.updateUserProfile(input);
      return Object.freeze({ ...result, user: mapUserProfile(result.user) });
    },
    async createWorkspaceWithOwner(
      input: Parameters<IdentityWorkspaceStore['createWorkspaceWithOwner']>[0],
    ) {
      return mapWorkspace(await database.createWorkspaceWithOwner(input));
    },
    async renameWorkspace(
      input: Parameters<IdentityWorkspaceStore['renameWorkspace']>[0],
    ) {
      const result = await database.renameWorkspace(input);
      return Object.freeze({
        ...result,
        workspace: mapWorkspace(result.workspace),
      });
    },
    async findAccess(
      query: Parameters<WorkspaceAuthorizationReader['findAccess']>[0],
    ) {
      const result = await database.findWorkspaceAccess(
        query.actorId,
        query.workspaceId,
        query.signal === undefined ? {} : { signal: query.signal },
      );
      return result ?? undefined;
    },
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
