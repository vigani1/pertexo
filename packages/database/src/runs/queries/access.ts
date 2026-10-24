import type { Pool } from 'pg';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { withResourceCommand } from '../../tenant-access/resources/transactions.repository.js';
import type { ResourceActor } from '../../tenant-access/resources/contract.js';
import { sql } from 'drizzle-orm';
import { WorkflowRunNotFoundError } from '../errors.js';
import type { ResourceTransaction } from '../../tenant-access/resources/contract.js';
import { workflowScopeSql } from '../../tenant-access/resources/scope.queries.js';
import type { WorkflowResourceCapability } from '../../tenant-access/resources/contract.js';

/** The command already holds the workspace authority fence before touching run rows. */
export async function requireRunAccess(
  transaction: ResourceTransaction,
  runId: string,
  capability: WorkflowResourceCapability,
): Promise<void> {
  const found = await transaction.db
    .execute(sql`select 1 from app.workflow_runs resource_run
    where resource_run.workspace_id=${transaction.workspaceId} and resource_run.id=${runId}
      and ${workflowScopeSql(transaction.resources, sql`resource_run.workflow_id`, capability)}`);
  if (found.rows.length === 0) throw new WorkflowRunNotFoundError();
}

export async function requireWorkflowAccess(
  transaction: ResourceTransaction,
  workflowId: string,
  capability: WorkflowResourceCapability,
): Promise<void> {
  const found = await transaction.db
    .execute(sql`select 1 from app.workflows resource_workflow
    where resource_workflow.workspace_id=${transaction.workspaceId} and resource_workflow.id=${workflowId}
      and ${workflowScopeSql(transaction.resources, sql`resource_workflow.id`, capability)}`);
  if (found.rows.length === 0) throw new WorkflowRunNotFoundError();
}

export async function withRunCommand<T>(
  pool: Pool,
  input: ResourceActor & { signal?: AbortSignal | undefined },
  capability: WorkflowResourceCapability,
  command: (transaction: ResourceTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withResourceCommand(pool, input, capability, command);
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new WorkflowRunNotFoundError();
    throw error;
  }
}
