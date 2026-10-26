import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import {
  approvalConfigSchema,
  inputRequestConfigSchema,
  taskContextSchema,
  timedOutTaskOutput,
} from '@pertexo/workflow-model';
import { workflowRuns } from '../../../schema/runs/execution.js';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { serializeStoredExecutionValue } from '../../../platform/stored-execution-value.js';

/**
 * Database time decides expiry. A task whose step continues on Timed out
 * records its timed-out output in the same transaction, so later steps read
 * it like any answer. Returns how many tasks expired.
 */
export async function expireDueTasks(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<number> {
  const db = drizzle(client),
    task = pendingRunTasks,
    run = workflowRuns;
  const expired = await db
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
        inArray(run.status, ['queued', 'running', 'waiting']),
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
  for (const row of expired) {
    const setup = timeoutSetup(row);
    if (setup?.onExpiry !== 'continue') continue;
    const output = timedOutTaskOutput({
      openedAt: row.created_at,
      expiredAt: row.expires_at,
      audience: setup.audience,
      context: taskContextSchema.parse(row.context),
    });
    await db
      .update(task)
      .set({
        outputRef: sql`${serializeStoredExecutionValue({ kind: 'inline', value: output })}::json`,
      })
      .where(and(eq(task.workspaceId, workspaceId), eq(task.id, row.id)))
      .catch(rethrowQueryFailure);
  }
  return expired.length;
}

/** Callbacks have no Timed out path; they always fail their Wait on expiry. */
function timeoutSetup(row: Readonly<{ kind: string; config: unknown }>) {
  if (row.kind === 'approval') return approvalConfigSchema.parse(row.config);
  if (row.kind === 'input_request')
    return inputRequestConfigSchema.parse(row.config);
  return undefined;
}
