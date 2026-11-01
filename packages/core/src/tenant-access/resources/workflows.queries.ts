import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { FolderScope, WorkflowResourceCapability } from './contract.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';

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
  const rows = await drizzle(client)
    .select({ one: sql`1` })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        eq(workflows.id, workflowId),
        workflowScopeSql(scope, sql`${workflows.id}`, capability),
      ),
    )
    .catch(rethrowQueryFailure);
  return rows.length === 1;
}

/** Project allowed actions from the same bounded facts that filter the read. */
export function workflowActions(scope: FolderScope, folderId: string | null) {
  return {
    canEdit: scope.permits(folderId, 'workflow:update'),
    canPublish: scope.permits(folderId, 'workflow:publish'),
  };
}
