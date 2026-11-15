import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { serializeStoredExecutionValue } from '../../../shared/stored-execution.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import {
  workflowRuns,
  pendingRunTasks,
  workflowCalls,
  users,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { workflowScopeSql } from '../../../shared/folder-scope.repository.js';
import type { PoolClient } from 'pg';
import { wakeWorkflowRun } from '../../../outbox/run-advance.repository.js';

const task = pendingRunTasks,
  run = workflowRuns;

/** The run of a task the responder may see, or undefined. */
export async function findVisibleTaskRun(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; taskId: string }>,
  resources: FolderScope,
) {
  const [target] = await drizzle(client)
    .select({ run_id: task.runId })
    .from(task)
    .innerJoin(
      run,
      and(eq(run.workspaceId, task.workspaceId), eq(run.id, task.runId)),
    )
    .where(
      and(
        eq(task.workspaceId, input.workspaceId),
        eq(task.id, input.taskId),
        workflowScopeSql(resources, sql`${run.workflowId}`),
      ),
    )
    .catch(rethrowQueryFailure);
  return target?.run_id;
}

/** A response takes the run before its task, as the coordinator does. */
export async function lockTaskRun(
  client: PoolClient,
  workspaceId: string,
  runId: string,
) {
  await drizzle(client)
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.workspaceId, workspaceId), eq(run.id, runId)))
    .for('no key update')
    .catch(rethrowQueryFailure);
}

/** The responder's name and the decision time, read together. */
export async function readResponder(client: PoolClient, actorId: string) {
  const [observation] = await drizzle(client)
    .select({
      now: sql<Date>`clock_timestamp()`.mapWith(users.createdAt),
      display_name: users.displayName,
    })
    .from(users)
    .where(eq(users.id, actorId))
    .catch(rethrowQueryFailure);
  return observation;
}

/** Settles a pending, unexpired task; false when it was settled or expired first. */
export async function settleTask(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    taskId: string;
    actorId: string;
    status: string;
    output: unknown;
    now: Date;
  }>,
) {
  const changed = await drizzle(client)
    .update(task)
    .set({
      status: input.status,
      outputRef: sql`${serializeStoredExecutionValue({ kind: 'inline', value: input.output })}::json`,
      decidedBy: input.actorId,
      completedAt: input.now,
    })
    .where(
      and(
        eq(task.workspaceId, input.workspaceId),
        eq(task.id, input.taskId),
        eq(task.status, 'pending'),
        sql`${task.expiresAt}>clock_timestamp()`,
      ),
    )
    .catch(rethrowQueryFailure);
  return changed.rowCount === 1;
}

/** Ancestors observe their own state/locks; a response never takes parent locks. */
export async function wakeTaskAncestors(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<void> {
  const call = alias(workflowCalls, 'call');
  const ancestors = await drizzle(client)
    .execute<{ id: string }>(
      sql`with recursive ancestors(id) as (
    select ${workflowCalls.parentRunId} from ${workflowCalls} where ${workflowCalls.workspaceId}=${workspaceId} and ${workflowCalls.childRunId}=${runId} and ${workflowCalls.status}='accepted'
    union select ${call.parentRunId} from ${workflowCalls} ${sql.identifier('call')} join ancestors on ${call.childRunId}=ancestors.id where ${call.workspaceId}=${workspaceId} and ${call.status}='accepted'
  ) select id from ancestors`,
    )
    .catch(rethrowQueryFailure);
  for (const row of ancestors.rows)
    await wakeWorkflowRun(client, workspaceId, row.id);
}
