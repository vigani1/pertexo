import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { FOLDER_LIMIT } from '../authoring/organization/limits.js';
import {
  users,
  workspaceMemberships,
  workspaces,
  workflowFolders,
  workflowFolderGrants,
  authOrganizationWorkspaces,
  authDirectoryUsers,
  authDirectoryGroupMembers,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  BROWSABLE_WORKSPACE_STATUSES,
  type Role,
} from '@pertexo/workflow-model';
import type { ResourceActor } from '../tenant-access/resources/contract.js';
import {
  folderScope,
  RESOURCE_ADMINISTRATORS,
} from '../tenant-access/resources/policy.js';

async function currentRole(
  db: WorkspaceTransaction['db'],
  actor: ResourceActor,
  workspaceStatuses: readonly string[],
) {
  const rows = await db
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, actor.workspaceId),
        eq(workspaceMemberships.userId, actor.actorId),
        eq(workspaceMemberships.status, 'active'),
        eq(users.status, 'active'),
        sql`${workspaces.status}=any(${sql.param(workspaceStatuses)}::text[])`,
      ),
    )
    .catch(rethrowQueryFailure);
  return rows[0]?.role ?? null;
}

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

/** Bounded hierarchy plus only this actor's matching grants; no other members' audiences. */
export async function readTransactionFolderScope(
  transaction: Pick<WorkspaceTransaction, 'db'>,
  actor: ResourceActor,
  fencedRole?: Role,
  workspaceStatuses: readonly string[] = ['active'],
) {
  const { db } = transaction;
  const role = fencedRole ?? (await currentRole(db, actor, workspaceStatuses));
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
  fencedRole?: Role,
  workspaceStatuses: readonly string[] = ['active'],
) {
  return readTransactionFolderScope(
    { db: drizzle(client) },
    actor,
    fencedRole,
    workspaceStatuses,
  );
}
