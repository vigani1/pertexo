import type { PoolClient } from 'pg';
import { withWorkspaceScope } from '../transactions.js';

/** Revoking a principal also invalidates an administrator's open sharing form. */
export async function removeMemberResourceGrants(
  client: PoolClient,
  workspaceId: string,
  userIds: readonly string[],
): Promise<void> {
  await client.query(
    `with removed as (delete from app.workflow_folder_grants where workspace_id=$1 and user_id=any($2::uuid[]) returning folder_id)
    update app.workflow_folders set revision=revision+1 where workspace_id=$1 and id in (select folder_id from removed)`,
    [workspaceId, userIds],
  );
  await client.query(
    `with removed as (delete from app.connection_shares where workspace_id=$1 and user_id=any($2::uuid[]) returning connection_id)
    update app.connections set sharing_revision=sharing_revision+1 where workspace_id=$1 and id in (select connection_id from removed)`,
    [workspaceId, userIds],
  );
}

/** The directory owner already holds the linked workspace locks in stable order. */
export async function removeDirectoryFolderGrants(
  client: PoolClient,
  organizationId: string,
  workspaceIds: readonly string[],
  groupId?: string,
): Promise<void> {
  for (const workspaceId of [...workspaceIds].sort())
    await withWorkspaceScope(client, { workspaceId }, (scoped) =>
      scoped.query(
        `with removed as (delete from app.workflow_folder_grants where workspace_id=$1 and organization_id=$2 and ($3::uuid is null or group_id=$3) returning folder_id)
      update app.workflow_folders set revision=revision+1 where workspace_id=$1 and id in (select folder_id from removed)`,
        [workspaceId, organizationId, groupId ?? null],
      ),
    );
}
