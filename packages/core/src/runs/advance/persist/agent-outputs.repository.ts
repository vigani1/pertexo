import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { nodeRuns } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import type { PoolClient } from 'pg';
import { serializeStoredExecutionValue } from '../../../shared/stored-execution.js';
import { CoordinatorRunStateCorruptError } from '../coordinator-state.errors.js';

export async function persistAgentOutputs(
  client: PoolClient,
  {
    workspaceId,
    runId,
    plan,
  }: Readonly<{
    workspaceId: string;
    runId: string;
    plan: WorkflowTransitionPlan;
  }>,
): Promise<void> {
  for (const output of plan.agentOutputs ?? []) {
    const stored = serializeStoredExecutionValue({
      kind: 'inline',
      value: output.value,
    });
    const result = await drizzle(client)
      .update(nodeRuns)
      .set({ outputRef: sql`${stored}::json` })
      .where(
        and(
          eq(nodeRuns.workspaceId, workspaceId),
          eq(nodeRuns.workflowRunId, runId),
          eq(nodeRuns.invocationKey, output.invocationKey),
          eq(nodeRuns.status, 'succeeded'),
          isNull(nodeRuns.currentAttemptId),
        ),
      )
      .catch(rethrowQueryFailure);
    if (result.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
}
