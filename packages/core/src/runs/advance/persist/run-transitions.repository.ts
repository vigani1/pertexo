import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { workflowRuns, runCheckpoints } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import { serializeStoredExecutionJsonValue } from '../../../shared/stored-execution.js';

/** Saves the planned checkpoint; false when its expected revision moved. */
export async function storeTransitionCheckpoint(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: WorkflowTransitionPlan;
  }>,
) {
  const { plan, runId, workspaceId } = input;
  const checkpointUpdate = await drizzle(client)
    .update(runCheckpoints)
    .set({
      revision: plan.checkpoint.revision,
      schedulerState: sql`${serializeStoredExecutionJsonValue(plan.checkpoint)}::jsonb`,
      resumeAt: null,
      resumeLeaseOwner: null,
      resumeLeaseToken: null,
      resumeLeaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(runCheckpoints.workspaceId, workspaceId),
        eq(runCheckpoints.workflowRunId, runId),
        eq(runCheckpoints.revision, plan.expectedRevision),
      ),
    )
    .catch(rethrowQueryFailure);
  return checkpointUpdate.rowCount === 1;
}

export async function storeRunTransition(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: WorkflowTransitionPlan;
    startedAt: string | undefined;
    completedAt: string | undefined;
    runFailure: string | undefined;
  }>,
) {
  const { plan, runId, workspaceId, startedAt, completedAt, runFailure } =
    input;
  await drizzle(client)
    .update(workflowRuns)
    .set({
      status: plan.checkpoint.runStatus,
      handledFailureCount: plan.checkpoint.invocations.filter(
        ({ failureHandling }) => failureHandling?.disposition === 'handled',
      ).length,
      startedAt: sql`coalesce(${workflowRuns.startedAt},${startedAt ?? null}::timestamptz)`,
      completedAt:
        completedAt === undefined
          ? undefined
          : sql`${completedAt}::timestamptz`,
      outputRef:
        plan.runResult === undefined
          ? undefined
          : sql`${JSON.stringify({ kind: 'inline', value: plan.runResult })}::json`,
      errorSummary: sql`coalesce(${runFailure ?? null}::varchar,${workflowRuns.errorSummary})`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowRuns.workspaceId, workspaceId),
        eq(workflowRuns.id, runId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** Database seconds since a moment; undefined only if the read returned no row. */
export async function secondsSince(client: PoolClient, moment: string) {
  const { rows } = await drizzle(client)
    .execute<{ seconds: number }>(
      sql`select extract(epoch from clock_timestamp()-${moment}::timestamptz)::float8 seconds`,
    )
    .catch(rethrowQueryFailure);
  return rows[0]?.seconds;
}
