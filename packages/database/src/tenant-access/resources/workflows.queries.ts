import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type { FolderScope, WorkflowResourceCapability } from './contract.js';
import { bindResourcePredicate, workflowScopeSql } from './scope.queries.js';

/** Reuse the caller's scope for a direct read or command, including idempotent replay. */
export async function workflowAccessible(
  client: PoolClient,
  scope: FolderScope,
  {
    workspaceId,
    workflowId,
    capability = 'workflow:read',
  }: Readonly<{
    workspaceId: string;
    workflowId: string;
    capability?: WorkflowResourceCapability | undefined;
  }>,
): Promise<boolean> {
  const parameters: unknown[] = [workspaceId, workflowId];
  const visible = bindResourcePredicate(
    workflowScopeSql(scope, sql`workflow.id`, capability),
    parameters,
  );
  const result = await client.query(
    `select 1 from app.workflows workflow where workflow.workspace_id=$1 and workflow.id=$2 and ${visible}`,
    parameters,
  );
  return result.rowCount === 1;
}

/** Project allowed actions from the same bounded facts that filter the read. */
export function workflowActions(scope: FolderScope, folderId: string | null) {
  return {
    canEdit: scope.permits(folderId, 'workflow:update'),
    canPublish: scope.permits(folderId, 'workflow:publish'),
  };
}
