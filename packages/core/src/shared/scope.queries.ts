import { and, eq, notExists, sql, type SQL } from 'drizzle-orm';
import { workflowOrganizationState } from '@pertexo/database/schema';
import { QueryBuilder, alias } from 'drizzle-orm/pg-core';
import type {
  FolderScope,
  WorkflowResourceCapability,
} from '../tenant-access/resources/contract.js';

/** The policy supplies folder IDs; SQL only filters those already-decided facts. */
export function workflowScopeSql(
  scope: FolderScope,
  workflowId: SQL,
  capability: WorkflowResourceCapability = 'workflow:read',
): SQL {
  if (!scope.permits(null, capability)) return sql`false`;
  const workspace = sql`${scope.workspaceId}::uuid=current_setting('app.workspace_id')::uuid`;
  const denied = scope.deniedFolderIds(capability);
  if (denied.length === 0) return workspace;
  const resourceFolder = alias(workflowOrganizationState, 'resource_folder');
  const deniedPlacement = new QueryBuilder()
    .select({ one: sql`1` })
    .from(resourceFolder)
    .where(
      and(
        eq(
          resourceFolder.workspaceId,
          sql`current_setting('app.workspace_id')::uuid`,
        ),
        eq(resourceFolder.workflowId, workflowId),
        sql`${resourceFolder.folderId}=any(${sql.param(denied)}::uuid[])`,
      ),
    );
  return sql`(${workspace}) and ${notExists(deniedPlacement)}`;
}
