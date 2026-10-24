import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { workflowCalls } from '../../schema/runs/calls.js';
import { nodeRuns, workflowRuns } from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type { WorkflowCallOutcome } from '@pertexo/workflow-engine';

/** Immutable child outcomes use the parent's retained node scope, not its event cursor. */
export async function readCallFacts(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<
  Readonly<{
    hasExecutionSlot: boolean;
    hasHumanChild: boolean;
    callOutcomes: readonly WorkflowCallOutcome[];
  }>
> {
  const c = workflowCalls,
    n = nodeRuns,
    child = alias(workflowRuns, 'child');
  const rows = await drizzle(client)
    .select({
      id: c.id,
      invocation_key: c.invocationKey,
      status: c.status,
      safe_error_code: c.safeErrorCode,
      slot_lent: c.slotLent,
      consumed_at: c.consumedAt,
      node_id: n.nodeId,
      branch_context: sql<
        Pick<WorkflowCallOutcome, 'branchPath' | 'iterationPath'>
      >`${n.branchContext}`,
      child_wait: child.humanWaitStartedAt,
    })
    .from(c)
    .innerJoin(
      n,
      and(
        eq(n.workspaceId, c.workspaceId),
        eq(n.workflowRunId, c.parentRunId),
        eq(n.invocationKey, c.invocationKey),
      ),
    )
    .leftJoin(
      child,
      and(eq(child.workspaceId, c.workspaceId), eq(child.id, c.childRunId)),
    )
    .where(
      and(
        eq(c.workspaceId, workspaceId),
        eq(c.parentRunId, runId),
        or(eq(c.slotLent, true), isNull(c.consumedAt)),
      ),
    )
    .orderBy(c.invocationKey)
    .catch(rethrowQueryFailure);
  return {
    hasExecutionSlot: !rows.some(({ slot_lent }) => slot_lent),
    hasHumanChild: rows.some(({ child_wait }) => child_wait !== null),
    callOutcomes: rows.flatMap((row) => {
      const status = row.status;
      const ignoresCallOutcome =
        row.consumed_at !== null ||
        status === 'pending' ||
        status === 'accepted';
      return ignoresCallOutcome
        ? []
        : [
            {
              ...row.branch_context,
              callId: row.id,
              invocationKey: row.invocation_key,
              nodeId: row.node_id,
              status,
              ...(row.safe_error_code === null
                ? {}
                : { reasonCode: row.safe_error_code }),
            },
          ];
    }),
  };
}
