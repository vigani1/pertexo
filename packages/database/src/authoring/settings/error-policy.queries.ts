import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type { WorkflowErrorSettings } from '@pertexo/contracts';
import type { FolderScope } from '../../tenant-access/resources/contract.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../tenant-access/resources/query-scope.js';
export async function readPolicy(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  access: FolderScope,
): Promise<WorkflowErrorSettings> {
  const parameters: unknown[] = [workspaceId, workflowId];
  const visible = bindResourcePredicate(
    workflowScopeSql(access, sql`target.id`),
    parameters,
  );
  const found = await client.query<{
    target_workflow_id: string | null;
    target_name: string | null;
    revision: number;
  }>(
    `select policy.target_workflow_id,policy.revision,case when ${visible} then target.name else null end target_name from app.workflow_error_policies policy left join app.workflows target on target.workspace_id=policy.workspace_id and target.id=policy.target_workflow_id where policy.workspace_id=$1 and policy.workflow_id=$2`,
    parameters,
  );
  return {
    targetWorkflowId: found.rows[0]?.target_workflow_id ?? null,
    revision: found.rows[0]?.revision ?? 1,
    targetWorkflowName: found.rows[0]?.target_name ?? null,
  };
}
