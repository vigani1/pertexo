import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { workflowRuns, pendingRunTasks } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { ACTIVE_RUN_STATUSES } from '../../statuses.js';
import { serializeStoredExecutionValue } from '../../../shared/stored-execution.js';

const task = pendingRunTasks,
  run = workflowRuns;

/** Database time decides expiry: expires the run's due pending tasks and returns them. */
export function expireDueTaskRows(
  client: PoolClient,
  workspaceId: string,
  runId: string,
) {
  return drizzle(client)
    .update(task)
    .set({ status: 'expired', completedAt: sql`clock_timestamp()` })
    .from(run)
    .where(
      and(
        eq(task.workspaceId, workspaceId),
        eq(task.runId, runId),
        eq(task.status, 'pending'),
        sql`${task.expiresAt}<=clock_timestamp()`,
        eq(run.workspaceId, task.workspaceId),
        eq(run.id, task.runId),
        inArray(run.status, ACTIVE_RUN_STATUSES),
        isNull(run.cancelRequestedAt),
      ),
    )
    .returning({
      id: task.id,
      kind: task.kind,
      config: task.config,
      context: task.context,
      created_at: sql<Date>`${task.createdAt}`.mapWith(task.createdAt),
      expires_at: sql<Date>`${task.expiresAt}`.mapWith(task.expiresAt),
    })
    .catch(rethrowQueryFailure);
}

/** Records a timed-out task's output so later steps read it like any answer. */
export async function storeTimedOutOutput(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; taskId: string; output: unknown }>,
) {
  await drizzle(client)
    .update(task)
    .set({
      outputRef: sql`${serializeStoredExecutionValue({ kind: 'inline', value: input.output })}::json`,
    })
    .where(
      and(eq(task.workspaceId, input.workspaceId), eq(task.id, input.taskId)),
    )
    .catch(rethrowQueryFailure);
}
