import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { FOLDER_LIMIT } from './folder-policy.js';
import {
  databaseSchema,
  workflowFolders,
  workflowFolderGrants,
  authOrganizationWorkspaces,
  authDirectoryUsers,
  authDirectoryGroupMembers,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  type WorkspaceId,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type Role,
} from '@pertexo/workflow-model';
import { readWorkspaceRole } from './authority.queries.js';
import type { ResourceActor, ResourceTransaction } from './contract.js';
import { folderScope, RESOURCE_ADMINISTRATORS } from './folder-policy.js';

function matchingGrants(db: WorkspaceTransaction['db'], actor: ResourceActor) {
  const selection = {
    folderId: workflowFolderGrants.folderId,
    access: workflowFolderGrants.access,
  };
  const direct = db
    .select(selection)
    .from(workflowFolderGrants)
    .where(
      and(
        eq(workflowFolderGrants.workspaceId, actor.workspaceId),
        eq(workflowFolderGrants.userId, actor.actorId),
      ),
    );
  const groups = db
    .select(selection)
    .from(authOrganizationWorkspaces)
    .innerJoin(
      authDirectoryUsers,
      and(
        eq(
          authDirectoryUsers.organizationId,
          authOrganizationWorkspaces.organizationId,
        ),
        eq(authDirectoryUsers.userId, actor.actorId),
        eq(authDirectoryUsers.active, true),
        isNull(authDirectoryUsers.deletedAt),
      ),
    )
    .innerJoin(
      authDirectoryGroupMembers,
      and(
        eq(
          authDirectoryGroupMembers.organizationId,
          authDirectoryUsers.organizationId,
        ),
        eq(authDirectoryGroupMembers.directoryUserId, authDirectoryUsers.id),
      ),
    )
    .innerJoin(
      workflowFolderGrants,
      and(
        eq(workflowFolderGrants.workspaceId, actor.workspaceId),
        eq(
          workflowFolderGrants.organizationId,
          authDirectoryGroupMembers.organizationId,
        ),
        eq(workflowFolderGrants.groupId, authDirectoryGroupMembers.groupId),
      ),
    )
    .where(eq(authOrganizationWorkspaces.workspaceId, actor.workspaceId));
  return direct.unionAll(groups).catch(rethrowQueryFailure);
}

/**
 * Bounded hierarchy plus only this actor's matching grants; no other members'
 * audiences. A role of null is someone with no access, whose scope permits nothing.
 */
export async function readTransactionFolderScope(
  transaction: Pick<WorkspaceTransaction, 'db'>,
  actor: ResourceActor,
  fencedRole?: Role | null,
  workspaceStatuses: readonly string[] = ACTIVE_WORKSPACE_STATUSES,
) {
  const { db } = transaction;
  const role =
    fencedRole === undefined
      ? await readWorkspaceRole(db, actor, workspaceStatuses)
      : fencedRole;
  if (role === null) return folderScope(actor.workspaceId, null, [], []);
  const folders = await db
    .select({
      id: workflowFolders.id,
      parentId: workflowFolders.parentId,
      accessMode: workflowFolders.accessMode,
    })
    .from(workflowFolders)
    .where(eq(workflowFolders.workspaceId, actor.workspaceId))
    .orderBy(workflowFolders.id)
    .limit(FOLDER_LIMIT + 1)
    .catch(rethrowQueryFailure);
  if (folders.length > FOLDER_LIMIT)
    throw new Error('Workspace folder facts exceed the supported bound.');
  const grants = RESOURCE_ADMINISTRATORS.includes(role)
    ? []
    : await matchingGrants(db, actor);
  return folderScope(actor.workspaceId, role, folders, grants);
}

/** The scope of a read a suspended workspace still allows (ADR 013/027). */
export function readBrowsableFolderScope(
  client: PoolClient,
  actor: ResourceActor,
) {
  return readFolderScope(
    client,
    actor,
    undefined,
    BROWSABLE_WORKSPACE_STATUSES,
  );
}

export function readFolderScope(
  client: PoolClient,
  actor: ResourceActor,
  fencedRole?: Role | null,
  workspaceStatuses: readonly string[] = ACTIVE_WORKSPACE_STATUSES,
) {
  return readTransactionFolderScope(
    { db: drizzle(client) },
    actor,
    fencedRole,
    workspaceStatuses,
  );
}

/** What a flow over workflows and runs works with, for the role the helper found. */
export async function readResourceTransaction(
  client: PoolClient,
  actor: ResourceActor,
  role: Role | null,
): Promise<ResourceTransaction> {
  return {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: actor.workspaceId as WorkspaceId,
    resources: await readFolderScope(client, actor, role),
  };
}
