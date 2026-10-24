import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { workflowRuns } from '../../../schema/runs/execution.js';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { workflowCalls } from '../../../schema/runs/calls.js';
import { auditEvents } from '../../../schema/foundation.js';
import { users } from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { and, eq, sql } from 'drizzle-orm';
import type { FolderScope } from '../../../tenant-access/resources/contract.js';
import { workflowScopeSql } from '../../../tenant-access/resources/scope.queries.js';
import type { PoolClient } from 'pg';
import {
  approvalOutputSchema,
  formSubmissionSchema,
  inputRequestConfigSchema,
  parseFormValues,
} from '@pertexo/workflow-model';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
import { serializeStoredExecutionValue } from '../../../platform/stored-execution-value.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { wakeWorkflowRun } from '../../calls/wakeup.repository.js';
import type { Role } from '@pertexo/workflow-model';
import {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
  type PendingTaskStore,
} from './contract.js';
import { projectTask, readTaskRow } from './records.repository.js';

export async function respondToTask(
  client: PoolClient,
  input:
    | (Parameters<PendingTaskStore['decide']>[0] &
        Readonly<{ kind: 'approval' }>)
    | (Parameters<PendingTaskStore['submit']>[0] &
        Readonly<{ kind: 'input_request' }>),
  role: Role,
  resources: FolderScope,
) {
  const db = drizzle(client),
    task = pendingRunTasks,
    run = workflowRuns;
  const [target] = await db
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
  const runId = target?.run_id;
  if (runId === undefined)
    throw new PendingTaskNotFoundError('Task is not visible.');
  await db
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.workspaceId, input.workspaceId), eq(run.id, runId)))
    .for('no key update')
    .catch(rethrowQueryFailure);
  const row = await readTaskRow(client, input, {
    role,
    resources,
    locking: true,
  });
  if (row.kind !== input.kind)
    throw new PendingTaskNotFoundError('Task is not visible.');
  const values =
    input.kind === 'input_request'
      ? parseFormValues(
          inputRequestConfigSchema.parse(row.config).fields,
          input.values,
        )
      : undefined;
  const status = input.kind === 'approval' ? input.decision : 'submitted';
  const command = {
    workspaceId: input.workspaceId,
    operation:
      input.kind === 'approval' ? 'pending.task.decide' : 'pending.task.submit',
    scope: `${input.actorId}:${input.taskId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const request =
    input.kind === 'approval'
      ? {
          decision: input.decision,
          comment: input.comment === '' ? null : (input.comment ?? null),
        }
      : { values };
  const replay = await claimCommand(client, {
    ...command,
    request,
    resourceId: input.taskId,
  });
  if (replay !== null) return { task: projectTask(row), replayed: true };
  if (row.blocked_reason !== null)
    throw new PendingTaskDecisionError(row.blocked_reason);
  const [observation] = await db
    .select({
      now: sql<Date>`clock_timestamp()`.mapWith(users.createdAt),
      display_name: users.displayName,
    })
    .from(users)
    .where(eq(users.id, input.actorId))
    .catch(rethrowQueryFailure);
  if (observation === undefined)
    throw new Error('Decision identity and time unavailable');
  const { now, display_name } = observation;
  const output = taskResponseOutput(input, { values, now, display_name });
  const changed = await db
    .update(task)
    .set({
      status,
      outputRef: sql`${serializeStoredExecutionValue({ kind: 'inline', value: output })}::json`,
      decidedBy: input.actorId,
      completedAt: now,
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
  if (changed.rowCount !== 1) throw new PendingTaskDecisionError('expired');
  await db
    .insert(auditEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action:
        input.kind === 'approval'
          ? 'pending_task.decided'
          : 'pending_task.submitted',
      targetType: 'pending_task',
      targetId: input.taskId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata:
        input.kind === 'approval'
          ? { runId, decision: status }
          : { runId, status },
    })
    .catch(rethrowQueryFailure);
  await completeCommand(client, command, {
    taskId: input.taskId,
    status,
  });
  await wakeWorkflowRun(client, input.workspaceId, runId);
  await wakeTaskAncestors(client, input.workspaceId, runId);
  return {
    task: projectTask(await readTaskRow(client, input, { role, resources })),
    replayed: false,
  };
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

function taskResponseOutput(
  input: Parameters<typeof respondToTask>[1],
  {
    values,
    now,
    display_name,
  }: Readonly<{
    values: ReturnType<typeof parseFormValues> | undefined;
    now: Date;
    display_name: string;
  }>,
) {
  return input.kind === 'approval'
    ? approvalOutputSchema.parse({
        decision: input.decision,
        comment: input.comment === '' ? null : (input.comment ?? null),
        decidedBy: input.actorId,
        decidedByName: display_name,
        decidedAt: now.toISOString(),
      })
    : formSubmissionSchema.parse({
        values,
        submittedBy: input.actorId,
        submittedAt: now.toISOString(),
      });
}
