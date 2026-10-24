import {
  readPendingTaskAllowance,
  hasPendingTaskCapacity,
} from './allowance.queries.js';
import { bindCallbackTask } from '../callbacks/bind.repository.js';
import { callbackScopeHash } from '../callbacks/identity.repository.js';
import type { PoolClient } from 'pg';
import type { RunTransitionPlan } from '../../advance/plan.js';
import { terminalRunStatuses } from '../../advance/plan.js';
import { CoordinatorRunStateCorruptError } from '../../advance/contract.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { wakeWorkflowRun } from '../../calls/wakeup.repository.js';

/** The validated declaration, logical wait and checkpoint share this transaction. */
export async function persistTaskIntents(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: RunTransitionPlan;
  }>,
): Promise<void> {
  const { workspaceId, runId, plan } = input;
  if ((plan.taskIntents?.length ?? 0) === 0) return;
  await client.query('select app.lock_workspace_execution_counter($1)', [
    workspaceId,
  ]);
  for (const intent of plan.taskIntents ?? []) {
    let status: 'canceled' | 'pending' | 'refused';
    if (terminalRunStatuses.has(plan.checkpoint.runStatus)) status = 'canceled';
    else if (intent.kind === 'callback') status = 'pending';
    else
      status = hasPendingTaskCapacity(
        await readPendingTaskAllowance(client, workspaceId),
      )
        ? 'pending'
        : 'refused';
    const inserted =
      intent.kind === 'callback'
        ? {
            rows: [
              await bindCallbackTask(client, workspaceId, {
                runId,
                intent,
                closed: terminalRunStatuses.has(plan.checkpoint.runStatus),
              }),
            ],
          }
        : await client.query<{ id: string; expires_at: Date; status: string }>(
            `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,status,created_at,expires_at,completed_at,context)
      select $1,$2,$3,run.workflow_version_id,node.id,$4::varchar,$8::varchar,$5::jsonb,$6::varchar,observed.time,observed.time+make_interval(secs=>$7),case when $6::varchar='pending' then null else observed.time end,$9::jsonb
      from app.workflow_runs run join app.node_runs node on node.workspace_id=run.workspace_id and node.workflow_run_id=run.id
      cross join (select clock_timestamp() time) observed
      where run.workspace_id=$2 and run.id=$3 and node.invocation_key=$4::varchar and node.status='succeeded'
      returning id,expires_at,status`,
            [
              generatePersistedId(),
              workspaceId,
              runId,
              intent.invocationKey,
              JSON.stringify(intent.config),
              status,
              intent.config.expiresAfterSeconds,
              intent.kind,
              JSON.stringify(intent.context ?? {}),
            ],
          );
    const row = inserted.rows[0];
    if (row === undefined) throw new CoordinatorRunStateCorruptError();
    const wait = await client.query(
      `update app.node_runs set status='waiting',control_kind='human_task',output_ref=null,completed_at=null,resume_at=$4,retry_due_at=null,due_wakeup_at=null,wait_kind=null,updated_at=clock_timestamp() where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3 and status='succeeded'`,
      [workspaceId, runId, intent.invocationKey, row.expires_at],
    );
    if (wait.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
    if (status === 'refused' || row.status === 'submitted')
      await wakeWorkflowRun(client, workspaceId, runId);
  }
}

/** Project the task result, then close every task its logical node has settled. */
export async function persistConsumedTasks(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: RunTransitionPlan,
): Promise<void> {
  const completed = new Set(
    plan.events.flatMap(({ name, invocationKey }) =>
      name === 'node.succeeded' && invocationKey !== undefined
        ? [invocationKey]
        : [],
    ),
  );
  for (const node of [
    ...plan.checkpoint.invocations,
    ...(plan.prunedInvocations ?? []),
  ]) {
    if (node.output?.kind !== 'task' || !completed.has(node.invocationKey))
      continue;
    const updated = await client.query(
      `update app.node_runs node set output_ref=task.output_ref from app.pending_run_tasks task where task.workspace_id=$1 and task.run_id=$2 and task.id=$3 and task.invocation_key=$4 and task.status in ('approved','rejected','submitted') and task.output_ref is not null and node.workspace_id=task.workspace_id and node.id=task.node_run_id and node.workflow_run_id=task.run_id and node.invocation_key=task.invocation_key and node.status='succeeded'`,
      [workspaceId, runId, node.output.taskId, node.invocationKey],
    );
    if (updated.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
  if (terminalRunStatuses.has(plan.checkpoint.runStatus)) {
    await client.query(
      `update app.pending_run_tasks set status=case when status='prepared' then 'canceled' else status end,completed_at=coalesce(completed_at,clock_timestamp()),consumed_at=clock_timestamp() where workspace_id=$1 and run_id=$2 and kind='callback' and node_run_id is null and consumed_at is null`,
      [workspaceId, runId],
    );
  } else {
    const closed = [
      ...plan.checkpoint.invocations,
      ...(plan.prunedInvocations ?? []),
    ].filter((node) =>
      [
        'skipped',
        'canceled',
        'failed',
        'timed_out',
        'outcome_unknown',
      ].includes(node.status),
    );
    if (closed.length > 0) {
      const prepared = await client.query<{
        id: string;
        callback_node_id: string;
        callback_scope_hash: string;
      }>(
        `select id,callback_node_id,callback_scope_hash from app.pending_run_tasks where workspace_id=$1 and run_id=$2 and kind='callback' and node_run_id is null and consumed_at is null`,
        [workspaceId, runId],
      );
      if (prepared.rows.length > 0) {
        const scopes = new Set(
          closed.map(
            (node) =>
              `${node.nodeId}:${callbackScopeHash(node.iterationPath ?? [])}`,
          ),
        );
        const ids = prepared.rows
          .filter((task) =>
            scopes.has(`${task.callback_node_id}:${task.callback_scope_hash}`),
          )
          .map((task) => task.id);
        if (ids.length > 0)
          await client.query(
            `update app.pending_run_tasks set status=case when status='prepared' then 'canceled' else status end,completed_at=coalesce(completed_at,clock_timestamp()),consumed_at=clock_timestamp() where workspace_id=$1 and run_id=$2 and id=any($3::uuid[]) and node_run_id is null and consumed_at is null`,
            [workspaceId, runId, ids],
          );
      }
    }
  }
  await client.query(
    `update app.pending_run_tasks task set
    status=case when task.status='pending' then 'canceled' else task.status end,
    completed_at=coalesce(task.completed_at,clock_timestamp()),consumed_at=coalesce(task.consumed_at,clock_timestamp())
    from app.node_runs node where task.workspace_id=$1 and task.run_id=$2
      and node.workspace_id=task.workspace_id and node.id=task.node_run_id and node.workflow_run_id=task.run_id
      and node.status not in ('pending','ready','running','waiting') and task.consumed_at is null`,
    [workspaceId, runId],
  );
}
