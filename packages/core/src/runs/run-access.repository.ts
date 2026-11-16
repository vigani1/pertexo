import { workflowRuns, workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq, sql } from 'drizzle-orm';

import type {
  ResourceTransaction,
  WorkflowResourceCapability,
} from '../shared/access/folder-access.types.js';
import { workflowScopeSql } from '../shared/access/folder-scope.repository.js';

/** Whether the run exists and its workflow is in the transaction's folder scope. */
export async function runInScope(
  transaction: ResourceTransaction,
  runId: string,
  capability: WorkflowResourceCapability,
): Promise<boolean> {
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
  return found.length !== 0;
}

/** Whether the workflow exists and is in the transaction's folder scope. */
export async function workflowInScope(
  transaction: ResourceTransaction,
  workflowId: string,
  capability: WorkflowResourceCapability,
): Promise<boolean> {
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
  return found.length !== 0;
}

/** Whether a run or workflow is visible in the folder scope, for a value read. */
export async function ownerVisible(
  transaction: ResourceTransaction,
  owner: Readonly<{ kind: 'workflow' | 'run'; id: string }>,
): Promise<boolean> {
  const source = owner.kind === 'run' ? workflowRuns : workflows;
  const workflowId =
    owner.kind === 'run' ? workflowRuns.workflowId : workflows.id;
  const visible = await transaction.db
    .select({ one: sql`1` })
    .from(source)
    .where(
      and(
        eq(source.workspaceId, transaction.workspaceId),
        eq(source.id, owner.id),
        workflowScopeSql(transaction.resources, sql`${workflowId}`),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return visible.length !== 0;
}
