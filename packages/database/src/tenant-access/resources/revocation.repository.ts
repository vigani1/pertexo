import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { workflowFolderGrants } from '../../schema/authoring/folder-grants.js';
import { workflowFolders } from '../../schema/authoring/organization.js';
import { connections, connectionShares } from '../../schema/connections.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { withWorkspaceScope } from '../transactions.js';

/** Revoking a principal also invalidates an administrator's open sharing form. */
export async function removeMemberResourceGrants(
  client: PoolClient,
  workspaceId: string,
  userIds: readonly string[],
): Promise<void> {
  const db = drizzle(client);
  const folders = db.$with('removed').as(
    db
      .delete(workflowFolderGrants)
      .where(
        and(
          eq(workflowFolderGrants.workspaceId, workspaceId),
          sql`${workflowFolderGrants.userId}=any(${sql.param(userIds)}::uuid[])`,
        ),
      )
      .returning({ folderId: workflowFolderGrants.folderId }),
  );
  await db
    .with(folders)
    .update(workflowFolders)
    .set({ revision: sql`${workflowFolders.revision}+1` })
    .where(
      and(
        eq(workflowFolders.workspaceId, workspaceId),
        inArray(
          workflowFolders.id,
          db.select({ id: folders.folderId }).from(folders),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  const shares = db.$with('removed').as(
    db
      .delete(connectionShares)
      .where(
        and(
          eq(connectionShares.workspaceId, workspaceId),
          sql`${connectionShares.userId}=any(${sql.param(userIds)}::uuid[])`,
        ),
      )
      .returning({ connectionId: connectionShares.connectionId }),
  );
  await db
    .with(shares)
    .update(connections)
    .set({ sharingRevision: sql`${connections.sharingRevision}+1` })
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        inArray(
          connections.id,
          db.select({ id: shares.connectionId }).from(shares),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** The directory owner already holds the linked workspace locks in stable order. */
export async function removeDirectoryFolderGrants(
  client: PoolClient,
  organizationId: string,
  workspaceIds: readonly string[],
  groupId?: string,
): Promise<void> {
  for (const workspaceId of [...workspaceIds].sort())
    await withWorkspaceScope(client, { workspaceId }, async (scoped) => {
      const db = drizzle(scoped);
      const removed = db.$with('removed').as(
        db
          .delete(workflowFolderGrants)
          .where(
            and(
              eq(workflowFolderGrants.workspaceId, workspaceId),
              eq(workflowFolderGrants.organizationId, organizationId),
              sql`(${groupId ?? null}::uuid is null or ${workflowFolderGrants.groupId}=${groupId ?? null})`,
            ),
          )
          .returning({ folderId: workflowFolderGrants.folderId }),
      );
      await db
        .with(removed)
        .update(workflowFolders)
        .set({ revision: sql`${workflowFolders.revision}+1` })
        .where(
          and(
            eq(workflowFolders.workspaceId, workspaceId),
            inArray(
              workflowFolders.id,
              db.select({ id: removed.folderId }).from(removed),
            ),
          ),
        )
        .catch(rethrowQueryFailure);
    });
}
