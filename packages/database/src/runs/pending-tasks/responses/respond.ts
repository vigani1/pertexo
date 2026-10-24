import { sql } from 'drizzle-orm';
import type { FolderScope } from '../../../tenant-access/resources/contract.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../../tenant-access/resources/query-scope.js';
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
import { wakeWorkflowRun } from '../../calls/wakeup.js';
import type { Role } from '@pertexo/workflow-model';
import {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
  type PendingTaskStore,
} from './contract.js';
import { projectTask, readTaskRow } from './queries.js';

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
  const parameters: unknown[] = [input.workspaceId, input.taskId];
  const visible = bindResourcePredicate(
    workflowScopeSql(resources, sql`run.workflow_id`),
    parameters,
  );
  const target = await client.query<{ run_id: string }>(
    `select task.run_id from app.pending_run_tasks task join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id where task.workspace_id=$1 and task.id=$2 and ${visible}`,
    parameters,
  );
  const runId = target.rows[0]?.run_id;
  if (runId === undefined)
    throw new PendingTaskNotFoundError('Task is not visible.');
  await client.query(
    'select id from app.workflow_runs where workspace_id=$1 and id=$2 for no key update',
    [input.workspaceId, runId],
  );
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
  const observed = await client.query<{ now: Date; display_name: string }>(
    'select clock_timestamp() now,display_name from app.users where id=$1',
    [input.actorId],
  );
  const observation = observed.rows[0];
  if (observation === undefined)
    throw new Error('Decision identity and time unavailable');
  const { now, display_name } = observation;
  const output = taskResponseOutput(input, { values, now, display_name });
  const changed = await client.query(
    `update app.pending_run_tasks set status=$3,output_ref=$4::json,decided_by=$5,completed_at=$6 where workspace_id=$1 and id=$2 and status='pending' and expires_at>clock_timestamp()`,
    [
      input.workspaceId,
      input.taskId,
      status,
      serializeStoredExecutionValue({ kind: 'inline', value: output }),
      input.actorId,
      now,
    ],
  );
  if (changed.rowCount !== 1) throw new PendingTaskDecisionError('expired');
  await client.query(
    `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata) values($1,$2,$3,$8,'pending_task',$4,$5,$6,$7::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      input.taskId,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify(
        input.kind === 'approval'
          ? { runId, decision: status }
          : { runId, status },
      ),
      input.kind === 'approval'
        ? 'pending_task.decided'
        : 'pending_task.submitted',
    ],
  );
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
  const ancestors = await client.query<{ id: string }>(
    `with recursive ancestors(id) as (
    select parent_run_id from app.workflow_calls where workspace_id=$1 and child_run_id=$2 and status='accepted'
    union select call.parent_run_id from app.workflow_calls call join ancestors on call.child_run_id=ancestors.id where call.workspace_id=$1 and call.status='accepted'
  ) select id from ancestors`,
    [workspaceId, runId],
  );
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
