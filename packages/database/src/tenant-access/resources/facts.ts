import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { FOLDER_LIMIT } from '../../authoring/organization/limits.js';
import type { PoolClient } from 'pg';
import type { WorkspaceTransaction } from '../transactions.js';
import type { Role } from '@pertexo/workflow-model';
import type {
  FolderFact,
  MatchingFolderGrant,
  ResourceActor,
} from './contract.js';
import { folderScope, RESOURCE_ADMINISTRATORS } from './policy.js';

/** Bounded hierarchy plus only this actor's matching grants; no other members' audiences. */
export async function readTransactionFolderScope(
  transaction: Pick<WorkspaceTransaction, 'db'>,
  actor: ResourceActor,
  fencedRole?: Role,
  workspaceStatuses: readonly string[] = ['active'],
) {
  const { db } = transaction;
  const role =
    fencedRole ??
    (
      await db.execute<{ role: Role }>(sql`
    select member.role from app.workspace_memberships member
    join app.users person on person.id=member.user_id
    join app.workspaces workspace on workspace.id=member.workspace_id
    where member.workspace_id=${actor.workspaceId} and member.user_id=${actor.actorId}
      and member.status='active' and person.status='active' and workspace.status=any(${sql.param(workspaceStatuses)}::text[])
  `)
    ).rows[0]?.role ??
    null;
  if (role === null) return folderScope(actor.workspaceId, null, [], []);
  const folders = await db.execute<FolderFact>(sql`
    select id,parent_id as "parentId",access_mode as "accessMode"
    from app.workflow_folders where workspace_id=${actor.workspaceId} order by id limit ${FOLDER_LIMIT + 1}
  `);
  if (folders.rows.length > FOLDER_LIMIT)
    throw new Error('Workspace folder facts exceed the supported bound.');
  const grants = RESOURCE_ADMINISTRATORS.includes(role)
    ? []
    : (
        await db.execute<MatchingFolderGrant>(sql`
    with actor_groups as materialized (
      select member.organization_id,member.group_id
      from app.auth_organization_workspaces link
      join app.auth_directory_users person on person.organization_id=link.organization_id
        and person.user_id=${actor.actorId} and person.active and person.deleted_at is null
      join app.auth_directory_group_members member on member.organization_id=person.organization_id
        and member.directory_user_id=person.id where link.workspace_id=${actor.workspaceId})
    select permission.folder_id as "folderId",permission.access
    from app.workflow_folder_grants permission where permission.workspace_id=${actor.workspaceId} and permission.user_id=${actor.actorId}
    union all
    select permission.folder_id as "folderId",permission.access
    from actor_groups member join app.workflow_folder_grants permission
      on permission.workspace_id=${actor.workspaceId} and permission.organization_id=member.organization_id
        and permission.group_id=member.group_id
  `)
      ).rows;
  return folderScope(actor.workspaceId, role, folders.rows, grants);
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
