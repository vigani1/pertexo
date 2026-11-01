import { workflowRuns, workflows } from '@pertexo/database/schema';
import type { Pool } from 'pg';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { withResourceCommand } from '../../tenant-access/resources/transactions.repository.js';
import type { ResourceActor } from '../../tenant-access/resources/contract.js';
import { and, eq, sql } from 'drizzle-orm';
import { WorkflowRunNotFoundError } from '../errors.js';
import type { ResourceTransaction } from '../../tenant-access/resources/contract.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import type { WorkflowResourceCapability } from '../../tenant-access/resources/contract.js';

/** The command already holds the workspace authority fence before touching run rows. */
export async function requireRunAccess(
  transaction: ResourceTransaction,
  runId: string,
  capability: WorkflowResourceCapability,
): Promise<void> {
  const found = await transaction.db
    .select({ one: sql`1` })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, runId),
        workflowScopeSql(
          transaction.resources,
          sql`${workflowRuns.workflowId}`,
          capability,
        ),
      ),
    );
  if (found.length === 0) throw new WorkflowRunNotFoundError();
}

export async function requireWorkflowAccess(
  transaction: ResourceTransaction,
  workflowId: string,
  capability: WorkflowResourceCapability,
): Promise<void> {
  const found = await transaction.db
    .select({ one: sql`1` })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
        workflowScopeSql(
          transaction.resources,
          sql`${workflows.id}`,
          capability,
        ),
      ),
    );
  if (found.length === 0) throw new WorkflowRunNotFoundError();
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
